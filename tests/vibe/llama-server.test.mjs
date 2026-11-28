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
  MAX_API_KEY_CHARS,
  MIN_API_KEY_CHARS,
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
  assert.deepEqual([...base], [
    '--model', modelPath, '--host', LOOPBACK_HOST, '--port', '8080',
    '--no-webui', '--cors-origins', 'localhost',
  ]);
  assert.ok(Object.isFrozen(base));
  const full = buildLlamaServerArgs({ modelPath, port: 8080, contextSize: 4096, threads: 8, gpuLayers: 0 });
  assert.deepEqual([...full], [
    '--model', modelPath, '--host', LOOPBACK_HOST, '--port', '8080',
    '--no-webui', '--cors-origins', 'localhost',
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
  assert.deepEqual(argv.args.slice(6, 9), ['--no-webui', '--cors-origins', 'localhost']);
  assert.equal(argv.args.length, 9);
  assert.equal(argv.env.HAS_API_KEY, 'present');
  assert.ok(!argv.args.some((arg) => arg.includes(server.auth().apiKey)), 'the key is not in the argument list');

  const auth = server.auth();
  assert.equal(Object.isFrozen(auth), true);
  assert.match(auth.apiKey, /^[A-Za-z0-9_-]{32,128}$/);
  for (const snapshot of [server.status(), server.describe(), server.config]) {
    assert.ok(!JSON.stringify(snapshot).includes(auth.apiKey), 'the key is not in a snapshot');
  }
  const denied = await fetch(running.baseUrl.replace(/\/v1$/, '/props'));
  assert.equal(denied.status, 401);
  const allowed = await fetch(running.baseUrl.replace(/\/v1$/, '/props'), {
    headers: { authorization: 'Bearer ' + auth.apiKey },
  });
  assert.equal(allowed.status, 200);

  const client = createProviderClient('llama-cpp', {
    baseUrl: running.baseUrl, model: 'fake-gguf', apiKey: auth.apiKey, env: {},
  });
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

  const infillDenied = await fetch(running.baseUrl.replace(/\/v1$/, '/infill'), { method: 'POST' });
  assert.equal(infillDenied.status, 401);
  const infill = await fetch(running.baseUrl.replace(/\/v1$/, '/infill'), {
    method: 'POST',
    headers: { authorization: 'Bearer ' + auth.apiKey },
  });
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

test('a caller-supplied apiKey is validated and used on every request', async (t) => {
  const key = 'caller-key-' + 'k'.repeat(33);
  const { server, log } = makeServer(t, { apiKey: key });
  assert.equal(server.auth().apiKey, key);
  const running = await server.start();
  assert.equal(running.state, 'running');
  const argv = readArgv(log);
  assert.equal(argv.env.HAS_API_KEY, 'present');
  assert.ok(!argv.args.includes(key), 'the key is not passed as an argument');
  const client = createProviderClient('llama-cpp', {
    baseUrl: running.baseUrl, model: 'fake-gguf', apiKey: key, env: {},
  });
  assert.equal((await client.chat({ messages: MESSAGES })).text, 'local answer');
  assert.equal((await server.health()).ok, true, 'health speaks the same key');
  assert.equal(server.auth().apiKey, key, 'the key is unchanged after start');
  await server.stop();
  assert.equal(server.auth().apiKey, key, 'the key survives a stop');
});

test('an unusable apiKey fails closed without echoing the value', (t) => {
  const { modelPath } = makeModel(t);
  const base = { executablePath: NODE, commandArgs: [FIXTURE], modelPath };
  const marker = 'Q'.repeat(30);
  for (const apiKey of [
    'short', 'k'.repeat(129), marker + ',', marker + ' ', marker + '\n', marker + '\u0007',
    marker + '\u202E', marker + '"', marker + '\\', 42, null,
  ]) {
    try {
      createLlamaServer({ ...base, apiKey });
      assert.fail('expected a rejection');
    } catch (error) {
      assert.equal(error.code, 'invalid-api-key');
      if (typeof apiKey === 'string' && apiKey.includes(marker)) {
        assert.ok(!error.message.includes(marker), 'the rejected key is never echoed');
      }
    }
  }
  const accessor = { ...base };
  Object.defineProperty(accessor, 'apiKey', {
    enumerable: true,
    get() { throw new Error('getter invoked'); },
  });
  assert.throws(() => createLlamaServer(accessor), isCode('invalid-options'));
});

test('an apiKey of valid length is still rejected for an unsafe character, without echoing it', (t) => {
  const { modelPath } = makeModel(t);
  const base = { executablePath: NODE, commandArgs: [FIXTURE], modelPath };
  // Keep the sample inside the 32-128 window so the length check cannot mask the character check.
  const atLength = (suffix) => 'a'.repeat(40 - suffix.length) + suffix;
  for (const suffix of [',', ' ', '\n', '\u0007', '\u007f', '\u202E', '\u00e9', '"', '\\']) {
    const apiKey = atLength(suffix);
    assert.ok(
      apiKey.length >= MIN_API_KEY_CHARS && apiKey.length <= MAX_API_KEY_CHARS,
      'the sample is inside the length window',
    );
    try {
      createLlamaServer({ ...base, apiKey });
      assert.fail('expected a rejection for ' + JSON.stringify(apiKey));
    } catch (error) {
      assert.equal(error.code, 'invalid-api-key');
      assert.ok(!error.message.includes(apiKey), 'the rejected key is never echoed');
    }
  }
});

test('an apiKey at either length bound is accepted and each controller generates its own key', (t) => {
  const { modelPath } = makeModel(t);
  const base = { executablePath: NODE, commandArgs: [FIXTURE], modelPath };
  for (const apiKey of ['k'.repeat(MIN_API_KEY_CHARS), 'k'.repeat(MAX_API_KEY_CHARS)]) {
    assert.equal(createLlamaServer({ ...base, apiKey }).auth().apiKey, apiKey);
  }
  const first = createLlamaServer(base).auth().apiKey;
  const second = createLlamaServer(base).auth().apiKey;
  assert.match(first, /^[A-Za-z0-9_-]{43}$/, 'the generated key is 32 random bytes in base64url');
  assert.notEqual(first, second, 'each controller generates its own key');
});

test('a 403 from the authenticated probe is a foreign listener and the child is reaped', async (t) => {
  let logPath = null;
  const { server, log } = makeServer(t, {
    fetch: async (url) => {
      const deadlineAt = Date.now() + 3000;
      while (logPath !== null && !existsSync(logPath) && Date.now() < deadlineAt) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (String(url).endsWith('/health')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 403 });
    },
    startupTimeoutMs: 5000,
    healthIntervalMs: 20,
  });
  logPath = log;
  const key = server.auth().apiKey;
  let caught = null;
  try {
    await server.start();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof LlamaServerError && caught.code === 'readiness-mismatch');
  assert.ok(!caught.message.includes(key), 'the readiness error never echoes the key');
  assert.equal(server.status().state, 'stopped');
  assert.equal(server.status().pid, null);
  assert.equal(server.status().port, null);
  assert.equal(await waitGone(readArgv(log).pid), true, 'a 403 listener is treated as foreign and the child is killed');
});

test('a listener that rejects the generated key fails readiness and is reaped', async (t) => {
  const seen = [];
  // The child boots asynchronously; answer only once it has written its argv log, so the pid is
  // known and the "reaped" assertion is meaningful.
  let logPath = null;
  const { server, log } = makeServer(t, {
    fetch: async (url, init) => {
      const deadlineAt = Date.now() + 3000;
      while (logPath !== null && !existsSync(logPath) && Date.now() < deadlineAt) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const target = String(url);
      const headers = new Headers(init?.headers ?? {});
      seen.push({ path: new URL(target).pathname, authorization: headers.get('authorization') });
      if (target.endsWith('/health')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 401 });
    },
    startupTimeoutMs: 5000,
    healthIntervalMs: 20,
  });
  logPath = log;
  const key = server.auth().apiKey;
  await assert.rejects(server.start(), isCode('readiness-mismatch'));
  assert.equal(server.status().state, 'stopped');
  assert.equal(server.status().pid, null);
  assert.equal(server.status().port, null);
  assert.ok(
    seen.some((entry) => entry.path === '/props' && entry.authorization === 'Bearer ' + key),
    'the readiness probe authenticates itself',
  );
  assert.equal(await waitGone(readArgv(log).pid), true, 'a server that rejects the key is killed');
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
      const target = String(url);
      if (target.endsWith('/health')) return new Response('{}', { status: 200 });
      if (target.endsWith('/props')) {
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
    { commandArgs: ['--port', '1'] },
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
    // The same `llama_arg_` prefix covers the pin's router-mode loader names; asserted explicitly
    // so the two flags below cannot be reintroduced through the environment.
    { env: { LLAMA_ARG_MODELS_DIR: 'C:\\models' } },
    { env: { llama_arg_models_dir: 'C:\\models' } },
    { env: { LLAMA_ARG_MODELS_PRESET: 'presets.ini' } },
    { env: { Llama_Arg_Models_Preset: 'presets.ini' } },
    { env: { GGML_BACKEND_PATH: '/tmp/evil.so' } },
    { env: { ['__PROTO__']: 'x' } },
    { env: { ['K'.repeat(65)]: 'v' } },
    { env: Object.fromEntries(Array.from({ length: 9 }, (_, index) => ['K' + index, 'x'.repeat(4096)])) },
    { commandArgs: ['--reuse-port'] },
    { commandArgs: ['--Reuse-Port'] },
    { commandArgs: ['--agent'] },
    { commandArgs: ['-ag'] },
    { commandArgs: ['--ui-agent'] },
    { commandArgs: ['--ui_mcp_proxy'] },
    { commandArgs: ['--ui-mcp-proxy'] },
    { commandArgs: ['--tools'] },
    { commandArgs: ['--MCP-servers', 'x'] },
    { commandArgs: ['--mcp_servers', 'x'] },
    { commandArgs: ['-mu', 'https://example.invalid/model.gguf'] },
    { commandArgs: ['--model-url', 'https://example.invalid/model.gguf'] },
    { commandArgs: ['--model-url=https://example.invalid/model.gguf'] },
    { commandArgs: ['-hf', 'owner/repo'] },
    { commandArgs: ['--hf-repo', 'owner/repo'] },
    { commandArgs: ['--hf_repo', 'owner/repo'] },
    // Every short alias the pinned b12426 source registers for the Hugging Face switches: `-hfr`
    // is a second spelling of `--hf-repo` beside `-hf`, and `-hff`/`-hft` are the file and token
    // switches. Without these, a remote GGUF could be downloaded past the remote-model refusal.
    { commandArgs: ['-hfr', 'owner/repo'] },
    { commandArgs: ['-HFR', 'owner/repo'] },
    { commandArgs: ['-hff', 'model.gguf'] },
    { commandArgs: ['-hft', 'token'] },
    { commandArgs: ['--hf-file', 'model.gguf'] },
    { commandArgs: ['--hf_file', 'model.gguf'] },
    { commandArgs: ['--hf-file=model.gguf'] },
    { commandArgs: ['--hf-token=token'] },
    { commandArgs: ['--hf_token', 'token'] },
    // The draft model and the projector are separate remote sources at the same pin. b12426
    // registers `--spec-draft-hf` with the short aliases `-hfd` and `-hfrd` (plus
    // `--hf-repo-draft`) for a remote draft GGUF, and `--mmproj-url`/`-mmu` for a remote projector.
    { commandArgs: ['--spec-draft-hf', 'owner/repo'] },
    { commandArgs: ['--spec_draft_hf', 'owner/repo'] },
    { commandArgs: ['--spec-draft-hf=owner/repo'] },
    { commandArgs: ['-hfd', 'model.gguf'] },
    { commandArgs: ['-HFd', 'model.gguf'] },
    { commandArgs: ['-hfrd', 'owner/repo'] },
    { commandArgs: ['--hf-repo-draft', 'owner/repo'] },
    { commandArgs: ['--mmproj-url', 'https://example.invalid/mmproj.gguf'] },
    { commandArgs: ['--mmproj_url', 'https://example.invalid/mmproj.gguf'] },
    { commandArgs: ['--mmproj-url=https://example.invalid/mmproj.gguf'] },
    { commandArgs: ['-mmu', 'https://example.invalid/mmproj.gguf'] },
    { commandArgs: ['-MMU', 'https://example.invalid/mmproj.gguf'] },
    // Value-less presets at the same pin also write a remote model (and, for the two `-spec`
    // presets, a remote draft); the server then downloads it and replaces the validated local path.
    // b12426 registers exactly these eleven writers of `params.model.hf_repo` outside the hf flags.
    { commandArgs: ['--embd-gemma-default'] },
    { commandArgs: ['--fim-qwen-1.5b-default'] },
    { commandArgs: ['--fim-qwen-3b-default'] },
    { commandArgs: ['--fim-qwen-7b-default'] },
    { commandArgs: ['--fim-qwen-30b-default'] },
    { commandArgs: ['--fim-qwen-7b-spec'] },
    { commandArgs: ['--fim-qwen-14b-spec'] },
    { commandArgs: ['--gpt-oss-20b-default'] },
    { commandArgs: ['--gpt-oss-120b-default'] },
    { commandArgs: ['--vision-gemma-4b-default'] },
    { commandArgs: ['--vision-gemma-12b-default'] },
    { commandArgs: ['--gpt_oss_20b_default'] },
    { commandArgs: ['--EMBD-GEMMA-DEFAULT'] },
    { commandArgs: ['-dr', 'owner/repo'] },
    { commandArgs: ['--docker-repo', 'owner/repo'] },
    { commandArgs: ['--connect', 'peer.invalid:50052'] },
    { commandArgs: ['--connect=peer.invalid:50052'] },
    // The pinned b12426 build's router-mode model catalog flags. `--models-dir` turns every model
    // file under a caller-chosen directory into a model preset (tools/server/server-models.cpp) and
    // `--models-preset` loads a caller-chosen INI whose sections may set `hf-repo`, because
    // common/preset.cpp accepts every option key the program registers. The supervisor always
    // appends `--model`, so the pin starts as an instance and both flags are inert today; refusing
    // them keeps the single-model posture from opening if that ever stops being true. Neither has a
    // short alias at the pin, and `-md` stays the local `--spec-draft-model`.
    { commandArgs: ['--models-dir', 'C:\\models'] },
    { commandArgs: ['--models-dir=C:\\models'] },
    { commandArgs: ['--models_dir', 'C:\\models'] },
    { commandArgs: ['--MODELS-DIR', 'C:\\models'] },
    { commandArgs: ['--models-preset', 'presets.ini'] },
    { commandArgs: ['--models-preset=presets.ini'] },
    { commandArgs: ['--models_preset', 'presets.ini'] },
    { commandArgs: ['--MODELS-PRESET', 'presets.ini'] },
    // The whole `--models-` family is refused, so a later pin that adds another router loader
    // cannot slip in through the naming convention; the two tuning flags are only meaningful in
    // router mode, which the appended `--model` never allows here.
    { commandArgs: ['--models-max', '2'] },
    { commandArgs: ['--models-autoload'] },
    { commandArgs: ['--models-memory-margin', '1024'] },
    { commandArgs: ['--api-key', 'x'] },
    { commandArgs: ['--api_key', 'x'] },
    { commandArgs: ['--api-key=secret'] },
    { commandArgs: ['--api_key=secret'] },
    { commandArgs: ['--API-KEY', 'x'] },
    { commandArgs: ['--api-key-file', 'x'] },
    { commandArgs: ['--api_key_file', 'x'] },
    { commandArgs: ['--api_key_file=x'] },
    { commandArgs: ['--model', 'x'] },
    { commandArgs: ['--model=x'] },
    { commandArgs: ['-m', 'x'] },
    { commandArgs: ['--no-webui'] },
    { commandArgs: ['--no_webui'] },
    { commandArgs: ['--no-webui=true'] },
    { commandArgs: ['--no_webui=true'] },
    { commandArgs: ['--webui'] },
    { commandArgs: ['--webui=true'] },
    { commandArgs: ['--ui'] },
    { commandArgs: ['--ui=true'] },
    { commandArgs: ['--no-ui'] },
    { commandArgs: ['--no_ui'] },
    { commandArgs: ['--no-ui=true'] },
    { commandArgs: ['--no_ui=true'] },
    { commandArgs: ['--cors-origins', 'localhost'] },
    { commandArgs: ['--cors_origins', 'localhost'] },
    { commandArgs: ['--cors-origins=*'] },
    { commandArgs: ['--cors_origins=*'] },
    { commandArgs: ['--cors-methods', 'GET'] },
    { commandArgs: ['--cors_methods', 'GET'] },
    { commandArgs: ['--cors-methods=GET'] },
    { commandArgs: ['--cors_methods=GET'] },
    { commandArgs: ['--cors-headers', 'x'] },
    { commandArgs: ['--cors_headers', 'x'] },
    { commandArgs: ['--cors-headers=Authorization'] },
    { commandArgs: ['--cors_headers=Authorization'] },
    { commandArgs: ['--cors-credentials'] },
    { commandArgs: ['--cors_credentials'] },
    { commandArgs: ['--cors-credentials=true'] },
    { commandArgs: ['--cors_credentials=true'] },
    { commandArgs: ['--no-cors-credentials'] },
    { commandArgs: ['--no_cors_credentials'] },
    { commandArgs: ['--no-cors-credentials=true'] },
    { commandArgs: ['--no_cors_credentials=true'] },
    { commandArgs: ['--allow-unauthenticated-tools'] },
    { commandArgs: ['--allow_unauthenticated_tools'] },
    { commandArgs: ['--allow-unauthenticated-tools=true'] },
    { commandArgs: ['--allow_unauthenticated_tools=true'] },
    { commandArgs: ['--host=0.0.0.0'] },
    { commandArgs: ['--cors_origins', '*', '--cors-credentials'] },
    { env: { LLAMA_API_KEY: 'x' } },
    { env: { llama_api_key: 'x' } },
    { env: { Llama_Api_Key: 'x' } },
    // The pinned build resolves its own config files from these profile roots before argv, and a
    // config file can set a remote model or projector source past every argument denial above.
    { env: { APPDATA: 'C:\\Users\\probe\\AppData\\Roaming' } },
    { env: { appdata: 'C:\\Users\\probe\\AppData\\Roaming' } },
    { env: { APPDATA: '' } },
    { env: { PROGRAMDATA: 'C:\\ProgramData' } },
    { env: { programdata: 'C:\\ProgramData' } },
    { env: { XDG_CONFIG_HOME: '/home/probe/.config' } },
    { env: { xdg_config_home: '/home/probe/.config' } },
    { env: { HOME: '/home/probe' } },
    { env: { home: '/home/probe' } },
  ]) {
    assert.throws(() => createLlamaServer({ ...valid, ...overrides }), (error) => error instanceof LlamaServerError);
  }
  // The `llama_arg_` prefix is the only rule that refuses the pin's router-mode loader names through
  // the environment, so assert the env refusal and its non-echoing directly instead of relying on
  // the generic loop above.
  for (const env of [
    { LLAMA_ARG_MODELS_DIR: 'ENVDIRMARKER' },
    { llama_arg_models_dir: 'ENVDIRMARKER' },
    { LLAMA_ARG_MODELS_PRESET: 'ENVINIMARKER' },
    { Llama_Arg_Models_Preset: 'ENVINIMARKER' },
  ]) {
    try {
      createLlamaServer({ ...valid, env });
      assert.fail('expected a rejection');
    } catch (error) {
      assert.equal(error.code, 'invalid-env');
      assert.ok(!error.message.includes('ENVDIRMARKER'));
      assert.ok(!error.message.includes('ENVINIMARKER'));
    }
  }
  // A non-reserved flag is still accepted in either spelling: underscore normalisation only widens
  // the refusal, it must not refuse legitimate flags such as `--chat_template`.
  for (const commandArgs of [
    ['--chat_template', 'x'], ['--chat-template', 'x'], ['--lora_init', 'x'], ['--keep', '8'],
    // The local-model refusal must not widen to the numeric and sampling flags a caller legitimately
    // tunes, including the batch flags the embedding plan relies on.
    ['-b', '8192'], ['-ub', '8192'], ['-t', '4'], ['-c', '4096'], ['-ngl', '0'],
    // Denying remote draft/projector sources must not refuse the local draft path or the draft
    // tuning flags (only the remote download spellings are refused), and the ngram-only
    // `--spec-default` preset is not a remote source, so it stays accepted.
    ['-md', 'draft.gguf'], ['--spec-draft-threads', '4'], ['--spec-draft-ngl', '0'],
    ['--spec-default'],
    // The router-mode refusal above must not catch the local draft's other pin spellings either:
    // b12426 registers `--model-draft` and `-md` on `--spec-draft-model`, and those load a local file.
    ['--spec-draft-model', 'draft.gguf'], ['--model-draft', 'draft.gguf'],
    ['--model_draft', 'draft.gguf'],
  ]) {
    assert.doesNotThrow(() => createLlamaServer({ ...valid, commandArgs }));
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

  // Every router-mode loader spelling named in the task card is refused with the same bounded code,
  // and the message names the router-mode reason rather than the reserved-model one, so the
  // correction cannot regress silently. A caller's directory or INI name is never echoed.
  for (const commandArgs of [
    ['--models-dir', 'DIRMARKER'], ['--models-dir=DIRMARKER'], ['--models_dir', 'DIRMARKER'],
    ['--MODELS-DIR', 'DIRMARKER'],
    ['--models-preset', 'INIMARKER.ini'], ['--models-preset=INIMARKER.ini'],
    ['--models_preset', 'INIMARKER.ini'], ['--MODELS-PRESET', 'INIMARKER.ini'],
    ['--models-max', '2'], ['--models-memory-margin', '1024'], ['--models-autoload'],
  ]) {
    try {
      createLlamaServer({ ...valid, commandArgs });
      assert.fail('expected a rejection');
    } catch (error) {
      assert.equal(error.code, 'invalid-command-args');
      assert.match(error.message, /router-mode model catalogs/u);
      assert.ok(!error.message.includes('DIRMARKER'));
      assert.ok(!error.message.includes('INIMARKER'));
    }
  }

  // The reserved model flag keeps its own reason and still refuses the bare and `=` spellings, so
  // narrowing the prefix did not turn `--model` into a trusted argument.
  for (const commandArgs of [['--model', 'MODELMARKER.gguf'], ['--model=MODELMARKER.gguf'], ['--MODEL=MODELMARKER.gguf']]) {
    try {
      createLlamaServer({ ...valid, commandArgs });
      assert.fail('expected a rejection');
    } catch (error) {
      assert.equal(error.code, 'invalid-command-args');
      assert.match(error.message, /bind host, port, model/u);
      assert.ok(!error.message.includes('MODELMARKER'));
    }
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
  // `b12426` applies a user- or machine-level `config.ini` from these roots before argv, so they must
  // never reach the child; the parent process does have them on Windows. The fixture logs every key it
  // actually received, so an absent key is proof rather than a name the fixture never printed.
  const childEnvKeys = argv.envKeys.map((name) => name.toLowerCase());
  for (const profileKey of ['APPDATA', 'PROGRAMDATA', 'XDG_CONFIG_HOME', 'HOME']) {
    assert.ok(
      !childEnvKeys.includes(profileKey.toLowerCase()),
      profileKey + ' never reaches the child',
    );
  }
  if (process.platform === 'win32') {
    assert.equal(typeof process.env.APPDATA, 'string', 'the parent has a profile root to leak');
    assert.notEqual(process.env.APPDATA, '', 'the parent profile root is populated');
  }
  for (const value of [server.status(), server.config]) {
    assert.ok(!JSON.stringify(value).includes('override-secret'));
    assert.ok(!JSON.stringify(value).includes('process-secret'));
  }
});

test('an env override cannot reintroduce the pinned build profile config roots', (t) => {
  const { modelPath } = makeModel(t);
  const valid = { executablePath: NODE, modelPath };
  const marker = 'PROFILEMARKER';
  for (const name of ['APPDATA', 'ProgramData', 'XDG_CONFIG_HOME', 'Home']) {
    assert.throws(
      () => createLlamaServer({ ...valid, env: { [name]: marker } }),
      (error) => error instanceof LlamaServerError
        && error.code === 'invalid-env'
        && !error.message.includes(marker),
      name + ' is refused and its value is never echoed',
    );
  }
  // An ordinary override is still trusted; only the profile config roots are refused.
  assert.doesNotThrow(() => createLlamaServer({ ...valid, env: { VIBE_PROBE: marker } }));
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

function startsCount(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0).length;
}

function startsTimes(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0)
    .map((line) => Number.parseInt(line.split(':')[0], 10));
}

async function waitForState(server, wanted, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.status().state === wanted) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return server.status().state === wanted;
}

