// Acceptance test for the M3 first-run runtime install hand-off.
//
// The wizard adopts an installed llama-server only after the delivered sidecar installer reports
// verified files and the supervisor validator accepts the executable. Every effect is injected; no
// test downloads, extracts, starts a process or opens a socket.

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FirstRunError, createFirstRunWizard } from '../../src/stable/runtime/first-run.mjs';
import { findSidecar, loadSidecarManifestFile } from '../../src/stable/runtime/sidecar.mjs';

const GIB = 1024 * 1024 * 1024;
const catalog = JSON.parse(readFileSync(new URL('../../vibe/models/catalog.json', import.meta.url), 'utf8'));
const sidecar = findSidecar(
  loadSidecarManifestFile(new URL('../../vibe/sidecars.json', import.meta.url)),
  'llama-server',
);

function hardware() {
  return {
    platform: 'win32',
    arch: 'x64',
    cpu: { model: 'Unit Test CPU', logicalCores: 8 },
    totalMemoryBytes: 32 * GIB,
    freeMemoryBytes: 16 * GIB,
    gpus: [],
  };
}

function tempRoot(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'vibe-first-run-sidecar-')));
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

function wizard(t, options = {}) {
  const { root = tempRoot(t), ...rest } = options;
  return createFirstRunWizard({
    catalog,
    destinationDir: path.join(root, 'models'),
    probe: async () => ({ hardware: hardware(), notices: [] }),
    verifyModel: async () => ({ verified: true }),
    ...rest,
  });
}

function installedSummary(root) {
  return {
    verified: true,
    installed: true,
    skipped: false,
    executablePath: runtimeFile(root),
    version: '1.2.3',
    sizeBytes: 25_000_000,
    files: [],
  };
}

async function ready(wiz) {
  await wiz.refresh();
  return wiz;
}

test('without an installer the wizard reports the runtime as blocked and refuses to install it', async (t) => {
  const wiz = await ready(wizard(t));
  assert.equal(wiz.view().runtime, null);
  const steps = wiz.view().steps;
  assert.equal(steps.find((step) => step.id === 'runtime').status, 'blocked');
  assert.deepEqual(await wiz.installRuntime(), { ok: false, reason: 'runtime-not-configurable' });
  assert.equal(wiz.view().start.reason, 'runtime-not-bundled');
});

test('the installer options are read through descriptors and fail closed before the probe', async (t) => {
  let probes = 0;
  const options = {
    catalog,
    destinationDir: path.join(tempRoot(t), 'models'),
    probe: async () => {
      probes += 1;
      return { hardware: hardware(), notices: [] };
    },
    verifyModel: async () => ({ verified: true }),
  };
  let reads = 0;
  const accessed = Object.assign({}, options);
  Object.defineProperty(accessed, 'installRuntime', {
    get() {
      reads += 1;
      return async () => installedSummary(tempRoot(t));
    },
    enumerable: true,
    configurable: true,
  });
  assert.throws(() => createFirstRunWizard(accessed), (error) => error.code === 'invalid-options');
  assert.equal(reads, 0);
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, options, { installRuntime: 'nope' })),
    (error) => error.code === 'invalid-options',
  );
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, options, { installRuntime: async () => ({}), extra: 1 })),
    (error) => error.code === 'invalid-options',
  );
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, options, { installRuntime: async () => ({}), sidecar })),
    (error) => error.code === 'invalid-options',
  );
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, options, { sidecar })),
    (error) => error.code === 'invalid-options',
  );
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, options, { sidecarDir: tempRoot(t) })),
    (error) => error.code === 'invalid-options',
  );
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, options, { sidecar: { id: 'llama-server' }, sidecarDir: tempRoot(t) })),
    (error) => error.code === 'invalid-options',
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, options, { installRuntime: async () => { }, sidecar: revoked.proxy })),
    (error) => error.code === 'invalid-options',
  );
  assert.equal(probes, 0);
});

