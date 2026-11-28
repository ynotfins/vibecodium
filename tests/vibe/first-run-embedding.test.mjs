import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EMBEDDING_SERVER_ARGS,
  createFirstRunWizard,
} from '../../src/stable/runtime/first-run.mjs';
import { createLlamaServer } from '../../src/stable/runtime/llama-server.mjs';

const GIB = 1024 * 1024 * 1024;
const PLATFORM_KEY = 'win32-x64';
const catalog = JSON.parse(readFileSync(new URL('../../vibe/models/catalog.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../vibe/sidecars.json', import.meta.url), 'utf8'));
const chatEntry = catalog.models.find((model) => model.role === 'chat');
const embeddingEntry = catalog.models.find((model) => model.role === 'embedding');
const sidecarEntry = manifest.sidecars[0];
const sidecarTarget = sidecarEntry.targets[PLATFORM_KEY];
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

function tempRoot(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'vibe-first-run-embedding-')));
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

function localModel(id, flags = {}) {
  return {
    id,
    sizeBytes: 1024,
    parameterSize: '7B',
    quantization: 'Q4_K_M',
    family: 'qwen2',
    embedding: false,
    remote: false,
    ...flags,
  };
}

function availableResult(overrides = {}) {
  return {
    version: 1,
    available: true,
    reason: null,
    status: 200,
    port: 11434,
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [
      localModel('qwen2.5-coder:7b'),
      localModel('nomic-embed-text:latest', { family: 'nomic-bert', embedding: true }),
    ],
    chatModel: 'qwen2.5-coder:7b',
    embeddingModel: 'nomic-embed-text:latest',
    notices: [],
    ...overrides,
  };
}

function fakeInstaller() {
  const calls = [];
  return {
    calls,
    install: async (sidecar, installOptions) => {
      calls.push({ sidecar, installOptions });
      mkdirSync(installOptions.targetDir, { recursive: true });
      const executablePath = path.join(installOptions.targetDir, sidecarTarget.executable);
      writeFileSync(executablePath, 'fake llama-server');
      if (process.platform !== 'win32') chmodSync(executablePath, 0o755);
      return {
        verified: true,
        installed: true,
        skipped: false,
        executablePath,
        version: sidecarEntry.version,
        files: [],
        sizeBytes: sidecarTarget.sizeBytes,
      };
    },
  };
}

function readyWizard(t, overrides = {}) {
  const root = overrides.root ?? tempRoot(t);
  installedModels(root);
  const runtime = runtimeFile(root);
  return {
    root,
    runtime,
    wizard: createFirstRunWizard({
      catalog,
      destinationDir: path.join(root, 'models'),
      probe: async () => ({ hardware: hardware(), notices: [] }),
      verifyModel: async () => ({ verified: true }),
      runtimePath: runtime,
      ...overrides.options,
    }),
  };
}

test('the embedding plan is not-ready before a check and disposed after disposal', async (t) => {
  const { wizard } = readyWizard(t);
  assert.deepEqual(wizard.embeddingPlan(), { available: false, reason: 'not-ready' });
  assert.deepEqual(wizard.embeddingRuntimeOptions(), { available: false, reason: 'not-ready' });
  await wizard.refresh();
  wizard.dispose();
  assert.deepEqual(wizard.embeddingPlan(), { available: false, reason: 'disposed' });
  assert.deepEqual(wizard.embeddingRuntimeOptions(), { available: false, reason: 'disposed' });
});

