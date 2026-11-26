import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FirstRunError, createFirstRunWizard } from '../../src/stable/runtime/first-run.mjs';

const GIB = 1024 * 1024 * 1024;
const catalog = JSON.parse(readFileSync(new URL('../../vibe/models/catalog.json', import.meta.url), 'utf8'));

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
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'vibe-first-run-ollama-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
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

function unavailableResult(overrides = {}) {
  return {
    version: 1,
    available: false,
    reason: 'unreachable',
    status: null,
    port: 11434,
    baseUrl: null,
    models: [],
    chatModel: null,
    embeddingModel: null,
    notices: ['ollama-unreachable'],
    ...overrides,
  };
}

function wizard(t, overrides = {}) {
  const root = overrides.root ?? tempRoot(t);
  return createFirstRunWizard({
    catalog,
    destinationDir: path.join(root, 'models'),
    probe: async () => ({ hardware: hardware(), notices: [] }),
    verifyModel: async () => ({ verified: false }),
    ...overrides.options,
  });
}

test('the wizard exposes no Ollama view until checkOllama runs', async (t) => {
  let calls = 0;
  const instance = wizard(t, {
    options: {
      discoverOllama: async () => {
        calls += 1;
        return availableResult();
      },
    },
  });
  assert.equal(instance.view().ollama, null);
  const view = await instance.refresh();
  assert.equal(view.ollama, null);
  assert.equal(calls, 0);
});

test('checkOllama returns the provider overrides and the bounded summary', async (t) => {
  let seen;
  const raw = availableResult({
    models: [
      localModel('qwen2.5-coder:7b'),
      localModel('nomic-embed-text:latest', { family: 'nomic-bert', embedding: true }),
      localModel('cloud-model:cloud', { remote: true }),
    ],
    notices: ['ollama-remote-models'],
  });
  const instance = wizard(t, {
    options: {
      discoverOllama: async function () {
        seen = arguments.length;
        return raw;
      },
    },
  });
  const summary = await instance.checkOllama();
  assert.equal(seen, 0);
  assert.deepEqual(summary, {
    checked: true,
    available: true,
    reason: null,
    baseUrl: 'http://127.0.0.1:11434/v1',
    chatModel: 'qwen2.5-coder:7b',
    embeddingModel: 'nomic-embed-text:latest',
    modelCount: 3,
    notices: ['ollama-remote-models'],
    providerOptions: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' },
  });
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.notices), true);
  assert.equal(Object.isFrozen(summary.providerOptions), true);
  assert.deepEqual(instance.view().ollama, summary);
});

test('an available daemon without a local chat model has no provider options', async (t) => {
  const instance = wizard(t, {
    options: {
      discoverOllama: async () => availableResult({
        models: [localModel('nomic-embed-text:latest', { family: 'nomic-bert', embedding: true })],
        chatModel: null,
        embeddingModel: 'nomic-embed-text:latest',
        notices: ['ollama-no-chat-model'],
      }),
    },
  });
  const summary = await instance.checkOllama();
  assert.equal(summary.available, true);
  assert.equal(summary.reason, 'no-chat-model');
  assert.equal(summary.providerOptions, null);
  assert.equal(summary.chatModel, null);
  assert.equal(summary.embeddingModel, 'nomic-embed-text:latest');
  assert.equal(summary.modelCount, 1);
  assert.deepEqual(summary.notices, ['ollama-no-chat-model']);
});

test('forged, remote-only, stale or wrong-base results never produce provider options', async (t) => {
  const cases = [
    availableResult({ baseUrl: 'http://127.0.0.1:11435/v1' }),
    availableResult({ version: 2 }),
    availableResult({ chatModel: 'cloud-model:cloud', models: [localModel('cloud-model:cloud', { remote: true })] }),
    availableResult({ chatModel: 'not-installed:latest' }),
  ];
  for (const raw of cases) {
    const instance = wizard(t, { options: { discoverOllama: async () => raw } });
    const summary = await instance.checkOllama();
    assert.equal(summary.available, true);
    assert.equal(summary.providerOptions, null);
    assert.equal(summary.reason, 'invalid-result');
    assert.equal(summary.baseUrl, null);
    assert.equal(summary.chatModel, null);
    assert.equal(JSON.stringify(summary).includes('not-installed'), false);
    assert.equal(JSON.stringify(summary).includes('11435'), false);
  }
});

