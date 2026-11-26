import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FirstRunError,
  createFirstRunWizard,
  projectCatalogModels,
} from '../../src/stable/runtime/first-run.mjs';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const catalog = JSON.parse(readFileSync(new URL('../../vibe/models/catalog.json', import.meta.url), 'utf8'));
const chatEntry = catalog.models.find((model) => model.role === 'chat');
const embeddingEntry = catalog.models.find((model) => model.role === 'embedding');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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

function probe(hw = hardware(), notices = []) {
  return async () => ({ hardware: hw, notices });
}

function tempRoot(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'vibe-first-run-')));
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

function wizard(t, overrides = {}) {
  const root = overrides.root ?? tempRoot(t);
  return createFirstRunWizard({
    catalog,
    destinationDir: path.join(root, 'models'),
    probe: probe(),
    verifyModel: async () => ({ verified: false }),
    ...overrides.options,
  });
}

test('projectCatalogModels projects only chat and embedding entries to four fields', () => {
  const input = clone(catalog);
  const before = clone(input);
  const projected = projectCatalogModels(input);
  assert.equal(projected.length, 2);
  assert.deepEqual(projected.map((model) => model.role).sort(), ['chat', 'embedding']);
  for (const model of projected) {
    assert.deepEqual(Object.keys(model), ['id', 'role', 'sizeBytes', 'contextTokens']);
  }
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected[0]), true);
});

test('projectCatalogModels skips a code role and fails closed without a required role', () => {
  const extra = clone(chatEntry);
  extra.id = 'code-model';
  extra.file = 'code-model.gguf';
  extra.role = 'code';
  const three = projectCatalogModels({ version: 1, models: [clone(chatEntry), clone(embeddingEntry), extra] });
  assert.equal(three.length, 2);
  assert.equal(three.some((model) => model.id === 'code-model'), false);

  assert.throws(() => projectCatalogModels({ version: 1, models: [clone(embeddingEntry)] }), (error) => {
    assert.equal(error.code, 'no-chat-model');
    return true;
  });
  assert.throws(() => projectCatalogModels({ version: 1, models: [clone(chatEntry)] }), (error) => {
    assert.equal(error.code, 'no-embedding-model');
    return true;
  });
  assert.throws(() => projectCatalogModels({ version: 2, models: [] }), (error) => {
    assert.equal(error.code, 'invalid-catalog');
    return true;
  });
});

test('refresh reports a needs-download plan with merged probe and policy notices', async (t) => {
  const root = tempRoot(t);
  const wizardInstance = wizard(t, { root, options: { probe: probe(hardware(), ['gpu-probe-empty']) } });
  const view = await wizardInstance.refresh();
  assert.equal(view.phase, 'needs-download');
  assert.equal(view.verdict, 'tight');
  assert.equal(view.acceleration, 'cpu');
  assert.equal(view.downloadBytes, chatEntry.sizeBytes + embeddingEntry.sizeBytes);
  assert.equal(view.models.length, 2);
  assert.equal(view.models.every((model) => model.installed === false), true);
  assert.equal(view.models.find((model) => model.role === 'chat').path.endsWith(chatEntry.file), true);
  assert.deepEqual(view.notices, ['gpu-probe-empty', 'no-gpu', 'context-capped']);
  assert.deepEqual(view.start, { available: false, reason: 'not-ready' });
  assert.deepEqual(view.steps.map((step) => step.id), ['check', 'models', 'download', 'runtime']);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.models), true);
  assert.equal(Object.isFrozen(view.notices), true);
});