test('a ready pinned machine exposes the recorded embedding flags and the supervisor option bag', async (t) => {
  const { wizard, root, runtime } = readyWizard(t);
  const view = await wizard.refresh();
  assert.equal(view.phase, 'ready');

  const plan = wizard.embeddingPlan();
  assert.deepEqual(plan, {
    available: true,
    kind: 'llama-server',
    executablePath: runtime,
    modelPath: path.join(root, 'models', embeddingEntry.file),
    commandArgs: ['--embedding', '--pooling', 'last', '-b', '8192', '-ub', '8192'],
    restart: DEFAULT_POLICY,
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.commandArgs), true);
  // The recorded flags are one frozen constant, not a copy rebuilt per call.
  assert.deepEqual(
    EMBEDDING_SERVER_ARGS,
    ['--embedding', '--pooling', 'last', '-b', '8192', '-ub', '8192'],
  );
  assert.equal(Object.isFrozen(EMBEDDING_SERVER_ARGS), true);
  assert.equal(plan.commandArgs, EMBEDDING_SERVER_ARGS);
  // The chat path is untouched: it still plans the chat weights with the recommendation flags.
  assert.deepEqual(wizard.startPlan().modelPath, path.join(root, 'models', chatEntry.file));
  assert.deepEqual(wizard.startPlan().restart, plan.restart);
  assert.equal(wizard.startPlan().commandArgs, undefined);

  const handOff = wizard.embeddingRuntimeOptions();
  assert.deepEqual(handOff, {
    available: true,
    options: {
      executablePath: runtime,
      modelPath: path.join(root, 'models', embeddingEntry.file),
      commandArgs: EMBEDDING_SERVER_ARGS,
      restart: DEFAULT_POLICY,
    },
  });
  assert.equal(Object.isFrozen(handOff), true);
  assert.equal(Object.isFrozen(handOff.options), true);
  assert.equal(handOff.options.restart, wizard.startPlan().restart);
  assert.deepEqual(Object.keys(handOff.options), ['executablePath', 'modelPath', 'commandArgs', 'restart']);
  // The view carries the same plan, so the panel and a caller cannot disagree.
  assert.deepEqual(view.embedding, plan);
  assert.equal(view.embedding.commandArgs, EMBEDDING_SERVER_ARGS);
});

test('the embedding option bag is accepted unchanged by createLlamaServer without spawning', async (t) => {
  const { wizard } = readyWizard(t);
  await wizard.refresh();
  const first = wizard.embeddingRuntimeOptions();
  const server = createLlamaServer(first.options);
  assert.equal(server.status().state, 'stopped');
  assert.equal(server.status().pid, null);
  assert.equal(server.status().port, null);
  assert.deepEqual(wizard.embeddingPlan().commandArgs, EMBEDDING_SERVER_ARGS);
  assert.equal(wizard.embeddingRuntimeOptions().options.commandArgs, first.options.commandArgs);
});

test('the embedding plan waits for the runtime and uses the executable the start action installs', async (t) => {
  const root = tempRoot(t);
  installedModels(root);
  const targetDir = path.join(root, 'runtime');
  const installer = fakeInstaller();
  const wizard = createFirstRunWizard({
    catalog,
    destinationDir: path.join(root, 'models'),
    probe: async () => ({ hardware: hardware(), notices: [] }),
    verifyModel: async () => ({ verified: true }),
    sidecar: { manifest, platformKey: PLATFORM_KEY, targetDir },
    installSidecar: installer.install,
  });
  const view = await wizard.refresh();
  assert.equal(view.phase, 'ready');
  assert.deepEqual(wizard.embeddingPlan(), { available: false, reason: 'runtime-not-bundled' });
  assert.deepEqual(wizard.embeddingRuntimeOptions(), { available: false, reason: 'runtime-not-bundled' });
  assert.equal(installer.calls.length, 0);

  const started = await wizard.start();
  assert.equal(started.available, true);
  assert.equal(installer.calls.length, 1);
  const executable = path.join(targetDir, sidecarTarget.executable);
  const handOff = wizard.embeddingRuntimeOptions();
  assert.deepEqual(handOff, {
    available: true,
    options: {
      executablePath: executable,
      modelPath: path.join(root, 'models', embeddingEntry.file),
      commandArgs: EMBEDDING_SERVER_ARGS,
      restart: DEFAULT_POLICY,
    },
  });
  assert.deepEqual(wizard.view().embedding, wizard.embeddingPlan());
  assert.equal(installer.calls.length, 1);
});