test('a configured pin keeps the runtime step pending instead of blocked', async (t) => {
  const root = tempRoot(t);
  // The shipped pin targets win32-x64 only, and the wizard resolves it for the host before the probe.
  // On another host `resolveSidecarTarget` rightly refuses it, so this configuration-only test (the
  // effect is never run) gives the pin a host target so the pending step is covered on every runner.
  const hostKey = process.platform + '-' + process.arch;
  const configured = hostKey === 'win32-x64'
    ? sidecar
    : { ...sidecar, targets: { [hostKey]: sidecar.targets['win32-x64'] } };
  const wiz = await ready(wizard(t, { sidecar: configured, sidecarDir: path.join(root, 'runtime'), root }));
  assert.equal(typeof wiz.installRuntime, 'function');
  const step = wiz.view().steps.find((entry) => entry.id === 'runtime');
  assert.equal(step.status, 'pending');
});

test('a successful install adopts the executable and enables the start plan', async (t) => {
  const root = tempRoot(t);
  const summary = installedSummary(root);
  let effects = 0;
  let resolveEffect;
  const gate = new Promise((resolve) => {
    resolveEffect = resolve;
  });
  const slow = wizard(t, {
    installRuntime: async () => {
      effects += 1;
      await gate;
      return summary;
    },
    root,
  });
  await slow.refresh();
  const first = slow.installRuntime();
  const second = slow.installRuntime();
  await Promise.resolve();
  assert.equal(slow.view().runtime.status, 'installing');
  assert.deepEqual(await second, { ok: false, reason: 'busy' });
  assert.equal((await slow.install()).reason, 'busy');
  resolveEffect();
  const result = await first;
  assert.equal(effects, 1);
  assert.deepEqual(result, {
    ok: true,
    installed: true,
    skipped: false,
    version: '1.2.3',
    sizeBytes: 25_000_000,
  });
  assert.equal('executablePath' in result, false);
  const view = slow.view();
  assert.equal(view.runtime.status, 'installed');
  assert.equal(view.runtime.version, '1.2.3');
  assert.equal(view.runtime.sizeBytes, 25_000_000);
  assert.equal(view.start.available, true);
  assert.equal(view.start.executablePath, summary.executablePath);
  const options = slow.runtimeOptions();
  assert.equal(options.available, true);
  assert.equal(options.options.executablePath, summary.executablePath);
  assert.equal(view.steps.find((step) => step.id === 'runtime').status, 'ready');

  const fast = await ready(wizard(t, { installRuntime: async () => summary, root }));
  assert.equal((await fast.installRuntime()).ok, true);
  assert.equal(fast.view().runtime.status, 'installed');
});

test('a skipped install adopts the verified executable and reports it as already installed', async (t) => {
  const root = tempRoot(t);
  const summary = { ...installedSummary(root), installed: false, skipped: true };
  const wiz = await ready(wizard(t, { installRuntime: async () => summary, root }));
  assert.equal(wiz.view().runtime, null);
  const result = await wiz.installRuntime();
  assert.deepEqual(result, {
    ok: true,
    installed: false,
    skipped: true,
    version: '1.2.3',
    sizeBytes: 25_000_000,
  });
  assert.equal('executablePath' in result, false);
  const view = wiz.view();
  assert.equal(view.runtime.status, 'installed');
  assert.equal(view.runtime.installed, false);
  assert.equal(view.runtime.skipped, true);
  assert.equal(view.start.available, true);
  assert.equal(view.start.executablePath, summary.executablePath);
  assert.equal(view.steps.find((step) => step.id === 'runtime').status, 'ready');
});

test('progress is bounded and the view stays frozen while installing', async (t) => {
  const root = tempRoot(t);
  const summary = installedSummary(root);
  let emitProgress;
  let finish;
  const wiz = wizard(t, {
    installRuntime: async (context) => {
      emitProgress = context.onProgress;
      await new Promise((resolve) => {
        finish = resolve;
      });
      return summary;
    },
    root,
  });
  await wiz.refresh();
  const pending = wiz.installRuntime();
  await Promise.resolve();
  emitProgress({ received: 500, total: 100 });
  const view = wiz.view();
  assert.equal(view.runtime.status, 'installing');
  assert.equal(view.runtime.received, 100);
  assert.equal(view.runtime.total, 100);
  emitProgress({ received: Number.NaN, total: -5 });
  assert.equal(wiz.view().runtime.received, 0);
  assert.equal(wiz.view().runtime.total, null);
  finish();
  assert.equal((await pending).ok, true);
  assert.ok(Object.isFrozen(wiz.view().runtime));
});