test('an unavailable daemon keeps its bounded reason and notice', async (t) => {
  for (const reason of ['unreachable', 'timeout', 'http-error', 'invalid-response', 'policy-denied']) {
    const instance = wizard(t, {
      options: {
        discoverOllama: async () => unavailableResult({
          reason,
          notices: ['ollama-' + reason],
        }),
      },
    });
    const summary = await instance.checkOllama();
    assert.equal(summary.checked, true);
    assert.equal(summary.available, false);
    assert.equal(summary.reason, reason);
    assert.deepEqual(summary.notices, ['ollama-' + reason]);
    assert.equal(summary.providerOptions, null);
  }
});

test('a throwing or malformed effect fails closed without leaking or throwing', async (t) => {
  const hostile = [
    async () => { throw new Error('C:\\Users\\me\\secret and a response body'); },
    async () => null,
    async () => 'not an object',
    async () => [availableResult()],
    async () => new Proxy(availableResult(), {}),
    async () => {
      const answered = availableResult();
      Object.defineProperty(answered, 'chatModel', { enumerable: true, get() { throw new Error('getter ran'); } });
      return answered;
    },
    async () => new Proxy(availableResult(), {
      getOwnPropertyDescriptor() { throw new Error('trap ran'); },
    }),
  ];
  for (const discoverOllama of hostile) {
    const instance = wizard(t, { options: { discoverOllama } });
    const summary = await instance.checkOllama();
    assert.equal(summary.checked, true);
    assert.equal(summary.available, false);
    assert.equal(summary.providerOptions, null);
    assert.equal(summary.baseUrl, null);
    assert.equal(summary.chatModel, null);
    assert.match(summary.reason, /^(check-failed|invalid-result)$/);
    assert.equal(summary.notices.every((code) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(code)), true);
    assert.equal(JSON.stringify(summary).includes('secret'), false);
    assert.equal(JSON.stringify(summary).includes('response body'), false);
    assert.equal(JSON.stringify(summary).includes('getter ran'), false);
  }
});

test('unknown, oversized and accessor-backed fields are bounded', async (t) => {
  const raw = unavailableResult({
    reason: 'totally-made-up',
    notices: ['ollama-unreachable', 'Bad Notice', 'x'.repeat(70), { get: 1 }],
    models: 'not a list',
  });
  Object.defineProperty(raw, 'extra', { enumerable: true, value: 'ignored' });
  const instance = wizard(t, { options: { discoverOllama: async () => raw } });
  const summary = await instance.checkOllama();
  assert.equal(summary.reason, 'invalid-result');
  assert.deepEqual(summary.notices, ['ollama-unreachable']);
  assert.equal(summary.modelCount, 0);
});

test('checkOllama is single-flight and never changes the provisioning state', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const instance = wizard(t, {
    options: {
      discoverOllama: async () => {
        calls += 1;
        await gate;
        return availableResult();
      },
    },
  });
  const before = await instance.refresh();
  const first = instance.checkOllama();
  const second = instance.checkOllama();
  assert.equal(first, second);
  release();
  const summary = await first;
  assert.equal(calls, 1);
  assert.equal(summary.available, true);
  const after = instance.view();
  assert.equal(after.phase, before.phase);
  assert.deepEqual(after.models, before.models);
  assert.deepEqual(after.notices, before.notices);
  assert.deepEqual(after.start, before.start);
  assert.equal(after.progress, before.progress);
  assert.equal(after.error, before.error);

  const again = await instance.checkOllama();
  assert.equal(calls, 2);
  assert.deepEqual(again, summary);
});

test('a disposed wizard does not call the effect and reports disposed', async (t) => {
  let calls = 0;
  const instance = wizard(t, {
    options: {
      discoverOllama: async () => {
        calls += 1;
        return availableResult();
      },
    },
  });
  instance.dispose();
  const summary = await instance.checkOllama();
  assert.equal(calls, 0);
  assert.equal(summary.checked, false);
  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'disposed');
  assert.equal(summary.providerOptions, null);
  assert.deepEqual(summary.notices, []);
});

test('a disposed mid-flight check returns the summary without storing it', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const instance = wizard(t, {
    options: {
      discoverOllama: async () => {
        await gate;
        return availableResult();
      },
    },
  });
  const pending = instance.checkOllama();
  instance.dispose();
  release();
  const summary = await pending;
  assert.equal(summary.available, true);
  assert.equal(instance.view().ollama, null);
});