function makeCrashServer(t, { mode = 'crash-once', crashMs = 150, restart, env: extraEnv = {} } = {}) {
  const { dir, modelPath } = makeModel(t);
  const log = path.join(dir, 'argv.json');
  const starts = path.join(dir, 'starts.txt');
  const options = {
    executablePath: NODE,
    commandArgs: [FIXTURE],
    modelPath,
    env: {
      FAKE_LLAMA_LOG: log,
      FAKE_LLAMA_STARTS: starts,
      FAKE_LLAMA_MODE: mode,
      FAKE_LLAMA_CRASH_MS: String(crashMs),
      ...extraEnv,
    },
    startupTimeoutMs: 5000,
    healthIntervalMs: 20,
    stopTimeoutMs: 3000,
  };
  if (restart !== undefined) options.restart = restart;
  const server = createLlamaServer(options);
  t.after(async () => { await server.stop(); });
  return { server, dir, log, starts };
}

test('the restart policy fails closed without spawning', (t) => {
  const { dir, modelPath } = makeModel(t);
  const log = path.join(dir, 'argv.json');
  const valid = { executablePath: NODE, commandArgs: [FIXTURE], modelPath, env: { FAKE_LLAMA_LOG: log } };
  for (const restart of [
    null, [], 'on', {}, { maxRestarts: 0 }, { maxRestarts: 11 }, { maxRestarts: 1.5 },
    { maxRestarts: 1, baseDelayMs: 49 }, { maxRestarts: 1, baseDelayMs: 300_001 },
    { maxRestarts: 1, baseDelayMs: 500, maxDelayMs: 400 },
    { maxRestarts: 1, baseDelayMs: 500, maxDelayMs: 400_000 },
    { maxRestarts: 1, maxDelayMs: 0 },
    { maxRestarts: 1, stableMs: 1.5 },
    { maxRestarts: 1, stableMs: 500 },
    { maxRestarts: 1, baseDelayMs: 500, stableMs: -1 },
    { maxRestarts: 1, baseDelayMs: 500, stableMs: 600_001 },
    { maxRestarts: 1, baseDelayMs: 500, unknown: true },
  ]) {
    assert.throws(
      () => createLlamaServer({ ...valid, restart }),
      isCode('invalid-restart-policy'),
      'accepted a bad policy: ' + JSON.stringify(restart),
    );
  }
  const accessor = { maxRestarts: 2, baseDelayMs: 100 };
  Object.defineProperty(accessor, 'maxDelayMs', { enumerable: true, get() { throw new Error('getter invoked'); } });
  assert.throws(() => createLlamaServer({ ...valid, restart: accessor }), isCode('invalid-restart-policy'));
  const revoked = Proxy.revocable({ maxRestarts: 1 }, {});
  revoked.revoke();
  assert.throws(() => createLlamaServer({ ...valid, restart: revoked.proxy }), isCode('invalid-restart-policy'));
  const hostile = new Proxy({ maxRestarts: 1 }, {
    ownKeys() { throw new Error('ownKeys trap invoked'); },
  });
  assert.throws(() => createLlamaServer({ ...valid, restart: hostile }), isCode('invalid-restart-policy'));
  const descriptorHostile = new Proxy({ maxRestarts: 1 }, {
    getOwnPropertyDescriptor() { throw new Error('descriptor trap invoked'); },
  });
  assert.throws(
    () => createLlamaServer({ ...valid, restart: descriptorHostile }),
    isCode('invalid-restart-policy'),
  );
  const reserved = JSON.parse('{"__proto__": {"maxRestarts": 1}}');
  assert.throws(() => createLlamaServer({ ...valid, restart: reserved }), isCode('invalid-restart-policy'));
  assert.equal(existsSync(log), false, 'no rejected policy spawns a child');
});