test('a forged, malformed or non-executable result is refused without echoing it', async (t) => {
  const root = tempRoot(t);
  const good = installedSummary(root);
  const cases = [
    { ...good, verified: false },
    { ...good, installed: 'yes' },
    { ...good, executablePath: 'relative/llama-server.exe' },
    { ...good, executablePath: path.join(root, 'missing-name.exe') },
    { ...good, version: 'x'.repeat(500) },
    { ...good, sizeBytes: 1.5 },
    { ...good, skipped: 'yes' },
    { ...good, version: undefined },
    { ...good, sizeBytes: undefined },
    { ...good, extra: true },
    null,
    [],
  ];
  let reads = 0;
  const accessed = {};
  Object.defineProperty(accessed, 'verified', {
    get() {
      reads += 1;
      return true;
    },
    enumerable: true,
    configurable: true,
  });
  cases.push(accessed);
  const revoked = Proxy.revocable(good, {});
  revoked.revoke();
  cases.push(revoked.proxy);

  for (const answer of cases) {
    const wiz = await ready(wizard(t, { installRuntime: async () => answer, root }));
    const result = await wiz.installRuntime();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'install-failed');
    const view = wiz.view();
    assert.equal(view.runtime.status, 'failed');
    assert.equal(view.runtime.code, 'install-failed');
    assert.equal(view.start.available, false);
    assert.equal(view.start.reason, 'runtime-not-bundled');
    assert.equal(view.error.code, 'install-failed');
    assert.ok(!view.error.message.includes(root));
  }
  assert.equal(reads, 0);
});

test('a thrown installer is reported as one bounded code without leaking its message', async (t) => {
  const root = tempRoot(t);
  const wiz = await ready(wizard(t, {
    installRuntime: async () => {
      throw new FirstRunError('network-failed', root);
    },
    root,
  }));
  const result = await wiz.installRuntime();
  assert.deepEqual(result, { ok: false, code: 'network-failed' });
  assert.equal(wiz.view().runtime.status, 'failed');
  assert.equal(wiz.view().runtime.code, 'network-failed');
  assert.ok(!wiz.view().error.message.includes(root));

  const hostile = await ready(wizard(t, {
    installRuntime: async () => {
      throw new Error('boom ' + root + '\u0007');
    },
    root,
  }));
  assert.deepEqual(await hostile.installRuntime(), { ok: false, code: 'install-failed' });
  assert.ok(!hostile.view().error.message.includes(root));
});

test('a disposed or double-installing wizard refuses with a bounded reason', async (t) => {
  const root = tempRoot(t);
  const summary = installedSummary(root);
  let finish;
  const wiz = await ready(wizard(t, {
    installRuntime: async () => {
      await new Promise((resolve) => {
        finish = resolve;
      });
      return summary;
    },
    root,
  }));
  const fresh = await ready(wizard(t, { installRuntime: async () => summary, root }));
  assert.throws(() => fresh.installRuntime({ signal: 'nope' }), (error) => error.code === 'invalid-options');
  assert.throws(() => fresh.installRuntime({ extra: 1 }), (error) => error.code === 'invalid-options');
  const pending = wiz.installRuntime();
  assert.deepEqual(await wiz.installRuntime(), { ok: false, reason: 'busy' });
  finish();
  await pending;
  wiz.dispose();
  assert.deepEqual(await wiz.installRuntime(), { ok: false, reason: 'disposed' });
});

test('the injected effect receives only onProgress', async (t) => {
  const root = tempRoot(t);
  let keys = null;
  const wiz = await ready(wizard(t, {
    installRuntime: async (context) => {
      keys = Object.keys(context).sort();
      return installedSummary(root);
    },
    root,
  }));
  assert.equal((await wiz.installRuntime()).ok, true);
  assert.deepEqual(keys, ['onProgress']);
});