test('invalid discoverOllama options fail closed without invoking a getter', () => {
  const base = { catalog, destinationDir: path.join(os.tmpdir(), 'vibe-ollama-models') };
  assert.throws(() => createFirstRunWizard({ ...base, discoverOllama: 'no' }), (error) => {
    assert.equal(error instanceof FirstRunError, true);
    assert.equal(error.code, 'invalid-options');
    return true;
  });
  let invoked = false;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'discoverOllama', {
    enumerable: true,
    get() { invoked = true; return async () => availableResult(); },
  });
  assert.throws(() => createFirstRunWizard(accessor), { code: 'invalid-options' });
  assert.equal(invoked, false);
  assert.throws(() => createFirstRunWizard(new Proxy({ ...base }, {})), { code: 'invalid-options' });
  assert.throws(() => createFirstRunWizard({ ...base, extra: true }), { code: 'invalid-options' });
});

test('checkOllama never probes, downloads or mutates the plan', async (t) => {
  let probeCalls = 0;
  let downloadCalls = 0;
  const instance = wizard(t, {
    options: {
      probe: async () => {
        probeCalls += 1;
        return { hardware: hardware(), notices: [] };
      },
      downloadModel: async () => {
        downloadCalls += 1;
        return { ok: true };
      },
      discoverOllama: async () => availableResult(),
    },
  });
  const before = await instance.refresh();
  const probesAfterRefresh = probeCalls;
  const summary = await instance.checkOllama();
  assert.equal(summary.available, true);
  assert.equal(probeCalls, probesAfterRefresh);
  assert.equal(downloadCalls, 0);
  const after = instance.view();
  assert.equal(after.phase, before.phase);
  assert.deepEqual(after.models, before.models);
  assert.deepEqual(after.notices, before.notices);
  assert.deepEqual(after.start, before.start);
  assert.deepEqual(after.plan, before.plan);
  assert.equal(after.progress, before.progress);
  assert.equal(after.error, before.error);
});

test('an accessor-backed answer fails closed without invoking its getter', async (t) => {
  let invoked = false;
  const raw = availableResult();
  Object.defineProperty(raw, 'chatModel', {
    enumerable: true,
    get() { invoked = true; return 'qwen2.5-coder:7b'; },
  });
  const instance = wizard(t, { options: { discoverOllama: async () => raw } });
  const summary = await instance.checkOllama();
  assert.equal(invoked, false);
  assert.equal(summary.checked, true);
  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'invalid-result');
  assert.equal(summary.providerOptions, null);
  assert.deepEqual(summary.notices, ['ollama-invalid-response']);
});

test('a revoked Proxy answer fails closed without throwing', async (t) => {
  const revoked = Proxy.revocable(availableResult(), {});
  revoked.revoke();
  const instance = wizard(t, { options: { discoverOllama: async () => revoked.proxy } });
  const summary = await instance.checkOllama();
  assert.equal(summary.checked, true);
  assert.equal(summary.available, false);
  assert.match(summary.reason, /^(check-failed|invalid-result)$/);
  assert.equal(summary.providerOptions, null);
  assert.equal(summary.notices.length >= 1, true);
  assert.equal(summary.notices.every((code) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(code)), true);
  assert.equal(JSON.stringify(summary).includes('11434'), false);
});

test('oversized and accessor-backed notice lists are bounded without invoking getters', async (t) => {
  const many = Array.from({ length: 40 }, function (_, index) { return 'ollama-note-' + index; });
  const oversized = wizard(t, {
    options: { discoverOllama: async () => unavailableResult({ notices: many }) },
  });
  const bounded = await oversized.checkOllama();
  assert.equal(bounded.notices.length, 8);
  assert.deepEqual(bounded.notices, many.slice(0, 8));
  assert.equal(bounded.reason, 'unreachable');

  let invoked = false;
  const raw = unavailableResult();
  Object.defineProperty(raw, 'notices', {
    enumerable: true,
    get() { invoked = true; return ['ollama-unreachable']; },
  });
  const accessor = wizard(t, { options: { discoverOllama: async () => raw } });
  const summary = await accessor.checkOllama();
  assert.equal(invoked, false);
  assert.equal(summary.reason, 'unreachable');
  assert.deepEqual(summary.notices, ['ollama-unreachable']);
});

test('a disposed summary is frozen and stays out of the view', async (t) => {
  const instance = wizard(t, {
    options: { discoverOllama: async () => availableResult() },
  });
  instance.dispose();
  const summary = await instance.checkOllama();
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.notices), true);
  assert.equal(summary.reason, 'disposed');
  assert.equal(instance.view().ollama, null);
});

