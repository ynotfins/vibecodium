import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LOCAL_PROVIDER_VERSION,
  LocalProviderError,
  createLocalProvider,
  resolveRuntimeApiKey,
} from '../../src/stable/runtime/local-provider.mjs';
import { createProviderClient } from '../../src/stable/gateway/provider-client.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'vibe', 'fixtures', 'fake-llama-server.mjs');
const NODE = realpathSync.native(process.execPath);
const TEMP_ROOT = realpathSync.native(tmpdir());
const MODEL_BYTES = Buffer.from('GGUF\u0000test-model\u0000');
const CHAT_MODEL = 'qwen2.5-coder-1.5b-q4-k-m';
const MESSAGES = [{ role: 'user', content: 'hello' }];

function isCode(code) {
  return (error) => error instanceof LocalProviderError && error.code === code;
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(TEMP_ROOT, 'vibe-local-provider-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeModel(dir) {
  const modelPath = path.join(dir, 'model-q4_k_m.gguf');
  writeFileSync(modelPath, MODEL_BYTES);
  return modelPath;
}

// The first-run controller is frozen with own data methods; the host validates the same shape, so a
// stub is a plain object with the two methods (an absent startPlan throws to prove it is not read).
function wizardOf(runtimeOptions, startPlan) {
  return Object.freeze({
    runtimeOptions,
    startPlan: startPlan ?? (() => { throw new Error('startPlan must not be called'); }),
  });
}

function pinnedWizard(t, overrides = {}, planOverrides = {}) {
  const dir = tempDir(t);
  const modelPath = makeModel(dir);
  const log = path.join(dir, 'argv.json');
  const starts = path.join(dir, 'starts.txt');
  const hand = Object.freeze({
    available: true,
    options: Object.freeze({
      executablePath: NODE,
      commandArgs: Object.freeze([FIXTURE]),
      modelPath,
      env: Object.freeze({ FAKE_LLAMA_LOG: log, FAKE_LLAMA_STARTS: starts }),
      startupTimeoutMs: 5000,
      healthIntervalMs: 20,
      stopTimeoutMs: 3000,
      ...overrides,
    }),
  });
  const plan = Object.freeze(Object.assign({
    available: true,
    kind: 'llama-server',
    executablePath: NODE,
    modelPath,
    model: CHAT_MODEL,
    contextSize: 4096,
    threads: 4,
    gpuLayers: 0,
  }, planOverrides));
  const wizard = wizardOf(() => hand, () => plan);
  return { wizard, hand, plan, dir, modelPath, log, starts };
}

function readArgv(log) {
  return JSON.parse(readFileSync(log, 'utf8'));
}

function bootCount(starts) {
  try {
    return readFileSync(starts, 'utf8').split('\n').filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
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

test('a blocked wizard fails the start with a bounded reason and never spawns', async (t) => {
  const wizard = wizardOf(() => Object.freeze({ available: false, reason: 'runtime-not-bundled' }));
  const host = createLocalProvider({ wizard });
  t.after(() => host.dispose());
  await assert.rejects(host.start(), (error) => {
    assert.equal(error.code, 'runtime-unavailable');
    assert.equal(error.reason, 'runtime-not-bundled');
    return true;
  });
  const status = host.status();
  assert.equal(status.state, 'failed');
  assert.deepEqual({ ...status.failure }, { code: 'runtime-unavailable', reason: 'runtime-not-bundled' });
  assert.equal(host.client(), null);
  assert.equal(status.pid, null);
  assert.equal(status.model, null);
});

test('an unavailable hand-off with an unknown or hostile reason is bounded', async (t) => {
  for (const reason of ['weird', 'not-a-reason\r\nx', 42, undefined, null]) {
    const wizard = wizardOf(() => Object.freeze({ available: false, reason }));
    const host = createLocalProvider({ wizard });
    t.after(() => host.dispose());
    await assert.rejects(host.start(), isCode('runtime-unavailable'));
    assert.deepEqual({ ...host.status().failure }, { code: 'runtime-unavailable', reason: 'unavailable' });
  }
  // A known reason is passed through unchanged.
  const known = createLocalProvider({
    wizard: wizardOf(() => Object.freeze({ available: false, reason: 'runtime-install-failed' })),
  });
  t.after(() => known.dispose());
  await assert.rejects(known.start(), (error) => error.reason === 'runtime-install-failed');
});

test('a wizard that is not a plain object with own data methods fails closed without invoking an accessor', async (t) => {
  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, 'runtimeOptions', {
    enumerable: true,
    get() { invoked = true; return () => { throw new Error('never'); }; },
  });
  Object.defineProperty(accessor, 'startPlan', {
    enumerable: true,
    get() { invoked = true; return () => { throw new Error('never'); }; },
  });
  assert.throws(() => createLocalProvider({ wizard: accessor }), isCode('invalid-options'));
  assert.equal(invoked, false);

  for (const wizard of [null, undefined, 42, 'wizard', [], Object.freeze({})]) {
    assert.throws(() => createLocalProvider({ wizard }), isCode('invalid-options'));
  }
  assert.throws(
    () => createLocalProvider({ wizard: Object.freeze({ runtimeOptions: () => ({ available: false }) }) }),
    isCode('invalid-options'),
  );
  assert.throws(
    () => createLocalProvider({ wizard: Object.freeze({ runtimeOptions: 'nope', startPlan: () => null }) }),
    isCode('invalid-options'),
  );

  const revocable = Proxy.revocable(Object.freeze({ runtimeOptions: () => null, startPlan: () => null }), {});
  revocable.revoke();
  assert.throws(() => createLocalProvider({ wizard: revocable.proxy }), isCode('invalid-options'));

  // Options are validated the same way.
  assert.throws(() => createLocalProvider(), isCode('invalid-options'));
  assert.throws(() => createLocalProvider({ wizard: Object.freeze({ runtimeOptions: () => null, startPlan: () => null }), extra: 1 }), isCode('invalid-options'));
  const hostilePolicy = {};
  Object.defineProperty(hostilePolicy, 'allowExternalProviders', {
    enumerable: true,
    get() { throw new Error('policy accessor invoked'); },
  });
  assert.throws(
    () => createLocalProvider({
      wizard: Object.freeze({ runtimeOptions: () => null, startPlan: () => null }),
      policy: hostilePolicy,
    }),
    isCode('invalid-options'),
  );
});

test('a malformed hand-off or plan fails closed before any spawn', async (t) => {
  const cases = [
    ['a hand-off that is not an object', () => 'nope', () => ({ available: true, kind: 'llama-server' })],
    ['a pinned hand-off without options', () => Object.freeze({ available: true, kind: 'llama-server' }), () => Object.freeze({ available: true, kind: 'llama-server', model: CHAT_MODEL })],
    ['a plan that is blocked', () => Object.freeze({ available: true, options: Object.freeze({}) }), () => Object.freeze({ available: false, reason: 'disposed' })],
    ['a plan without a model', () => Object.freeze({ available: true, options: Object.freeze({ executablePath: NODE, modelPath: path.join(TEMP_ROOT, 'x.gguf') }) }), () => Object.freeze({ available: true, kind: 'llama-server' })],
    ['a plan with a hostile model', () => Object.freeze({ available: true, options: Object.freeze({ executablePath: NODE, modelPath: path.join(TEMP_ROOT, 'x.gguf') }) }), () => Object.freeze({ available: true, kind: 'llama-server', model: 'bad\nmodel' })],
    ['a plan with an accessor model', () => Object.freeze({ available: true, options: Object.freeze({ executablePath: NODE, modelPath: path.join(TEMP_ROOT, 'x.gguf') }) }), () => {
      const plan = { available: true, kind: 'llama-server' };
      Object.defineProperty(plan, 'model', { enumerable: true, get() { throw new Error('model accessor invoked'); } });
      return plan;
    }],
  ];
  for (const [name, runtimeOptions, startPlan] of cases) {
    const host = createLocalProvider({ wizard: wizardOf(runtimeOptions, startPlan) });
    t.after(() => host.dispose());
    await assert.rejects(
      host.start(),
      (error) => error instanceof LocalProviderError && ['invalid-handoff', 'invalid-plan'].includes(error.code),
      name,
    );
    assert.equal(host.status().state, 'failed', name);
    assert.equal(host.client(), null, name);
    assert.equal(host.status().pid, null, name);
  }
});

test('a wizard that throws reports a bounded failure without its message', async (t) => {
  const secret = 'sk-live-' + 'z'.repeat(40);
  const host = createLocalProvider({
    wizard: wizardOf(() => { throw new Error('boom ' + secret); }),
  });
  t.after(() => host.dispose());
  let seen;
  await assert.rejects(host.start(), (error) => {
    seen = error;
    return true;
  });
  assert.equal(seen.code, 'handoff-failed');
  assert.equal(String(seen.message).includes(secret), false);
  assert.equal(JSON.stringify(host.status()).includes(secret), false);
});

test('a pinned plan starts the supervisor and hands a working authenticated llama-cpp client', async (t) => {
  const { wizard, log, starts, modelPath } = pinnedWizard(t);
  const host = createLocalProvider({ wizard });
  t.after(() => host.dispose());
  assert.equal(host.status().state, 'idle');
  assert.equal(LOCAL_PROVIDER_VERSION, 1);

  const started = await host.start();
  assert.equal(started.state, 'running');
  assert.equal(started.kind, 'llama-server');
  assert.equal(started.id, 'llama-cpp');
  assert.equal(started.model, CHAT_MODEL);
  assert.equal(started.modelPath, undefined);
  assert.match(started.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(Number.isInteger(started.port), true);
  assert.equal(Number.isInteger(started.pid), true);
  assert.equal(started.failure, null);
  assert.equal(Object.isFrozen(started), true);
  assert.equal(bootCount(starts), 1);

  const client = host.client();
  assert.equal(client.config.id, 'llama-cpp');
  assert.equal(client.config.auth, 'bearer');
  assert.equal(client.config.model, CHAT_MODEL);
  assert.equal(client.config.baseUrl, started.baseUrl);
  assert.equal(typeof client.describe().apiKey, 'undefined');

  const chat = await client.chat({ messages: MESSAGES });
  assert.equal(chat.text, 'local answer');
  const streamed = await client.chat({ messages: MESSAGES, stream: true });
  assert.equal(streamed.text, 'local answer');
  const embedded = await client.embeddings({ input: ['a'] });
  assert.deepEqual([...embedded.vectors[0]], [0.1, 0.2, 0.3]);

  const argv = readArgv(log);
  assert.equal(argv.env.HAS_API_KEY, 'present', 'the child received a key and the client sent it');
  assert.equal(argv.args.includes(CHAT_MODEL), false, 'the model name is not a server argument');
  assert.deepEqual(argv.args.slice(0, 2), ['--model', modelPath]);

  // The key is only reachable through the client's closure: no snapshot, no JSON, no error.
  const serialized = JSON.stringify({ status: host.status(), describe: host.describe() });
  assert.equal(/[A-Za-z0-9_-]{43}/.test(serialized), false, 'no key-shaped value in a snapshot');
  await assert.rejects(client.chat({ messages: 'nope' }), (error) => {
    assert.equal(error.code, 'invalid-messages');
    assert.equal(JSON.stringify(error).includes('Bearer'), false);
    return true;
  });

  // A different key is rejected by the same listener, which proves the client presented the real one.
  const wrongKey = createProviderClient('llama-cpp', {
    baseUrl: started.baseUrl,
    model: CHAT_MODEL,
    apiKey: 'k'.repeat(43),
    env: {},
  });
  await assert.rejects(wrongKey.chat({ messages: MESSAGES }), (error) => {
    assert.equal(error.code, 'http-status');
    assert.equal(error.status, 401);
    return true;
  });

  const pid = started.pid;
  const stopped = await host.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(host.status().pid, null);
  assert.equal(host.client(), null);
  assert.equal(await waitGone(pid), true, 'the child is gone after stop');
  const again = await host.stop();
  assert.equal(again.state, 'stopped');

  // A stopped host starts the runtime again.
  const restarted = await host.start();
  assert.equal(restarted.state, 'running');
  assert.equal(bootCount(starts), 2);
  assert.equal((await host.client().chat({ messages: MESSAGES })).text, 'local answer');
});

test('concurrent starts spawn one child and share the same result', async (t) => {
  const { wizard, starts } = pinnedWizard(t);
  const host = createLocalProvider({ wizard });
  t.after(() => host.dispose());
  const [first, second] = await Promise.all([host.start(), host.start()]);
  assert.deepEqual(first, second);
  assert.equal(first.state, 'running');
  assert.equal(bootCount(starts), 1);
  assert.equal(host.status().state, 'running');
  // A start while running returns the same descriptor without spawning again.
  const third = await host.start();
  assert.equal(third.pid, first.pid);
  assert.equal(bootCount(starts), 1);
});

test('a supervisor failure is reported with its bounded code and leaves nothing running', async (t) => {
  const missing = createLocalProvider({
    wizard: wizardOf(
      () => Object.freeze({
        available: true,
        options: Object.freeze({
          executablePath: path.join(TEMP_ROOT, 'definitely-missing-llama-server.exe'),
          modelPath: path.join(TEMP_ROOT, 'x.gguf'),
        }),
      }),
      () => Object.freeze({ available: true, kind: 'llama-server', model: CHAT_MODEL }),
    ),
  });
  t.after(() => missing.dispose());
  await assert.rejects(missing.start(), (error) => {
    assert.equal(error.code, 'invalid-executable');
    return true;
  });
  assert.equal(missing.status().state, 'failed');
  assert.deepEqual({ ...missing.status().failure }, { code: 'invalid-executable' });
  assert.equal(missing.client(), null);

  // A child that never becomes healthy is reported and reaped.
  const { wizard } = pinnedWizard(t, {
    env: Object.freeze({ FAKE_LLAMA_MODE: 'unhealthy' }),
    startupTimeoutMs: 600,
    healthIntervalMs: 50,
  });
  const unhealthy = createLocalProvider({ wizard });
  t.after(() => unhealthy.dispose());
  await assert.rejects(unhealthy.start(), (error) => {
    assert.equal(error.code, 'startup-timeout');
    return true;
  });
  assert.equal(unhealthy.status().state, 'failed');
  assert.equal(unhealthy.status().pid, null);
  assert.equal(unhealthy.client(), null);
});

test('a stop during a start ends stopped without a failure and a later start succeeds', async (t) => {
  const { wizard, starts } = pinnedWizard(t);
  const host = createLocalProvider({ wizard });
  t.after(() => host.dispose());
  const pending = host.start();
  const stopped = await host.stop();
  await pending.then(() => {}, () => {});
  const bootsAfterStop = bootCount(starts);
  assert.equal(stopped.state, 'stopped');
  assert.equal(host.status().state, 'stopped');
  assert.equal(host.status().failure, null);
  assert.equal(host.client(), null);
  assert.equal(host.status().pid, null);

  const restarted = await host.start();
  assert.equal(restarted.state, 'running');
  assert.equal(bootCount(starts), bootsAfterStop + 1);
  assert.equal((await host.client().chat({ messages: MESSAGES })).text, 'local answer');
});

test('dispose stops the child and refuses a later start', async (t) => {
  const { wizard } = pinnedWizard(t);
  const host = createLocalProvider({ wizard });
  const started = await host.start();
  assert.equal(started.state, 'running');
  await host.dispose();
  assert.equal(host.status().state, 'stopped');
  assert.equal(host.client(), null);
  await assert.rejects(host.start(), isCode('disposed'));
  await host.dispose();
});

test('a selected Ollama daemon becomes an ollama client without spawning or reading the supervisor plan', async (t) => {
  const hand = Object.freeze({
    available: true,
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5-coder:1.5b',
    embeddingModel: 'nomic-embed-text',
  });
  const wizard = wizardOf(() => hand, () => { throw new Error('startPlan must not be read for a daemon'); });
  const host = createLocalProvider({ wizard });
  t.after(() => host.dispose());
  const started = await host.start();
  assert.equal(started.state, 'running');
  assert.equal(started.kind, 'ollama');
  assert.equal(started.id, 'ollama');
  assert.equal(started.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(started.model, 'qwen2.5-coder:1.5b');
  assert.equal(started.pid, null);
  assert.equal(started.port, null);
  assert.equal(host.client().config.id, 'ollama');
  assert.equal(host.client().config.auth, 'none');
  assert.equal(host.client().config.model, 'qwen2.5-coder:1.5b');
  assert.equal((await host.stop()).state, 'stopped');
  assert.equal(host.client(), null);
});

test('a daemon hand-off with a hostile base URL or model fails closed', async (t) => {
  for (const [hand, policy] of [
    [{ available: true, kind: 'ollama', baseUrl: 'not a url', model: 'm' }, undefined],
    [{ available: true, kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: '' }, undefined],
    [{ available: true, kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'bad\nmodel' }, undefined],
    // Loopback-only: a private-LAN or remote daemon is refused even when the caller's policy would
    // allow the host, because the wizard's Ollama discovery is fixed at 127.0.0.1.
    [{ available: true, kind: 'ollama', baseUrl: 'http://192.168.1.50:11434', model: 'm' },
      { allowExternalProviders: true, allowHosts: Object.freeze(['192.168.1.50']) }],
    [{ available: true, kind: 'ollama', baseUrl: 'https://attacker.example/v1', model: 'm' },
      { allowExternalProviders: true, allowHosts: Object.freeze(['attacker.example']) }],
  ]) {
    const host = createLocalProvider({ wizard: wizardOf(() => Object.freeze(hand)), policy });
    t.after(() => host.dispose());
    await assert.rejects(host.start(), (error) => {
      assert.equal(error.code, 'invalid-handoff');
      assert.equal(JSON.stringify(error.message).includes('attacker.example'), false);
      return true;
    });
    assert.equal(host.status().state, 'failed');
    assert.equal(host.client(), null);
  }
});

test('an IPv6 loopback daemon is accepted, proving the loopback test is host-shape aware', async (t) => {
  const hand = Object.freeze({
    available: true,
    kind: 'ollama',
    baseUrl: 'http://[::1]:11434',
    model: 'qwen2.5-coder:1.5b',
  });
  const host = createLocalProvider({ wizard: wizardOf(() => hand) });
  t.after(() => host.dispose());
  const started = await host.start();
  assert.equal(started.state, 'running');
  assert.equal(started.baseUrl, 'http://[::1]:11434');
  assert.equal(host.client().config.id, 'ollama');
});

test('a caller policy is snapshotted so a later mutation cannot widen egress', async (t) => {
  const allowHosts = ['safe.example'];
  const allowEndpoints = ['https://safe.example/v1'];
  const policy = { allowExternalProviders: false, allowHosts, allowEndpoints };
  const hand = Object.freeze({
    available: true,
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5-coder:1.5b',
  });
  const host = createLocalProvider({ wizard: wizardOf(() => hand), policy });
  t.after(() => host.dispose());
  assert.equal((await host.start()).state, 'running');
  const applied = host.client().config.policy;
  assert.notEqual(applied, policy);
  assert.notEqual(applied.allowHosts, allowHosts);
  assert.notEqual(applied.allowEndpoints, allowEndpoints);
  assert.equal(Object.isFrozen(applied), true);
  assert.equal(Object.isFrozen(applied.allowHosts), true);
  assert.equal(Object.isFrozen(applied.allowEndpoints), true);
  allowHosts.push('attacker.example');
  allowEndpoints.push('https://attacker.example/v1');
  policy.allowUnknownHosts = true;
  assert.deepEqual([...applied.allowHosts], ['safe.example']);
  assert.deepEqual([...applied.allowEndpoints], ['https://safe.example/v1']);
  assert.equal('allowUnknownHosts' in applied, false);
});

test('resolveRuntimeApiKey validates the supervisor key and never echoes it', () => {
  const key = 'k'.repeat(43);
  assert.equal(resolveRuntimeApiKey(Object.freeze({ apiKey: key })), key);
  assert.equal(resolveRuntimeApiKey(Object.freeze({ apiKey: 'k'.repeat(32) })), 'k'.repeat(32));
  assert.equal(resolveRuntimeApiKey(Object.freeze({ apiKey: 'k'.repeat(128) })), 'k'.repeat(128));
  for (const auth of [undefined, null, 'key', 42, [], Object.freeze({}), Object.freeze({ apiKey: '' })]) {
    assert.throws(() => resolveRuntimeApiKey(auth), isCode('missing-api-key'));
  }
  for (const apiKey of ['short', 'k'.repeat(31), 'k'.repeat(129), 'k\n'.repeat(20), 'x'.repeat(4097)]) {
    assert.throws(() => resolveRuntimeApiKey(Object.freeze({ apiKey })), (error) => {
      assert.equal(error.code, 'missing-api-key');
      assert.equal(error.message.includes(apiKey), false);
      return true;
    });
  }
  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, 'apiKey', {
    enumerable: true,
    get() { invoked = true; return key; },
  });
  assert.throws(() => resolveRuntimeApiKey(accessor), isCode('missing-api-key'));
  assert.equal(invoked, false);
  const revocable = Proxy.revocable(Object.freeze({ apiKey: key }), {});
  revocable.revoke();
  assert.throws(() => resolveRuntimeApiKey(revocable.proxy), isCode('missing-api-key'));
});