test('without a restart policy an unexpected exit stays exited', async (t) => {
  const { server, starts } = makeCrashServer(t, { mode: 'crash-once', crashMs: 150 });
  await server.start();
  assert.equal(await waitForState(server, 'exited'), true);
  const status = server.status();
  assert.equal(status.restarts, 0);
  assert.equal(status.failure, null);
  assert.ok(Object.isFrozen(status));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(startsCount(starts), 1, 'no automatic restart without a policy');
  assert.equal(server.status().state, 'exited');
  assert.deepEqual(await server.health(), { ok: false, status: 0 });
});

test('a crash while running restarts on the same port after the back-off', async (t) => {
  const { server, starts } = makeCrashServer(t, {
    mode: 'crash-once',
    crashMs: 150,
    restart: { maxRestarts: 2, baseDelayMs: 200, maxDelayMs: 500, stableMs: 60_000 },
  });
  const key = server.auth().apiKey;
  const first = await server.start();
  assert.equal(await waitForState(server, 'restarting'), true);
  assert.equal(server.status().port, first.port, 'the restart keeps the target port');
  assert.ok(Object.isFrozen(server.status()), 'the snapshot stays frozen while restarting');
  assert.deepEqual(await server.health(), { ok: false, status: 0 });
  assert.equal(await waitForState(server, 'running'), true);
  const second = server.status();
  assert.equal(second.port, first.port);
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.restarts, 1);
  assert.equal(second.failure, null);
  assert.equal(server.auth().apiKey, key, 'the key is unchanged across the restart');
  assert.equal(startsCount(starts), 2);
  assert.deepEqual(await server.health(), { ok: true, status: 200 });
  const client = createProviderClient('llama-cpp', {
    baseUrl: second.baseUrl, model: 'fake-gguf', apiKey: server.auth().apiKey, env: {},
  });
  assert.equal((await client.chat({ messages: MESSAGES })).text, 'local answer');
});