test('a huge notice list and a nested Proxy array are bounded without running a trap', async (t) => {
  const huge = [];
  huge.length = 1_000_000;
  huge[0] = 'ollama-unreachable';
  let trapped = false;
  const models = new Proxy([localModel('qwen2.5-coder:7b')], {
    get() { trapped = true; return undefined; },
    getOwnPropertyDescriptor() { trapped = true; return undefined; },
  });
  const notices = new Proxy(['ollama-timeout'], {
    get() { trapped = true; return undefined; },
    getOwnPropertyDescriptor() { trapped = true; return undefined; },
  });
  const instance = wizard(t, {
    options: {
      discoverOllama: async () => unavailableResult({ notices, models }),
    },
  });
  const started = Date.now();
  const summary = await instance.checkOllama();
  assert.deepEqual(summary.notices, ['ollama-unreachable']);
  assert.equal(summary.modelCount, 0);
  assert.equal(trapped, false);
  assert.equal(Date.now() - started < 1_000, true);

  const hugeInstance = wizard(t, {
    options: { discoverOllama: async () => unavailableResult({ notices: huge, models: [] }) },
  });
  const hugeSummary = await hugeInstance.checkOllama();
  assert.deepEqual(hugeSummary.notices, ['ollama-unreachable']);
  assert.equal(hugeSummary.modelCount, 0);
});

test('useOllama selects a discovered daemon and usePinned restores the pinned phase', async (t) => {
  let downloads = 0;
  const instance = wizard(t, {
    options: {
      discoverOllama: async () => availableResult(),
      downloadModel: async () => { downloads += 1; return { verified: true }; },
    },
  });
  assert.deepEqual(instance.useOllama(), { ok: false, reason: 'not-ready' });
  const view = await instance.refresh();
  assert.equal(view.phase, 'needs-download');
  assert.equal(view.source, 'pinned');
  assert.deepEqual(instance.useOllama(), { ok: false, reason: 'not-checked' });

  const summary = await instance.checkOllama();
  assert.deepEqual(instance.useOllama(), { ok: true, source: 'ollama' });
  const using = instance.view();
  assert.equal(using.source, 'ollama');
  assert.equal(using.phase, 'ready');
  assert.deepEqual(using.start, {
    available: true,
    kind: 'ollama',
    baseUrl: summary.baseUrl,
    model: summary.chatModel,
    embeddingModel: summary.embeddingModel,
  });
  assert.equal(Object.isFrozen(using.start), true);
  assert.deepEqual(instance.startPlan(), using.start);
  assert.deepEqual(await instance.install(), { ok: true, installed: 0, reason: 'ollama-selected' });
  assert.equal(downloads, 0);

  assert.deepEqual(instance.usePinned(), { ok: true, source: 'pinned' });
  assert.equal(instance.view().source, 'pinned');
  assert.equal(instance.view().phase, 'needs-download');
  assert.deepEqual(instance.startPlan(), { available: false, reason: 'not-ready' });
});

test('a daemon selection makes an insufficient machine ready and is released when it disappears', async (t) => {
  let result = availableResult();
  const instance = wizard(t, {
    options: {
      probe: async () => ({
        hardware: hardware({ totalMemoryBytes: 4 * GIB, freeMemoryBytes: 2 * GIB }),
        notices: [],
      }),
      discoverOllama: async () => result,
    },
  });
  const view = await instance.refresh();
  assert.equal(view.verdict, 'insufficient');
  await instance.checkOllama();
  assert.deepEqual(instance.useOllama(), { ok: true, source: 'ollama' });
  assert.equal(instance.view().phase, 'ready');
  assert.deepEqual(await instance.install(), { ok: true, installed: 0, reason: 'ollama-selected' });

  result = unavailableResult({ reason: 'unreachable', notices: ['ollama-unreachable'] });
  await instance.checkOllama();
  const released = instance.view();
  assert.equal(released.source, 'pinned');
  assert.equal(released.phase, 'insufficient');
  assert.deepEqual(instance.startPlan(), { available: false, reason: 'not-ready' });
  assert.deepEqual(instance.useOllama(), { ok: false, reason: 'ollama-unavailable' });
  assert.deepEqual(instance.usePinned(), { ok: true, source: 'pinned' });
  assert.equal(instance.view().source, 'pinned');
});