test('a ready machine exposes the start plan once the binary and both models are present', async (t) => {
  const root = tempRoot(t);
  const runtime = runtimeFile(root);
  const gpu = {
    name: 'NVIDIA GeForce RTX 4070',
    vendor: 'nvidia',
    kind: 'discrete',
    memoryBytes: 12 * GIB,
  };
  const wizardInstance = wizard(t, {
    root,
    options: {
      probe: probe(hardware({ gpus: [gpu] })),
      verifyModel: async () => ({ verified: true }),
      runtimePath: runtime,
    },
  });
  const view = await wizardInstance.refresh();
  assert.equal(view.phase, 'ready');
  assert.equal(view.verdict, 'ready');
  assert.equal(view.acceleration, 'gpu');
  assert.equal(view.downloadBytes, 0);
  assert.deepEqual(view.start, {
    available: true,
    kind: 'llama-server',
    executablePath: runtime,
    modelPath: path.join(root, 'models', chatEntry.file),
    embeddingModelPath: path.join(root, 'models', embeddingEntry.file),
    contextSize: 8192,
    threads: 6,
    gpuLayers: 999,
    restart: {
      maxRestarts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      stableMs: 60000,
    },
  });
  assert.deepEqual(wizardInstance.startPlan(), view.start);
  assert.equal(Object.isFrozen(view.start), true);
});

test('startPlan waits for the models and reports a missing bundled binary', async (t) => {
  const root = tempRoot(t);
  const wizardInstance = wizard(t, {
    root,
    options: {
      probe: probe(hardware({ gpus: [] }, [])),
      verifyModel: async () => ({ verified: true }),
    },
  });
  assert.deepEqual(wizardInstance.startPlan(), { available: false, reason: 'not-ready' });
  const view = await wizardInstance.refresh();
  assert.equal(view.phase, 'ready');
  assert.deepEqual(wizardInstance.startPlan(), { available: false, reason: 'runtime-not-bundled' });
});

test('install downloads only missing models chat first, reports progress and verifies each file', async (t) => {
  const root = tempRoot(t);
  const installed = new Set();
  const calls = [];
  const progress = [];
  const wizardInstance = wizard(t, {
    root,
    options: {
      downloadModel: async (entry, options) => {
        calls.push({ id: entry.id, destinationDir: options.destinationDir });
        options.onProgress({ received: 25, total: entry.sizeBytes });
        installed.add(entry.id);
        return { verified: true };
      },
      verifyModel: async (entry) => ({ verified: installed.has(entry.id) }),
      onChange: (view) => progress.push(view.progress && view.progress.modelId),
    },
  });
  const first = await wizardInstance.refresh();
  assert.equal(first.phase, 'needs-download');

  const result = await wizardInstance.install();
  assert.deepEqual(result, { ok: true, installed: 2 });
  assert.deepEqual(calls.map((call) => call.id), [chatEntry.id, embeddingEntry.id]);
  assert.equal(calls.every((call) => call.destinationDir === path.join(root, 'models')), true);
  assert.equal(progress.some((id) => id === chatEntry.id), true);
  assert.equal(progress.some((id) => id === embeddingEntry.id), true);

  const view = wizardInstance.view();
  assert.equal(view.phase, 'ready');
  assert.equal(view.downloadBytes, 0);
  assert.equal(view.models.every((model) => model.installed), true);

  const again = await wizardInstance.install();
  assert.deepEqual(again, { ok: true, installed: 0, reason: 'already-installed' });
  assert.equal(calls.length, 2);
});

test('install refuses an insufficient machine without downloading anything', async (t) => {
  const root = tempRoot(t);
  let downloads = 0;
  const wizardInstance = wizard(t, {
    root,
    options: {
      probe: probe(hardware({ totalMemoryBytes: 4 * GIB, freeMemoryBytes: 2 * GIB })),
      downloadModel: async () => { downloads += 1; return { verified: true }; },
    },
  });
  const view = await wizardInstance.refresh();
  assert.equal(view.phase, 'insufficient');
  assert.equal(view.verdict, 'insufficient');
  assert.deepEqual(await wizardInstance.install(), { ok: false, reason: 'insufficient' });
  assert.equal(downloads, 0);
});