test('a model install in flight makes the runtime install busy', async (t) => {
  const root = tempRoot(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const wiz = await ready(wizard(t, {
    downloadModel: async () => {
      await gate;
      return { verified: true };
    },
    installRuntime: async () => installedSummary(root),
    root,
    verifyModel: async () => ({ verified: false }),
  }));
  assert.equal(wiz.view().phase, 'needs-download');
  const modelInstall = wiz.install();
  await Promise.resolve();
  assert.deepEqual(await wiz.installRuntime(), { ok: false, reason: 'busy' });
  release();
  await modelInstall;
  assert.equal((await wiz.installRuntime()).ok, true);
});

test('a hostile thrown effect is reported as failed and never rejects', async (t) => {
  const root = tempRoot(t);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const getter = {};
  Object.defineProperty(getter, 'code', {
    get() {
      throw new Error('getter');
    },
    enumerable: true,
  });
  for (const thrown of [revoked.proxy, getter]) {
    const wiz = await ready(wizard(t, {
      installRuntime: async () => {
        throw thrown;
      },
      root,
    }));
    assert.deepEqual(await wiz.installRuntime(), { ok: false, code: 'install-failed' });
    assert.equal(wiz.view().runtime.status, 'failed');
    assert.equal(wiz.view().runtime.code, 'install-failed');
  }
});

test('a hostile sidecar pin fails closed before the probe', async (t) => {
  let probes = 0;
  const base = {
    catalog,
    destinationDir: path.join(tempRoot(t), 'models'),
    probe: async () => {
      probes += 1;
      return { hardware: hardware(), notices: [] };
    },
    sidecarDir: path.join(tempRoot(t), 'runtime'),
    verifyModel: async () => ({ verified: true }),
  };
  let reads = 0;
  const accessed = Object.assign({}, base);
  Object.defineProperty(accessed, 'sidecar', {
    get() {
      reads += 1;
      return sidecar;
    },
    enumerable: true,
    configurable: true,
  });
  assert.throws(() => createFirstRunWizard(accessed), (error) => error.code === 'invalid-options');
  assert.equal(reads, 0);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, base, { sidecar: revoked.proxy })),
    (error) => error.code === 'invalid-options',
  );
  const trap = new Proxy({}, {
    ownKeys() {
      throw new Error('trap');
    },
    getOwnPropertyDescriptor() {
      throw new Error('trap');
    },
  });
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, base, { sidecar: trap })),
    (error) => error.code === 'invalid-options',
  );
  assert.throws(
    () => createFirstRunWizard(Object.assign({}, base, { sidecar, sidecarDir: 'relative/dir' })),
    (error) => error.code === 'invalid-options',
  );
  assert.equal(probes, 0);
});

test('a model install re-checks the guards after its idle refresh', async (t) => {
  const root = tempRoot(t);
  let probeResolve;
  const wiz = createFirstRunWizard({
    catalog,
    destinationDir: path.join(root, 'models'),
    probe: () => new Promise((resolve) => {
      probeResolve = () => resolve({ hardware: hardware(), notices: [] });
    }),
    verifyModel: async () => ({ verified: true }),
    installRuntime: async () => installedSummary(root),
  });

  const pendingModelInstall = wiz.install();
  await Promise.resolve();
  await Promise.resolve();
  const runtimeResult = await wiz.installRuntime();
  assert.deepEqual(runtimeResult, { ok: false, reason: 'busy' });
  probeResolve();
  const modelResult = await pendingModelInstall;
  assert.notEqual(modelResult.reason, 'busy');
});

test('a disposal during a runtime install leaves a terminal status', async (t) => {
  const root = tempRoot(t);
  let finish;
  const wiz = wizard(t, {
    installRuntime: async () => {
      await new Promise((resolve) => { finish = resolve; });
      return installedSummary(root);
    },
    root,
  });
  const pending = wiz.installRuntime();
  await Promise.resolve();
  assert.equal(wiz.view().runtime.status, 'installing');
  wiz.dispose();
  assert.equal(wiz.view().runtime.status, 'failed');
  assert.equal(wiz.view().runtime.code, 'disposed');
  finish();
  assert.deepEqual(await pending, { ok: false, reason: 'disposed' });
});
