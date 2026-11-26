import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LOOPBACK_HOST,
  LlamaServerError,
  buildLlamaServerArgs,
  createLlamaServer,
  reserveLoopbackPort,
  validateLlamaExecutablePath,
  validateLlamaModelPath,
  validateLoopbackHost,
} from '../../src/stable/runtime/llama-server.mjs';
import { createProviderClient } from '../../src/stable/gateway/provider-client.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'vibe', 'fixtures', 'fake-llama-server.mjs');
// A test host may symlink its Node binary (and macOS symlinks /var); the supervisor rejects a
// symlink anywhere in a validated path, so start from the resolved forms.
const NODE = realpathSync.native(process.execPath);
const TEMP_ROOT = realpathSync.native(tmpdir());
const MODEL_BYTES = Buffer.from('GGUF\u0000test-model\u0000');
const MESSAGES = [{ role: 'user', content: 'hello' }];
const TOOLS = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];

function tempDir(t) {
  const dir = mkdtempSync(path.join(TEMP_ROOT, 'vibe-llama-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeModel(t) {
  const dir = tempDir(t);
  const modelPath = path.join(dir, 'model-q4_k_m.gguf');
  writeFileSync(modelPath, MODEL_BYTES);
  return { dir, modelPath };
}

function makeServer(t, overrides = {}) {
  const { env: envOverrides = {}, ...rest } = overrides;
  const { dir, modelPath } = makeModel(t);
  const log = path.join(dir, 'argv.json');
  const server = createLlamaServer({
    executablePath: NODE,
    commandArgs: [FIXTURE],
    modelPath,
    env: { FAKE_LLAMA_LOG: log, ...envOverrides },
    startupTimeoutMs: 5000,
    healthIntervalMs: 20,
    stopTimeoutMs: 3000,
    ...rest,
  });
  t.after(async () => { await server.stop(); });
  return { server, dir, modelPath, log };
}

function readArgv(log) {
  return JSON.parse(readFileSync(log, 'utf8'));
}

function isCode(code) {
  return (error) => error instanceof LlamaServerError && error.code === code;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitGone(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processAlive(pid);
}

test('arguments pin the model, loopback host and port and append bounded options', (t) => {
  const { modelPath } = makeModel(t);
  const base = buildLlamaServerArgs({ modelPath, port: 8080 });
  assert.deepEqual([...base], ['--model', modelPath, '--host', LOOPBACK_HOST, '--port', '8080']);
  assert.ok(Object.isFrozen(base));
  const full = buildLlamaServerArgs({ modelPath, port: 8080, contextSize: 4096, threads: 8, gpuLayers: 0 });
  assert.deepEqual([...full], [
    '--model', modelPath, '--host', LOOPBACK_HOST, '--port', '8080',
    '--ctx-size', '4096', '--threads', '8', '--n-gpu-layers', '0',
  ]);
  for (const bad of [
    { modelPath, port: 1023 }, { modelPath, port: 65536 }, { modelPath, port: 0 },
    { modelPath, port: 8080, contextSize: 0 }, { modelPath, port: 8080, contextSize: 1_048_577 },
    { modelPath, port: 8080, threads: 0 }, { modelPath, port: 8080, threads: 257 },
    { modelPath, port: 8080, gpuLayers: -1 }, { modelPath, port: 8080, gpuLayers: 1001 },
    { modelPath, port: 8080, extra: true },
    { modelPath, port: '8080' },
  ]) {
    assert.throws(() => buildLlamaServerArgs(bad), (error) => error instanceof LlamaServerError);
  }
  const accessor = { modelPath, port: 8080 };
  Object.defineProperty(accessor, 'threads', {
    enumerable: true,
    get() { throw new Error('getter invoked'); },
  });
  assert.throws(() => buildLlamaServerArgs(accessor), isCode('invalid-options'));
  assert.equal(validateLoopbackHost(LOOPBACK_HOST), LOOPBACK_HOST);
  assert.throws(() => validateLoopbackHost('[8.8.8.8]'), isCode('invalid-host'));
  assert.throws(() => validateLoopbackHost('[::1]'), isCode('invalid-host'));
  assert.throws(() => validateLoopbackHost('localhost'), isCode('invalid-host'));
});

test('start waits for health, serves the B1 llama-cpp client and stop terminates', async (t) => {
  const { server, modelPath, log } = makeServer(t);
  assert.equal(server.status().state, 'stopped');
  const starting = server.start();
  assert.equal(server.status().state, 'starting');
  const running = await starting;
  assert.equal(running.state, 'running');
  assert.equal(running.port, server.status().port);
  assert.equal(running.baseUrl, 'http://' + LOOPBACK_HOST + ':' + running.port + '/v1');
  assert.ok(Number.isInteger(running.pid) && running.pid > 0);
  assert.deepEqual(await server.health(), { ok: true, status: 200 });
  const argv = readArgv(log);
  assert.deepEqual(argv.args.slice(0, 6), ['--model', modelPath, '--host', LOOPBACK_HOST, '--port', String(running.port)]);
  assert.equal(argv.args.length, 6);

  const client = createProviderClient('llama-cpp', { baseUrl: running.baseUrl, model: 'fake-gguf', env: {} });
  const chat = await client.chat({ messages: MESSAGES });
  assert.equal(chat.text, 'local answer');
  const streamed = await client.chat({ messages: MESSAGES, stream: true });
  assert.equal(streamed.text, 'local answer');
  const tooled = await client.chat({ messages: MESSAGES, tools: TOOLS });
  assert.equal(tooled.toolCalls.length, 1);
  assert.equal(tooled.toolCalls[0].name, 'lookup');
  assert.equal(tooled.toolCalls[0].arguments, '{"q":"x"}');
  const streamedTool = await client.chat({ messages: MESSAGES, tools: TOOLS, stream: true });
  assert.equal(streamedTool.toolCalls.length, 1);
  assert.equal(streamedTool.toolCalls[0].arguments, '{"q":"x"}');
  const embedded = await client.embeddings({ input: ['a'] });
  assert.deepEqual([...embedded.vectors[0]], [0.1, 0.2, 0.3]);

  const infill = await fetch(running.baseUrl.replace(/\/v1$/, '/infill'), { method: 'POST' });
  assert.equal(infill.status, 200);
  assert.equal((await infill.json()).content, 'filled');

  const again = await server.start();
  assert.equal(again.port, running.port);
  const fixturePid = readArgv(log).pid;
  assert.equal((await server.stop()).stopped, true);
  assert.equal(server.status().state, 'stopped');
  assert.equal(server.status().port, null);
  assert.equal(server.status().baseUrl, null);
  assert.equal((await server.stop()).stopped, true);
  assert.equal(server.status().pid, null);
  assert.equal(await waitGone(fixturePid), true, 'the child is gone after stop');
  assert.deepEqual(await server.health(), { ok: false, status: 0 });
});

test('commandArgs reach the child literally before the server flags', async (t) => {
  const { server, modelPath, log } = makeServer(t, { commandArgs: [FIXTURE, '--label', 'a;b && c'] });
  await server.start();
  const argv = readArgv(log);
  assert.deepEqual(argv.args.slice(0, 3), ['--label', 'a;b && c', '--model']);
  assert.equal(argv.args[3], modelPath);
  assert.equal(argv.args[4], '--host');
  assert.equal(argv.args[5], LOOPBACK_HOST);
});

test('a never-ready server fails as startup-timeout and is killed', async (t) => {
  const { server, log } = makeServer(t, { env: { FAKE_LLAMA_MODE: 'hang' }, startupTimeoutMs: 250, healthIntervalMs: 20 });
  await assert.rejects(server.start(), isCode('startup-timeout'));
  assert.equal(server.status().state, 'stopped');
  assert.equal(server.status().pid, null);
  assert.equal(server.status().port, null);
  assert.equal(await waitGone(readArgv(log).pid), true, 'a timed-out child is killed');
  assert.deepEqual(await server.health(), { ok: false, status: 0 });
});

test('stop during start prevents a spawn and leaves the runtime stopped', async (t) => {
  const { server, log } = makeServer(t);
  const starting = server.start();
  assert.equal(server.status().state, 'starting');
  const stopped = await server.stop();
  assert.equal(stopped.stopped, true);
  await assert.rejects(starting, (error) => error instanceof LlamaServerError
    && (error.code === 'start-aborted' || error.code === 'server-exited'));
  assert.equal(server.status().state, 'stopped');
  assert.equal(server.status().pid, null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(log), false, 'no child was spawned');
  assert.equal((await server.start()).state, 'running');
});

test('a start issued during a stop waits and comes up cleanly', async (t) => {
  const { server } = makeServer(t);
  const first = await server.start();
  const stopping = server.stop();
  const restarting = server.start();
  const stopped = await stopping;
  const second = await restarting;
  assert.equal(stopped.stopped, true);
  assert.equal(second.state, 'running');
  assert.ok(second.pid > 0);
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(await server.health(), { ok: true, status: 200 });
});

test('an unhealthy endpoint times out and an early exit is reported', async (t) => {
  const unhealthy = makeServer(t, { env: { FAKE_LLAMA_MODE: 'unhealthy' }, startupTimeoutMs: 300, healthIntervalMs: 20 });
  await assert.rejects(unhealthy.server.start(), isCode('startup-timeout'));
  const exiting = makeServer(t, { env: { FAKE_LLAMA_MODE: 'exit' }, startupTimeoutMs: 5000, healthIntervalMs: 20 });
  await assert.rejects(exiting.server.start(), isCode('server-exited'));
  assert.equal(exiting.server.status().state, 'stopped');
});

test('a failing health fetch prevents readiness and never throws', async (t) => {
  const { server } = makeServer(t, {
    fetch: async () => { throw new Error('network down'); },
    startupTimeoutMs: 250,
    healthIntervalMs: 20,
  });
  await assert.rejects(server.start(), isCode('startup-timeout'));
  assert.deepEqual(await server.health(), { ok: false, status: 0 });
});

test('a model deleted after creation fails closed at start without spawning', async (t) => {
  const { dir, modelPath } = makeModel(t);
  const log = path.join(dir, 'argv.json');
  const server = createLlamaServer({
    executablePath: NODE,
    commandArgs: [FIXTURE],
    modelPath,
    env: { FAKE_LLAMA_LOG: log },
    startupTimeoutMs: 5000,
    healthIntervalMs: 20,
    stopTimeoutMs: 3000,
  });
  t.after(async () => { await server.stop(); });
  rmSync(modelPath);
  await assert.rejects(server.start(), isCode('invalid-model-path'));
  assert.equal(server.status().state, 'stopped');
  assert.equal(server.status().port, null);
  assert.equal(existsSync(log), false, 'the path is re-validated before any spawn');
});

test('health reports a non-200 answer and a failed request while running', async (t) => {
  const { dir, modelPath } = makeModel(t);
  const log = path.join(dir, 'argv.json');
  let mode = 'ok';
  const server = createLlamaServer({
    executablePath: NODE,
    commandArgs: [FIXTURE],
    modelPath,
    env: { FAKE_LLAMA_LOG: log },
    startupTimeoutMs: 5000,
    healthIntervalMs: 20,
    stopTimeoutMs: 3000,
    fetch: async (url, init) => {
      if (String(url).endsWith('/health')) {
        if (mode === 'throw') throw new Error('network down');
        return new Response('{}', { status: mode === 'ok' ? 200 : 503 });
      }
      return fetch(url, init);
    },
  });
  t.after(async () => { await server.stop(); });
  await server.start();
  mode = 'loading';
  assert.deepEqual(await server.health(), { ok: false, status: 503 });
  mode = 'throw';
  assert.deepEqual(await server.health(), { ok: false, status: 0 });
});

test('a child that ignores SIGTERM is escalated to SIGKILL', {
  skip: process.platform === 'win32' ? 'Windows terminates the direct child on SIGTERM' : false,
}, async (t) => {
  const { server, log } = makeServer(t, {
    env: { FAKE_LLAMA_MODE: 'stubborn' },
    startupTimeoutMs: 5000,
    healthIntervalMs: 20,
    stopTimeoutMs: 200,
  });
  await server.start();
  const pid = readArgv(log).pid;
  const began = Date.now();
  await server.stop();
  assert.ok(Date.now() - began >= 195, 'the graceful-exit wait was honoured before escalation');
  assert.equal(await waitGone(pid), true, 'the stubborn child is gone after SIGKILL');
  assert.equal(server.status().state, 'stopped');
});

test('relative, missing, non-GGUF, symlinked and junction paths are rejected', (t) => {
  const { dir, modelPath } = makeModel(t);
  assert.throws(() => validateLlamaModelPath('model.gguf'), isCode('invalid-model-path'));
  assert.throws(() => validateLlamaModelPath(path.join(dir, 'missing.gguf')), isCode('invalid-model-path'));
  assert.throws(() => validateLlamaModelPath('../model.gguf'), isCode('invalid-model-path'));
  assert.throws(() => validateLlamaModelPath('\\\\server\\share\\model.gguf'), isCode('invalid-model-path'));
  assert.throws(() => validateLlamaModelPath(path.join(dir, '..', 'model.gguf')), isCode('invalid-model-path'));
  assert.throws(() => validateLlamaModelPath('C:model.gguf'), isCode('invalid-model-path'));
  assert.throws(() => validateLlamaModelPath('C:\\model.gguf'), isCode('invalid-model-path'));
  assert.throws(() => validateLlamaExecutablePath('C:tool.exe'), isCode('invalid-executable'));
  const text = path.join(dir, 'model.txt');
  writeFileSync(text, 'not a model');
  assert.throws(() => validateLlamaModelPath(text), isCode('invalid-model-path'));

  const link = path.join(dir, 'link.gguf');
  try {
    symlinkSync(modelPath, link, 'file');
    assert.throws(() => validateLlamaModelPath(link), isCode('invalid-model-path'));
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EINVAL' && error.code !== 'EEXIST') throw error;
  }

  const real = path.join(dir, 'real');
  mkdirSync(real);
  writeFileSync(path.join(real, 'model.gguf'), MODEL_BYTES);
  const junction = path.join(dir, 'junction');
  let junctionSupported = true;
  try {
    symlinkSync(real, junction, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) junctionSupported = false;
    else throw error;
  }
  if (junctionSupported) {
    assert.throws(() => validateLlamaModelPath(path.join(junction, 'model.gguf')), isCode('invalid-model-path'));
  }

  assert.throws(() => validateLlamaExecutablePath('node.exe'), isCode('invalid-executable'));
  assert.throws(() => validateLlamaExecutablePath(path.join(dir, 'missing.exe')), isCode('invalid-executable'));
  const exe = path.join(dir, 'tool.txt');
  writeFileSync(exe, 'not an executable');
  assert.throws(() => validateLlamaExecutablePath(exe), isCode('invalid-executable'));
  const empty = path.join(dir, 'empty.gguf');
  writeFileSync(empty, '');
  assert.throws(() => validateLlamaModelPath(empty), isCode('invalid-model-path'));
});

test('options fail closed without spawning', (t) => {
  const { modelPath } = makeModel(t);
  const valid = { executablePath: NODE, commandArgs: [FIXTURE], modelPath };
  for (const overrides of [
    { port: 0 }, { port: 1023 }, { contextSize: 0 }, { threads: 0 }, { gpuLayers: -1 },
    { startupTimeoutMs: 0 }, { healthIntervalMs: 0 }, { stopTimeoutMs: 0 }, { unknown: true },
    { commandArgs: 'nope' }, { env: [] }, { fetch: 'nope' },
    { commandArgs: ['--host', '[8.8.8.8]'] }, { commandArgs: ['--port=1'] },
    { commandArgs: ['--host=[8.8.8.8]'] },
    { commandArgs: Array(17).fill('x') },
    { commandArgs: ['x'.repeat(1025)] },
    { startupTimeoutMs: 120001 }, { healthIntervalMs: 10001 }, { stopTimeoutMs: 30001 },
    { env: Object.fromEntries(Array.from({ length: 33 }, (_, index) => ['K' + index, 'v'])) },
    { env: { NODE_OPTIONS: '--require ./evil.cjs' } },
    { env: { LD_PRELOAD: '/tmp/evil.so' } },
    { env: { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' } },
    { env: { SystemRoot: 'C:\\evil' } },
    { env: { SYSTEMROOT: 'C:\\evil' } },
    { env: { systemroot: 'C:\\evil' } },
    { env: { node_options: '--require ./evil.cjs' } },
    { env: { LD_AUDIT: '/tmp/evil.so' } },
    { env: { DYLD_FALLBACK_LIBRARY_PATH: '/tmp/evil' } },
    { env: { LLAMA_ARG_HOST: 'x' } },
    { env: { GGML_BACKEND_PATH: '/tmp/evil.so' } },
    { env: { ['__PROTO__']: 'x' } },
    { env: { ['K'.repeat(65)]: 'v' } },
    { env: Object.fromEntries(Array.from({ length: 9 }, (_, index) => ['K' + index, 'x'.repeat(4096)])) },
    { commandArgs: ['--reuse-port'] },
    { commandArgs: ['--Reuse-Port'] },
    { commandArgs: ['--agent'] },
    { commandArgs: ['-ag'] },
    { commandArgs: ['--ui-agent'] },
    { commandArgs: ['--ui-mcp-proxy'] },
    { commandArgs: ['--tools'] },
    { commandArgs: ['--MCP-servers', 'x'] },
    { env: { 'BAD-KEY': 'x' } },
  ]) {
    assert.throws(() => createLlamaServer({ ...valid, ...overrides }), (error) => error instanceof LlamaServerError);
  }
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'modelPath', {
    enumerable: true,
    get() { throw new Error('getter invoked'); },
  });
  assert.throws(() => createLlamaServer(accessor), isCode('invalid-options'));

  const reservedEnv = {};
  Object.defineProperty(reservedEnv, 'constructor', { value: 'x', enumerable: true });
  assert.throws(() => createLlamaServer({ ...valid, env: reservedEnv }), isCode('invalid-env'));

  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.throws(() => createLlamaServer(revocable.proxy), isCode('invalid-options'));

  const boomArgs = new Proxy([], {
    get(target, property) {
      if (property === 'length') throw new Error('boom');
      return target[property];
    },
  });
  assert.throws(() => createLlamaServer({ ...valid, commandArgs: boomArgs }), isCode('invalid-command-args'));

  const args = ['--label'];
  Object.defineProperty(args, '0', { enumerable: true, get() { throw new Error('getter invoked'); } });
  assert.throws(() => createLlamaServer({ ...valid, commandArgs: args }), isCode('invalid-command-args'));

  const marker = 'TOPSECRETMARKER';
  try {
    createLlamaServer({ ...valid, commandArgs: [marker + '\n'] });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.equal(error.code, 'invalid-command-args');
    assert.ok(!error.message.includes(marker));
  }
});

test('the child environment is an allowlist plus caller overrides', async (t) => {
  const previousSecret = process.env.VIBECODIUM_TEST_SECRET;
  const previousLeak = process.env.VIBECODIUM_TEST_LEAK;
  process.env.VIBECODIUM_TEST_SECRET = 'process-secret';
  process.env.VIBECODIUM_TEST_LEAK = 'leak-value';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.VIBECODIUM_TEST_SECRET;
    else process.env.VIBECODIUM_TEST_SECRET = previousSecret;
    if (previousLeak === undefined) delete process.env.VIBECODIUM_TEST_LEAK;
    else process.env.VIBECODIUM_TEST_LEAK = previousLeak;
  });
  const { server, log } = makeServer(t, { env: { VIBECODIUM_TEST_SECRET: 'override-secret', PATH: '/custom/bin' } });
  await server.start();
  const argv = readArgv(log);
  assert.equal(argv.env.VIBECODIUM_TEST_SECRET, 'override-secret');
  assert.equal(argv.env.PATH, '/custom/bin');
  const copiedKeys = process.platform === 'win32' ? ['SystemRoot', 'TEMP', 'TMP'] : ['TMPDIR', 'LANG', 'LC_ALL'];
  for (const copiedKey of copiedKeys) {
    if (typeof process.env[copiedKey] === 'string') {
      assert.equal(argv.env[copiedKey], process.env[copiedKey], 'the platform allowlist key reaches the child');
    }
  }
  assert.equal(argv.env.HAS_LEAK, 'absent', 'the parent leak variable never reaches the child');
  assert.equal(readFileSync(log + '.leak', 'utf8'), '');
  for (const value of [server.status(), server.config]) {
    assert.ok(!JSON.stringify(value).includes('override-secret'));
    assert.ok(!JSON.stringify(value).includes('process-secret'));
  }
});

test('the parent PATH is not inherited without an explicit override', async (t) => {
  const { server, log } = makeServer(t);
  await server.start();
  assert.equal(readArgv(log).env.PATH, '');
});

test('the retained child output tail is never exposed through the controller', async (t) => {
  const { server } = makeServer(t);
  const running = await server.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const marker = ['vibe', 'codium', 'output', 'tail', 'marker'].join('-');
  const exposed = JSON.stringify({
    running,
    status: server.status(),
    describe: server.describe(),
    config: server.config,
    controller: server,
  });
  assert.ok(exposed.includes('"state":"running"'));
  assert.ok(!exposed.includes(marker));
});

test('the controller, its status and reserved ports are bounded and immutable', async (t) => {
  const { server } = makeServer(t);
  assert.ok(Object.isFrozen(server));
  const status = server.status();
  assert.ok(Object.isFrozen(status));
  assert.throws(() => { status.state = 'running'; }, TypeError);
  assert.throws(() => { server.start = () => {}; }, TypeError);
  const port = await reserveLoopbackPort();
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  assert.equal(server.status().port, null);
});
