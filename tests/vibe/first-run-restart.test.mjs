import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FirstRunError,
  createFirstRunWizard,
} from '../../src/stable/runtime/first-run.mjs';
import { createLlamaServer } from '../../src/stable/runtime/llama-server.mjs';

const GIB = 1024 * 1024 * 1024;
const catalog = JSON.parse(readFileSync(new URL('../../vibe/models/catalog.json', import.meta.url), 'utf8'));
const chatEntry = catalog.models.find((model) => model.role === 'chat');
const DEFAULT_POLICY = {
  maxRestarts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  stableMs: 60000,
};

function hardware(overrides = {}) {
  return {
    platform: 'win32',
    arch: 'x64',
    cpu: { model: 'Unit Test CPU', logicalCores: 8 },
    totalMemoryBytes: 32 * GIB,
    freeMemoryBytes: 16 * GIB,
    gpus: [],
    ...overrides,
  };
}

// A machine that accepts the pinned chat model with full GPU offload, so the plan is stable and the
// start options carry fixed context, thread and layer values.
function capableGpu() {
  return {
    name: 'NVIDIA GeForce RTX 4070',
    vendor: 'nvidia',
    kind: 'discrete',
    memoryBytes: 12 * GIB,
  };
}

function tempRoot(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'vibe-first-run-restart-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runtimeFile(root) {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const file = path.join(root, name);
  writeFileSync(file, 'fake executable');
  if (process.platform !== 'win32') chmodSync(file, 0o755);
  return file;
}

function installedModels(root) {
  const models = path.join(root, 'models');
  mkdirSync(models, { recursive: true });
  for (const entry of catalog.models) writeFileSync(path.join(models, entry.file), 'GGUF\u0000stub');
  return models;
}

function readyWizard(t, options = {}) {
  const root = tempRoot(t);
  installedModels(root);
  const runtime = runtimeFile(root);
  const probeCalls = { count: 0 };
  const wizard = createFirstRunWizard({
    catalog,
    destinationDir: path.join(root, 'models'),
    probe: async () => {
      probeCalls.count += 1;
      return { hardware: hardware({ gpus: [capableGpu()] }), notices: [] };
    },
    verifyModel: async () => ({ verified: true }),
    runtimePath: runtime,
    ...options,
  });
  return { wizard, root, runtime, probeCalls };
}

test('a ready machine exposes the default bounded restart policy in the plan and the runtime options', async (t) => {
  const { wizard, root, runtime } = readyWizard(t);
  const view = await wizard.refresh();
  assert.equal(view.phase, 'ready');
  assert.equal(Object.isFrozen(view.start.restart), true);
  assert.deepEqual(view.start.restart, DEFAULT_POLICY);

  const plan = wizard.startPlan();
  assert.deepEqual(plan.restart, DEFAULT_POLICY);
  // One frozen policy object is the single source for the plan and the supervisor options.
  assert.equal(plan.restart, view.start.restart);

  const runtimeOptions = wizard.runtimeOptions();
  assert.deepEqual(runtimeOptions, {
    available: true,
    options: {
      executablePath: runtime,
      modelPath: path.join(root, 'models', chatEntry.file),
      contextSize: 8192,
      threads: 6,
      gpuLayers: 999,
      restart: DEFAULT_POLICY,
    },
  });
  assert.equal(Object.isFrozen(runtimeOptions), true);
  assert.equal(Object.isFrozen(runtimeOptions.options), true);
  assert.equal(Object.isFrozen(runtimeOptions.options.restart), true);
  assert.equal(runtimeOptions.options.restart, plan.restart);
  // The supervisor-only fields stay out of the hand-off: it is the start plan, not the wizard view.
  assert.deepEqual(Object.keys(runtimeOptions.options),
    ['executablePath', 'modelPath', 'contextSize', 'threads', 'gpuLayers', 'restart']);
});

test('the runtime options are accepted unchanged by createLlamaServer without spawning', async (t) => {
  const { wizard } = readyWizard(t);
  await wizard.refresh();
  const server = createLlamaServer(wizard.runtimeOptions().options);
  assert.equal(server.status().state, 'stopped');
  assert.equal(server.status().pid, null);
  assert.equal(server.status().port, null);
  assert.equal(server.status().restarts, 0);
});