test('the back-off grows and the restart budget ends in a bounded failed state', async (t) => {
  const baseDelayMs = 120;
  const crashMs = 120;
  const { server, starts } = makeCrashServer(t, {
    mode: 'crash-after',
    crashMs,
    restart: { maxRestarts: 2, baseDelayMs, maxDelayMs: 400, stableMs: 60_000 },
  });
  await server.start();
  assert.equal(await waitForState(server, 'failed', 15_000), true);
  const status = server.status();
  assert.equal(status.failure, 'restarts-exhausted');
  assert.equal(status.restarts, 2);
  assert.equal(status.port, null);
  assert.equal(status.pid, null);
  assert.equal(startsCount(starts), 3);
  const [t1, t2, t3] = startsTimes(starts);
  assert.ok(t2 - t1 >= crashMs + baseDelayMs, 'the first restart waits at least the base delay: ' + (t2 - t1));
  assert.ok(
    t3 - t2 >= crashMs + baseDelayMs * 2,
    'the second restart waits at least twice the base delay: ' + (t3 - t2),
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(startsCount(starts), 3, 'nothing restarts after the budget is spent');
  assert.equal(server.status().state, 'failed');
  assert.deepEqual(await server.health(), { ok: false, status: 0 });
});

test('a stable run resets the restart budget', async (t) => {
  const { server, starts } = makeCrashServer(t, {
    mode: 'crash-twice',
    crashMs: 1_500,
    restart: { maxRestarts: 1, baseDelayMs: 80, maxDelayMs: 200, stableMs: 1_000 },
  });
  await server.start();
  const deadline = Date.now() + 15_000;
  while (startsCount(starts) < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(startsCount(starts), 3, 'the second crash restarted because the first run was stable');
  assert.equal(await waitForState(server, 'running'), true);
  assert.equal(server.status().failure, null);
});

test('a stableMs of 0 never resets the budget', async (t) => {
  const { server, starts } = makeCrashServer(t, {
    mode: 'crash-twice',
    crashMs: 200,
    restart: { maxRestarts: 1, baseDelayMs: 60, maxDelayMs: 120, stableMs: 0 },
  });
  await server.start();
  assert.equal(await waitForState(server, 'failed', 15_000), true);
  assert.equal(server.status().restarts, 1);
  assert.equal(startsCount(starts), 2);
});

test('a stop during the back-off cancels the pending restart', async (t) => {
  const { server, starts } = makeCrashServer(t, {
    mode: 'crash-once',
    crashMs: 150,
    restart: { maxRestarts: 2, baseDelayMs: 500, maxDelayMs: 1000, stableMs: 60_000 },
  });
  await server.start();
  assert.equal(await waitForState(server, 'restarting'), true);
  assert.equal((await server.stop()).stopped, true);
  assert.equal(server.status().state, 'stopped');
  assert.equal(server.status().port, null);
  assert.equal(server.status().restarts, 0);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(startsCount(starts), 1, 'a stopped controller spawns nothing');
  assert.equal(server.status().state, 'stopped');
});

test('a crash during start still fails closed and never auto-restarts', async (t) => {
  const { server, starts } = makeCrashServer(t, {
    mode: 'exit',
    restart: { maxRestarts: 2, baseDelayMs: 60, maxDelayMs: 120, stableMs: 60_000 },
  });
  await assert.rejects(server.start(), isCode('server-exited'));
  assert.equal(server.status().state, 'stopped');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(startsCount(starts), 1);
  assert.equal(server.status().restarts, 0);
});

test('the back-off delay is capped by maxDelayMs', async (t) => {
  // With baseDelayMs and maxDelayMs both 50 ms every delay is clamped, so ten restarts add about
  // half a second of waiting; the uncapped exponential sum for the same ten attempts is 51.15 s.
  const { server, starts } = makeCrashServer(t, {
    mode: 'crash-after',
    crashMs: 150,
    restart: { maxRestarts: 10, baseDelayMs: 50, maxDelayMs: 50, stableMs: 60_000 },
  });
  const began = Date.now();
  await server.start();
  assert.equal(await waitForState(server, 'failed', 15_000), true);
  const elapsed = Date.now() - began;
  const status = server.status();
  assert.equal(status.failure, 'restarts-exhausted');
  assert.equal(status.restarts, 10);
  assert.equal(startsCount(starts), 11);
  assert.ok(elapsed < 8_000, 'ten capped delays keep the run bounded: ' + elapsed + ' ms');
});

test('a restart that never becomes ready exhausts the budget and fails closed', async (t) => {
  // The first child is healthy and then crashes; every restarted child exits before it is ready, so
  // the failed health-gated starts themselves must spend the budget and end bounded.
  const { server, starts } = makeCrashServer(t, {
    mode: 'crash-once-then-exit',
    crashMs: 150,
    restart: { maxRestarts: 2, baseDelayMs: 60, maxDelayMs: 120, stableMs: 60_000 },
  });
  await server.start();
  assert.equal(await waitForState(server, 'failed', 15_000), true);
  const status = server.status();
  assert.equal(status.failure, 'restarts-exhausted');
  assert.equal(status.restarts, 2);
  assert.equal(status.port, null);
  assert.equal(status.pid, null);
  assert.equal(startsCount(starts), 3);
  assert.deepEqual(await server.health(), { ok: false, status: 0 });
});

test('the restart policy applies the documented defaults', async (t) => {
  const { dir, modelPath } = makeModel(t);
  const log = path.join(dir, 'argv.json');
  const base = { executablePath: NODE, commandArgs: [FIXTURE], modelPath, env: { FAKE_LLAMA_LOG: log } };
  // maxDelayMs defaults to max(baseDelayMs, 30 s), so a base delay above the 30 s default is accepted
  // instead of tripping the maxDelayMs >= baseDelayMs check.
  assert.doesNotThrow(() => createLlamaServer({ ...base, restart: { maxRestarts: 1, baseDelayMs: 40_000 } }));
  assert.doesNotThrow(() => createLlamaServer({ ...base, restart: { maxRestarts: 1 } }));
  // stableMs defaults to 60 s, so two crashes 200 ms apart exhaust a one-restart budget instead of
  // resetting it.
  const { server, starts } = makeCrashServer(t, {
    mode: 'crash-twice',
    crashMs: 200,
    restart: { maxRestarts: 1, baseDelayMs: 60, maxDelayMs: 120 },
  });
  await server.start();
  assert.equal(await waitForState(server, 'failed', 10_000), true);
  assert.equal(server.status().restarts, 1);
  assert.equal(startsCount(starts), 2);
});