test('a failed download keeps installed files and a retry finishes the remaining models', async (t) => {
  const root = tempRoot(t);
  const installed = new Set();
  let failNext = true;
  const wizardInstance = wizard(t, {
    root,
    options: {
      downloadModel: async (entry) => {
        if (failNext) {
          failNext = false;
          const error = new Error('C:\\secret\\path and a response body');
          error.code = 'checksum-mismatch';
          throw error;
        }
        installed.add(entry.id);
        return { verified: true };
      },
      verifyModel: async (entry) => ({ verified: installed.has(entry.id) }),
    },
  });
  await wizardInstance.refresh();
  const failed = await wizardInstance.install();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'checksum-mismatch');
  const afterFailure = wizardInstance.view();
  assert.equal(afterFailure.phase, 'failed');
  assert.equal(afterFailure.error.code, 'checksum-mismatch');
  assert.equal(JSON.stringify(afterFailure).includes('secret'), false);
  assert.equal(JSON.stringify(afterFailure).includes('response body'), false);

  const retried = await wizardInstance.install();
  assert.deepEqual(retried, { ok: true, installed: 2 });
  assert.equal(wizardInstance.view().phase, 'ready');
});

test('install is single-flight and an abort keeps a resumable state', async (t) => {
  const root = tempRoot(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const installed = new Set();
  const wizardInstance = wizard(t, {
    root,
    options: {
      downloadModel: async (entry) => {
        await gate;
        installed.add(entry.id);
        return { verified: true };
      },
      verifyModel: async (entry) => ({ verified: installed.has(entry.id) }),
    },
  });
  await wizardInstance.refresh();
  const running = wizardInstance.install();
  assert.deepEqual(await wizardInstance.install(), { ok: false, reason: 'busy' });
  release();
  assert.deepEqual(await running, { ok: true, installed: 2 });

  const controller = new AbortController();
  controller.abort();
  const wizard2 = wizard(t, { root: tempRoot(t) });
  await wizard2.refresh();
  const aborted = await wizard2.install({ signal: controller.signal });
  assert.deepEqual(aborted, { ok: false, code: 'aborted' });
  assert.equal(wizard2.view().phase, 'needs-download');
});

test('a probe failure fails closed with a safe code and no partial plan', async (t) => {
  const root = tempRoot(t);
  const wizardInstance = wizard(t, {
    root,
    options: {
      probe: async () => { throw new Error('powershell said: C:\\Users\\me\\secret'); },
    },
  });
  const view = await wizardInstance.refresh();
  assert.equal(view.phase, 'failed');
  assert.equal(view.error.code, 'probe-failed');
  assert.equal(JSON.stringify(view).includes('secret'), false);
  assert.equal(view.models.length, 0);
  assert.deepEqual(view.start, { available: false, reason: 'not-ready' });

  const malformed = wizard(t, {
    root: tempRoot(t),
    options: { probe: async () => ({ hardware: hardware(), notices: [{ get: 1 }] }) },
  });
  const malformedView = await malformed.refresh();
  assert.equal(malformedView.error.code, 'probe-failed');

  const unsupported = wizard(t, {
    root: tempRoot(t),
    options: { probe: async () => ({ hardware: { platform: 'win32' }, notices: [] }) },
  });
  const unsupportedView = await unsupported.refresh();
  assert.equal(unsupportedView.error.code, 'unsupported-hardware');
});

test('a verification error is reported as a notice and never breaks refresh', async (t) => {
  const root = tempRoot(t);
  const wizardInstance = wizard(t, {
    root,
    options: { verifyModel: async () => { throw new Error('cannot read'); } },
  });
  const view = await wizardInstance.refresh();
  assert.equal(view.phase, 'needs-download');
  assert.equal(view.notices.includes('verify-failed'), true);
  assert.equal(view.error, null);
});

test('invalid options and catalogs fail closed without invoking an accessor', () => {
  assert.throws(() => createFirstRunWizard(), (error) => {
    assert.equal(error instanceof FirstRunError, true);
    assert.equal(error.code, 'invalid-options');
    return true;
  });
  const base = { catalog, destinationDir: path.join(os.tmpdir(), 'vibe-models') };
  assert.throws(() => createFirstRunWizard({ ...base, extra: true }), { code: 'invalid-options' });
  assert.throws(() => createFirstRunWizard({ ...base, destinationDir: 'relative' }), { code: 'invalid-options' });
  const traversal = process.platform === 'win32' ? 'C:\\a\\..\\b' : '/tmp/a/../b';
  assert.throws(() => createFirstRunWizard({ ...base, destinationDir: traversal }), {
    code: 'invalid-options',
  });
  assert.throws(() => createFirstRunWizard({ ...base, probe: 'no' }), { code: 'invalid-options' });
  assert.throws(() => createFirstRunWizard({ ...base, runtimePath: 'relative.exe' }), { code: 'invalid-options' });
  assert.throws(() => createFirstRunWizard({ ...base, catalog: { version: 9 } }), { code: 'invalid-catalog' });

  let invoked = false;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'probe', {
    enumerable: true,
    get() { invoked = true; return async () => ({}); },
  });
  assert.throws(() => createFirstRunWizard(accessor), { code: 'invalid-options' });
  assert.equal(invoked, false);

  const proxied = new Proxy({ ...base }, {});
  assert.throws(() => createFirstRunWizard(proxied), { code: 'invalid-options' });
  assert.equal(Object.isFrozen(createFirstRunWizard(base)), true);
});