test('a selected daemon serves the daemon embedding plan and a chat-only daemon reports no model', async (t) => {
  const { wizard, root, runtime } = readyWizard(t, {
    options: { discoverOllama: async () => availableResult() },
  });
  const view = await wizard.refresh();
  assert.equal(view.phase, 'ready');
  await wizard.checkOllama();
  assert.deepEqual(wizard.useOllama(), { ok: true, source: 'ollama' });

  const daemon = wizard.embeddingPlan();
  assert.deepEqual(daemon, {
    available: true,
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'nomic-embed-text:latest',
  });
  assert.equal(Object.isFrozen(daemon), true);
  // A daemon plan is not a supervisor hand-off: there are neither options nor a pinned path.
  assert.deepEqual(wizard.embeddingRuntimeOptions(), daemon);

  assert.deepEqual(wizard.usePinned(), { ok: true, source: 'pinned' });
  assert.deepEqual(wizard.embeddingRuntimeOptions(), {
    available: true,
    options: {
      executablePath: runtime,
      modelPath: path.join(root, 'models', embeddingEntry.file),
      commandArgs: EMBEDDING_SERVER_ARGS,
      restart: DEFAULT_POLICY,
    },
  });

  const chatOnlyRoot = tempRoot(t);
  const chatOnly = createFirstRunWizard({
    catalog,
    destinationDir: path.join(chatOnlyRoot, 'models'),
    probe: async () => ({ hardware: hardware(), notices: [] }),
    verifyModel: async () => ({ verified: true }),
    runtimePath: runtimeFile(chatOnlyRoot),
    discoverOllama: async () => availableResult({
      models: [localModel('qwen2.5-coder:7b')],
      embeddingModel: null,
    }),
  });
  await chatOnly.refresh();
  await chatOnly.checkOllama();
  assert.deepEqual(chatOnly.useOllama(), { ok: true, source: 'ollama' });
  assert.deepEqual(chatOnly.embeddingPlan(), { available: false, reason: 'no-embedding-model' });
  assert.deepEqual(chatOnly.embeddingRuntimeOptions(), { available: false, reason: 'no-embedding-model' });
  assert.deepEqual(chatOnly.view().embedding, chatOnly.embeddingPlan());
});

test('the embedding hand-off ignores caller-supplied flags, a port or a ubatch override', async (t) => {
  const { wizard } = readyWizard(t);
  await wizard.refresh();
  const handOff = wizard.embeddingRuntimeOptions({
    commandArgs: ['--host=0.0.0.0', '-ub', '512'],
    port: 9999,
    contextSize: 4096,
  });
  assert.deepEqual(Object.keys(handOff.options), ['executablePath', 'modelPath', 'commandArgs', 'restart']);
  // The shared recorded flags survive; a caller override is not merged into the option bag.
  assert.equal(handOff.options.commandArgs, EMBEDDING_SERVER_ARGS);
  assert.deepEqual(
    handOff.options.commandArgs,
    ['--embedding', '--pooling', 'last', '-b', '8192', '-ub', '8192'],
  );
  assert.equal(handOff.options.port, undefined);
  assert.equal(handOff.options.contextSize, undefined);
  assert.equal(Object.isFrozen(handOff.options), true);
});

test('the recorded embedding flags raise the logical and physical batch to the same 8192', () => {
  // At the pinned b12426 build llama_context sizes the physical batch as
  // min(n_batch, n_ubatch) (src/llama-context.cpp) and the pinned archive's help text gives
  // --batch-size a default of 2048, so asking for an 8192 ubatch alone still batches at 2048.
  const batch = EMBEDDING_SERVER_ARGS.indexOf('-b');
  const ubatch = EMBEDDING_SERVER_ARGS.indexOf('-ub');
  assert.notEqual(batch, -1, 'the plan sets the logical batch');
  assert.notEqual(ubatch, -1, 'the plan sets the physical batch');
  assert.ok(batch < ubatch, 'the logical batch precedes the physical batch');
  assert.equal(EMBEDDING_SERVER_ARGS[batch + 1], '8192');
  assert.equal(EMBEDDING_SERVER_ARGS[ubatch + 1], '8192');
  assert.equal(EMBEDDING_SERVER_ARGS[batch + 1], EMBEDDING_SERVER_ARGS[ubatch + 1]);
  assert.equal(Object.isFrozen(EMBEDDING_SERVER_ARGS), true);
});