test('the daemon controls refuse a chat-less daemon, a busy download and a disposed wizard', async (t) => {
  const noChat = wizard(t, {
    options: {
      discoverOllama: async () => availableResult({
        chatModel: null,
        models: [localModel('nomic-embed-text:latest', { family: 'nomic-bert', embedding: true })],
        embeddingModel: 'nomic-embed-text:latest',
        notices: ['ollama-no-chat-model'],
      }),
    },
  });
  await noChat.refresh();
  await noChat.checkOllama();
  assert.deepEqual(noChat.useOllama(), { ok: false, reason: 'ollama-unavailable' });
  assert.equal(noChat.view().source, 'pinned');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const installed = new Set();
  const busy = wizard(t, {
    options: {
      discoverOllama: async () => availableResult(),
      downloadModel: async (entry) => {
        await gate;
        installed.add(entry.id);
        return { verified: true };
      },
      verifyModel: async (entry) => ({ verified: installed.has(entry.id) }),
    },
  });
  await busy.refresh();
  await busy.checkOllama();
  const running = busy.install();
  assert.deepEqual(busy.useOllama(), { ok: false, reason: 'busy' });
  assert.deepEqual(busy.usePinned(), { ok: false, reason: 'busy' });
  release();
  assert.deepEqual(await running, { ok: true, installed: 2 });
  assert.equal(busy.view().source, 'pinned');

  const disposed = wizard(t, { options: { discoverOllama: async () => availableResult() } });
  await disposed.refresh();
  await disposed.checkOllama();
  disposed.dispose();
  assert.deepEqual(disposed.useOllama(), { ok: false, reason: 'disposed' });
  assert.deepEqual(disposed.usePinned(), { ok: false, reason: 'disposed' });
});

test('the daemon selection survives a refresh and returns after the daemon disappears', async (t) => {
  let result = availableResult();
  const instance = wizard(t, { options: { discoverOllama: async () => result } });
  const first = await instance.refresh();
  assert.equal(first.source, 'pinned');
  await instance.checkOllama();
  assert.deepEqual(instance.useOllama(), { ok: true, source: 'ollama' });

  const refreshed = await instance.refresh();
  assert.equal(refreshed.source, 'ollama');
  assert.equal(refreshed.phase, 'ready');
  assert.equal(refreshed.start.kind, 'ollama');
  assert.deepEqual(instance.startPlan(), refreshed.start);

  result = unavailableResult();
  await instance.checkOllama();
  assert.equal(instance.view().source, 'pinned');
  assert.equal(instance.view().phase, 'needs-download');
  assert.deepEqual(instance.useOllama(), { ok: false, reason: 'ollama-unavailable' });

  result = availableResult();
  await instance.checkOllama();
  assert.deepEqual(instance.useOllama(), { ok: true, source: 'ollama' });
  assert.equal(instance.view().source, 'ollama');
  assert.equal(instance.view().phase, 'ready');
});

test('a forged or accessor-backed discovery answer is never selectable', async (t) => {
  const forged = availableResult({ baseUrl: 'http://127.0.0.1:11435/v1' });
  const withGetter = availableResult();
  Object.defineProperty(withGetter, 'chatModel', { enumerable: true, get() { throw new Error('getter ran'); } });
  for (const raw of [forged, withGetter]) {
    const instance = wizard(t, { options: { discoverOllama: async () => raw } });
    await instance.refresh();
    const summary = await instance.checkOllama();
    assert.equal(summary.providerOptions, null);
    assert.deepEqual(instance.useOllama(), { ok: false, reason: 'ollama-unavailable' });
    assert.equal(instance.view().source, 'pinned');
  }
});

test('install does not claim the selected daemon after a failed refresh', async (t) => {
  let fail = false;
  const instance = wizard(t, {
    options: {
      probe: async () => {
        if (fail) throw new Error('probe down');
        return { hardware: hardware(), notices: [] };
      },
      discoverOllama: async () => availableResult(),
    },
  });
  await instance.refresh();
  await instance.checkOllama();
  assert.deepEqual(instance.useOllama(), { ok: true, source: 'ollama' });
  fail = true;
  const failed = await instance.refresh();
  assert.equal(failed.phase, 'failed');
  assert.deepEqual(await instance.install(), { ok: false, reason: 'no-plan' });
  assert.deepEqual(instance.startPlan(), { available: false, reason: 'not-ready' });
});