test('a supplied policy is validated, copied, frozen and never mutated', async (t) => {
  const supplied = Object.freeze({ maxRestarts: 5, baseDelayMs: 2000, maxDelayMs: 60000, stableMs: 0 });
  const { wizard } = readyWizard(t, { restart: supplied });
  const view = await wizard.refresh();
  assert.deepEqual(view.start.restart, { maxRestarts: 5, baseDelayMs: 2000, maxDelayMs: 60000, stableMs: 0 });
  assert.notEqual(view.start.restart, supplied);
  assert.equal(Object.isFrozen(view.start.restart), true);

  const partial = await (async () => {
    const other = readyWizard(t, { restart: { maxRestarts: 2 } });
    const otherView = await other.wizard.refresh();
    return otherView.start.restart;
  })();
  // The supervisor fills the documented defaults for the omitted fields.
  assert.deepEqual(partial, { maxRestarts: 2, baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000 });
});

test('an invalid restart policy fails closed before the probe runs', () => {
  const accessorCalls = { count: 0 };
  const accessorPolicy = {};
  Object.defineProperty(accessorPolicy, 'maxRestarts', {
    enumerable: true,
    get() {
      accessorCalls.count += 1;
      return 2;
    },
  });
  const revoked = Proxy.revocable({ maxRestarts: 2 }, {});
  revoked.revoke();
  const trapping = new Proxy({ maxRestarts: 2 }, {
    getOwnPropertyDescriptor() { throw new Error('trap'); },
    ownKeys() { throw new Error('trap'); },
  });
  const protoKey = JSON.parse('{"maxRestarts":2,"__proto__":{"polluted":true}}');
  const invalid = [
    null,
    [],
    'policy',
    42,
    {},
    { maxRestarts: 0 },
    { maxRestarts: 11 },
    { maxRestarts: 1.5 },
    { maxRestarts: 2, baseDelayMs: 10 },
    { maxRestarts: 2, baseDelayMs: 400000 },
    { maxRestarts: 2, baseDelayMs: 5000, maxDelayMs: 1000 },
    { maxRestarts: 2, stableMs: 500 },
    { maxRestarts: 2, stableMs: 1 },
    { maxRestarts: 2, stableMs: -1 },
    { maxRestarts: 2, unknown: 1 },
    protoKey,
    accessorPolicy,
    revoked.proxy,
    trapping,
  ];
  for (const policy of invalid) {
    let probeCalls = 0;
    assert.throws(() => createFirstRunWizard({
      catalog,
      destinationDir: path.join(os.tmpdir(), 'vibe-first-run-restart-invalid'),
      probe: async () => {
        probeCalls += 1;
        return { hardware: hardware(), notices: [] };
      },
      verifyModel: async () => ({ verified: false }),
      restart: policy,
    }), (error) => {
      assert.equal(error instanceof FirstRunError, true);
      assert.equal(error.code, 'invalid-options');
      return true;
    });
    assert.equal(probeCalls, 0);
  }
  assert.equal(accessorCalls.count, 0);
});

test('runtimeOptions reports not-ready and runtime-not-bundled without a process', async (t) => {
  const fresh = createFirstRunWizard({
    catalog,
    destinationDir: path.join(tempRoot(t), 'models'),
    probe: async () => ({ hardware: hardware(), notices: [] }),
    verifyModel: async () => ({ verified: false }),
  });
  assert.deepEqual(fresh.runtimeOptions(), { available: false, reason: 'not-ready' });
  assert.equal(Object.isFrozen(fresh.runtimeOptions()), true);

  const root = tempRoot(t);
  installedModels(root);
  const bundled = createFirstRunWizard({
    catalog,
    destinationDir: path.join(root, 'models'),
    probe: async () => ({ hardware: hardware({ gpus: [capableGpu()] }), notices: [] }),
    verifyModel: async () => ({ verified: true }),
  });
  const view = await bundled.refresh();
  assert.equal(view.phase, 'ready');
  assert.deepEqual(bundled.runtimeOptions(), { available: false, reason: 'runtime-not-bundled' });

  const waiting = readyWizard(t, { verifyModel: async () => ({ verified: false }) });
  await waiting.wizard.refresh();
  assert.deepEqual(waiting.wizard.runtimeOptions(), { available: false, reason: 'not-ready' });
});