test('install fails closed when a downloaded file does not verify', async (t) => {
  const root = tempRoot(t);
  let downloads = 0;
  const wizardInstance = wizard(t, {
    root,
    options: {
      downloadModel: async () => { downloads += 1; return { verified: true }; },
      verifyModel: async () => ({ verified: false }),
    },
  });
  await wizardInstance.refresh();
  assert.equal(wizardInstance.view().phase, 'needs-download');

  const result = await wizardInstance.install();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'install-not-verified');
  assert.equal(downloads, 1);
  const view = wizardInstance.view();
  assert.equal(view.phase, 'failed');
  assert.equal(view.error.code, 'install-not-verified');
  assert.equal(view.models.every((model) => model.installed === false), true);
  assert.equal(JSON.stringify(view).includes('did not verify'), false);
});

test('an abort during a download returns aborted and keeps a resumable state', async (t) => {
  const root = tempRoot(t);
  const controller = new AbortController();
  let calls = 0;
  const wizardInstance = wizard(t, {
    root,
    options: {
      downloadModel: async () => {
        calls += 1;
        controller.abort();
        const error = new Error('transfer aborted');
        error.code = 'aborted';
        throw error;
      },
    },
  });
  await wizardInstance.refresh();
  const result = await wizardInstance.install({ signal: controller.signal });
  assert.deepEqual(result, { ok: false, code: 'aborted' });
  assert.equal(calls, 1);
  const view = wizardInstance.view();
  assert.equal(view.phase, 'needs-download');
  assert.equal(view.error, null);
  assert.equal(view.models.every((model) => model.installed === false), true);
});

test('a synchronous downloader throw does not leave the wizard permanently busy', async (t) => {
  const root = tempRoot(t);
  const installed = new Set();
  let failSynchronously = true;
  const wizardInstance = wizard(t, {
    root,
    options: {
      downloadModel: (entry) => {
        if (failSynchronously) {
          failSynchronously = false;
          throw new Error('sync failure');
        }
        installed.add(entry.id);
        return Promise.resolve({ verified: true });
      },
      verifyModel: async (entry) => ({ verified: installed.has(entry.id) }),
    },
  });
  await wizardInstance.refresh();
  const failed = await wizardInstance.install();
  assert.deepEqual(failed, { ok: false, code: 'install-failed' });
  const retried = await wizardInstance.install();
  assert.deepEqual(retried, { ok: true, installed: 2 });
});

test('a throwing change callback cannot break an install, and dispose is safe', async (t) => {
  const root = tempRoot(t);
  const installed = new Set();
  const wizardInstance = wizard(t, {
    root,
    options: {
      onChange: () => { throw new Error('display failed'); },
      downloadModel: async (entry) => { installed.add(entry.id); return { verified: true }; },
      verifyModel: async (entry) => ({ verified: installed.has(entry.id) }),
    },
  });
  await wizardInstance.refresh();
  assert.deepEqual(await wizardInstance.install(), { ok: true, installed: 2 });
  assert.doesNotThrow(() => wizardInstance.dispose());
  assert.equal(wizardInstance.view().disposed, true);
  assert.deepEqual(await wizardInstance.install(), { ok: false, reason: 'disposed' });
});
