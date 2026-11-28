import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFirstRunWizard } from '../../src/stable/runtime/first-run.mjs';
import { SidecarError } from '../../src/stable/runtime/sidecar.mjs';

const GIB = 1024 * 1024 * 1024;
const PLATFORM_KEY = 'win32-x64';
const catalog = JSON.parse(readFileSync(new URL('../../vibe/models/catalog.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../vibe/sidecars.json', import.meta.url), 'utf8'));
const chatEntry = catalog.models.find((model) => model.role === 'chat');
const embeddingEntry = catalog.models.find((model) => model.role === 'embedding');
const sidecarEntry = manifest.sidecars[0];
const sidecarTarget = sidecarEntry.targets[PLATFORM_KEY];
const sidecarBytes = sidecarTarget.sizeBytes;

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
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'vibe-first-run-sidecar-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Creates the executable a successful sidecar install would leave on disk, so the wizard's own
// supervisor-path validator (a real filesystem check) accepts it.
function writeSidecarExecutable(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const file = path.join(targetDir, sidecarTarget.executable);
  writeFileSync(file, 'fake llama-server');
  if (process.platform !== 'win32') chmodSync(file, 0o755);
  return file;
}

function sidecarResult(targetDir, overrides = {}) {
  return {
    verified: true,
    installed: true,
    skipped: false,
    executablePath: writeSidecarExecutable(targetDir),
    version: sidecarEntry.version,
    files: [],
    sizeBytes: sidecarBytes,
    ...overrides,
  };
}

function fakeInstaller(options = {}) {
  const calls = [];
  return {
    calls,
    install: async (sidecar, installOptions) => {
      calls.push({ sidecar, installOptions });
      if (options.onCall !== undefined) await options.onCall(installOptions, calls.length);
      if (options.error !== undefined) throw options.error;
      if (options.result !== undefined) return options.result;
      return sidecarResult(installOptions.targetDir);
    },
  };
}

function sidecarConfig(root, overrides = {}) {
  return {
    manifest,
    platformKey: PLATFORM_KEY,
    targetDir: path.join(root, 'runtime'),
    ...overrides,
  };
}

function makeWizard(t, overrides = {}) {
  const root = overrides.root ?? tempRoot(t);
  const options = {
    catalog,
    destinationDir: path.join(root, 'models'),
    probe: async () => ({ hardware: hardware(), notices: [] }),
    verifyModel: async () => ({ verified: true }),
    ...overrides.options,
  };
  return { root, wizard: createFirstRunWizard(options) };
}

test('start reports runtime-not-bundled without a sidecar and never installs', async (t) => {
  const install = fakeInstaller();
  const { wizard } = makeWizard(t, { options: { installSidecar: install.install } });
  await wizard.refresh();
  assert.deepEqual(await wizard.start(), { available: false, reason: 'runtime-not-bundled' });
  assert.deepEqual(wizard.startPlan(), { available: false, reason: 'runtime-not-bundled' });
  assert.equal(install.calls.length, 0);
  assert.equal(wizard.view().runtime.configured, false);
  assert.equal(wizard.view().runtime.installed, false);
});

test('the start action installs the pinned sidecar once and returns the pinned plan', async (t) => {
  const root = tempRoot(t);
  const targetDir = path.join(root, 'runtime');
  const install = fakeInstaller();
  const { wizard } = makeWizard(t, {
    root,
    options: {
      sidecar: sidecarConfig(root, { targetDir }),
      installSidecar: install.install,
    },
  });
  const before = await wizard.refresh();
  assert.equal(before.phase, 'ready');
  assert.deepEqual(before.start, { available: false, reason: 'runtime-not-bundled' });
  assert.deepEqual(before.runtime, { configured: true, installed: false, version: null, progress: null });
  assert.equal(before.steps.find((step) => step.id === 'runtime').status, 'pending');

  const plan = await wizard.start();
  assert.equal(install.calls.length, 1);
  assert.equal(install.calls[0].installOptions.targetDir, targetDir);
  assert.equal(install.calls[0].installOptions.platformKey, PLATFORM_KEY);
  const executable = path.join(targetDir, sidecarTarget.executable);
  assert.deepEqual(plan, {
    available: true,
    kind: 'llama-server',
    executablePath: executable,
    modelPath: path.join(root, 'models', chatEntry.file),
    model: chatEntry.id,
    embeddingModelPath: path.join(root, 'models', embeddingEntry.file),
    contextSize: 8192,
    threads: 6,
    gpuLayers: 0,
    restart: { maxRestarts: 3, baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000 },
  });
  assert.equal(Object.isFrozen(plan), true);

  const after = wizard.view();
  assert.equal(after.runtime.installed, true);
  assert.equal(after.runtime.version, sidecarEntry.version);
  assert.equal(after.runtime.progress, null);
  assert.equal(after.steps.find((step) => step.id === 'runtime').status, 'ready');
  assert.deepEqual(wizard.startPlan(), plan);
  assert.deepEqual(wizard.runtimeOptions().options.executablePath, executable);

  // A second start reuses the validated runtime and never calls the installer again.
  assert.deepEqual(await wizard.start(), plan);
  assert.equal(install.calls.length, 1);
});

test('the start action uses the default runtime directory under the model directory', async (t) => {
  const root = tempRoot(t);
  const install = fakeInstaller();
  const { wizard } = makeWizard(t, {
    root,
    options: {
      sidecar: { manifest, platformKey: PLATFORM_KEY },
      installSidecar: install.install,
    },
  });
  await wizard.refresh();
  const plan = await wizard.start();
  assert.equal(plan.available, true);
  assert.equal(install.calls[0].installOptions.targetDir, path.join(root, 'models', 'runtime'));
});

test('a failed sidecar install is bounded and a retry can succeed', async (t) => {
  const root = tempRoot(t);
  let attempt = 0;
  const install = fakeInstaller({
    onCall: async (installOptions) => {
      attempt += 1;
      if (attempt === 1) throw new SidecarError('checksum-mismatch', 'the downloaded archive did not match');
    },
  });
  const { wizard } = makeWizard(t, {
    root,
    options: { sidecar: sidecarConfig(root), installSidecar: install.install },
  });
  await wizard.refresh();
  const failed = await wizard.start();
  assert.equal(failed.available, false);
  assert.equal(failed.reason, 'runtime-install-failed');
  assert.equal(failed.code, 'checksum-mismatch');
  assert.deepEqual(wizard.startPlan(), { available: false, reason: 'runtime-not-bundled' });
  assert.equal(wizard.view().runtime.installed, false);
  assert.equal(wizard.view().runtime.progress, null);

  const ok = await wizard.start();
  assert.equal(ok.available, true);
  assert.equal(wizard.view().runtime.installed, true);
  assert.equal(install.calls.length, 2);
});

test('an aborted start propagates the signal, reports a bounded failure and a retry can succeed', async (t) => {
  const root = tempRoot(t);
  const controller = new AbortController();
  const signals = [];
  let attempt = 0;
  const { wizard } = makeWizard(t, {
    root,
    options: {
      sidecar: sidecarConfig(root),
      installSidecar: async (sidecar, installOptions) => {
        signals.push(installOptions.signal);
        attempt += 1;
        if (attempt === 1) {
          assert.equal(installOptions.signal.aborted, false);
          controller.abort();
          assert.equal(installOptions.signal.aborted, true);
          throw new SidecarError('aborted', 'the download was cancelled');
        }
        return sidecarResult(installOptions.targetDir);
      },
    },
  });
  await wizard.refresh();
  const failed = await wizard.start({ signal: controller.signal });
  assert.deepEqual(failed, { available: false, reason: 'runtime-install-failed', code: 'aborted' });
  assert.equal(wizard.view().runtime.installed, false);
  assert.equal(wizard.view().runtime.progress, null);
  const ok = await wizard.start();
  assert.equal(ok.available, true);
  assert.equal(signals.length, 2);
});

test('an unverified, invalid or hostile installer result fails closed without a path echo', async (t) => {
  const cases = [
    { result: { verified: false, executablePath: 'C:/secret/llama-server.exe' }, code: 'runtime-install-failed' },
    { result: { verified: true, executablePath: 'relative/llama-server.exe' }, code: 'invalid-executable' },
    { result: { verified: true }, code: 'runtime-install-failed' },
    { result: new Proxy({}, { get() { throw new Error('trap'); } }), code: 'runtime-install-failed' },
  ];
  for (const entry of cases) {
    const root = tempRoot(t);
    const { wizard } = makeWizard(t, {
      root,
      options: { sidecar: sidecarConfig(root), installSidecar: async () => entry.result },
    });
    await wizard.refresh();
    const failed = await wizard.start();
    assert.equal(failed.available, false);
    assert.equal(failed.reason, 'runtime-install-failed');
    assert.equal(failed.code, entry.code);
    assert.equal(wizard.view().runtime.installed, false);
    assert.equal(JSON.stringify(failed).includes('secret'), false);
  }
});

test('an accessor-backed installer result is never invoked', async (t) => {
  const root = tempRoot(t);
  let invoked = false;
  const hostile = { verified: true };
  Object.defineProperty(hostile, 'executablePath', {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error('getter');
    },
  });
  const { wizard } = makeWizard(t, {
    root,
    options: { sidecar: sidecarConfig(root), installSidecar: async () => hostile },
  });
  await wizard.refresh();
  const failed = await wizard.start();
  assert.equal(failed.reason, 'runtime-install-failed');
  assert.equal(invoked, false);
});

test('start does not install while the models are missing or the machine is insufficient', async (t) => {
  const missingRoot = tempRoot(t);
  const missingInstall = fakeInstaller();
  const missing = makeWizard(t, {
    root: missingRoot,
    options: {
      verifyModel: async () => ({ verified: false }),
      sidecar: sidecarConfig(missingRoot),
      installSidecar: missingInstall.install,
    },
  }).wizard;
  await missing.refresh();
  assert.equal(missing.view().phase, 'needs-download');
  assert.deepEqual(await missing.start(), { available: false, reason: 'not-ready' });
  assert.equal(missingInstall.calls.length, 0);

  const lowRoot = tempRoot(t);
  const lowInstall = fakeInstaller();
  const low = makeWizard(t, {
    root: lowRoot,
    options: {
      probe: async () => ({ hardware: hardware({ totalMemoryBytes: 4 * GIB, freeMemoryBytes: 2 * GIB }), notices: [] }),
      sidecar: sidecarConfig(lowRoot),
      installSidecar: lowInstall.install,
    },
  }).wizard;
  await low.refresh();
  assert.equal(low.view().phase, 'insufficient');
  assert.deepEqual(await low.start(), { available: false, reason: 'insufficient' });
  assert.equal(lowInstall.calls.length, 0);
});

test('refresh adopts an already installed runtime without a download', async (t) => {
  const root = tempRoot(t);
  const targetDir = path.join(root, 'runtime');
  const file = writeSidecarExecutable(targetDir);
  const verifyCalls = [];
  const install = fakeInstaller();
  const { wizard } = makeWizard(t, {
    root,
    options: {
      sidecar: sidecarConfig(root, { targetDir }),
      verifySidecar: async (sidecar, options) => {
        verifyCalls.push({ sidecar, options });
        return { verified: true, executablePath: file, version: sidecarEntry.version };
      },
      installSidecar: install.install,
    },
  });
  const view = await wizard.refresh();
  assert.equal(verifyCalls.length, 1);
  assert.equal(verifyCalls[0].options.targetDir, targetDir);
  assert.equal(verifyCalls[0].options.platformKey, PLATFORM_KEY);
  assert.equal(view.phase, 'ready');
  assert.equal(view.runtime.installed, true);
  assert.equal(view.runtime.version, sidecarEntry.version);
  assert.equal(view.steps.find((step) => step.id === 'runtime').status, 'ready');
  const plan = await wizard.start();
  assert.equal(plan.available, true);
  assert.equal(plan.executablePath, file);
  assert.equal(install.calls.length, 0);
});

test('an offline verification failure or a hostile verifier never breaks refresh', async (t) => {
  const thrower = makeWizard(t, {
    options: {
      sidecar: sidecarConfig(tempRoot(t)),
      verifySidecar: async () => { throw new Error('unreadable'); },
      installSidecar: fakeInstaller().install,
    },
  }).wizard;
  const thrown = await thrower.refresh();
  assert.equal(thrown.phase, 'ready');
  assert.equal(thrown.runtime.installed, false);
  assert.deepEqual(thrown.start, { available: false, reason: 'runtime-not-bundled' });

  const root = tempRoot(t);
  const hostile = makeWizard(t, {
    root,
    options: {
      sidecar: sidecarConfig(root),
      verifySidecar: async () => new Proxy({}, { get() { throw new Error('trap'); } }),
      installSidecar: fakeInstaller().install,
    },
  }).wizard;
  const view = await hostile.refresh();
  assert.equal(view.phase, 'ready');
  assert.equal(view.runtime.installed, false);
});

test('the installer progress is clamped and exposed until the runtime is ready', async (t) => {
  const root = tempRoot(t);
  const seen = [];
  const { wizard } = makeWizard(t, {
    root,
    options: {
      sidecar: sidecarConfig(root),
      onChange: (view) => {
        if (view.runtime !== null && view.runtime.progress !== null) seen.push(view.runtime.progress);
      },
      installSidecar: async (sidecar, installOptions) => {
        installOptions.onProgress({ received: 10, total: 999 });
        installOptions.onProgress({ received: sidecarBytes * 4, total: 1 });
        return sidecarResult(installOptions.targetDir);
      },
    },
  });
  await wizard.refresh();
  const plan = await wizard.start();
  assert.equal(plan.available, true);
  assert.deepEqual(seen[0], { received: 10, total: sidecarBytes, fraction: 10 / sidecarBytes });
  assert.deepEqual(seen[1], { received: sidecarBytes, total: sidecarBytes, fraction: 1 });
  assert.equal(wizard.view().runtime.progress, null);
});

test('start is refused while a model download runs and after disposal', async (t) => {
  const root = tempRoot(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const install = fakeInstaller();
  const { wizard } = makeWizard(t, {
    root,
    options: {
      verifyModel: async () => ({ verified: false }),
      downloadModel: async () => { await gate; return { verified: true }; },
      sidecar: sidecarConfig(root),
      installSidecar: install.install,
    },
  });
  await wizard.refresh();
  const pending = wizard.install();
  assert.deepEqual(await wizard.start(), { available: false, reason: 'busy' });
  release();
  await pending;
  assert.equal(install.calls.length, 0);

  wizard.dispose();
  assert.deepEqual(await wizard.start(), { available: false, reason: 'disposed' });
});

test('a daemon-selected wizard returns the Ollama plan and never installs a sidecar', async (t) => {
  const root = tempRoot(t);
  const install = fakeInstaller();
  const { wizard } = makeWizard(t, {
    root,
    options: {
      sidecar: sidecarConfig(root),
      installSidecar: install.install,
      discoverOllama: async () => ({
        version: 1,
        available: true,
        reason: null,
        status: 200,
        port: 11434,
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          { id: 'qwen2.5-coder:7b', sizeBytes: 1024, embedding: false, remote: false },
          { id: 'nomic-embed-text:latest', sizeBytes: 1024, embedding: true, remote: false },
        ],
        chatModel: 'qwen2.5-coder:7b',
        embeddingModel: 'nomic-embed-text:latest',
        notices: [],
      }),
    },
  });
  await wizard.refresh();
  await wizard.checkOllama();
  assert.equal(wizard.useOllama().ok, true);
  const plan = await wizard.start();
  assert.deepEqual(plan, {
    available: true,
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:7b',
    embeddingModel: 'nomic-embed-text:latest',
  });
  assert.equal(install.calls.length, 0);
});

test('invalid sidecar options fail closed without invoking an accessor', (t) => {
  const root = tempRoot(t);
  const base = {
    catalog,
    destinationDir: path.join(root, 'models'),
    verifyModel: async () => ({ verified: true }),
  };
  const bad = (options, code) => {
    assert.throws(() => createFirstRunWizard({ ...base, ...options }), { code });
  };
  let invoked = false;
  const accessorBag = {};
  Object.defineProperty(accessorBag, 'manifest', {
    enumerable: true,
    get() { invoked = true; return manifest; },
  });
  bad({ sidecar: accessorBag }, 'invalid-sidecar');
  assert.equal(invoked, false);
  bad({ sidecar: new Proxy({}, { get() { throw new Error('trap'); } }) }, 'invalid-sidecar');
  bad({ sidecar: { manifest, extra: true } }, 'invalid-sidecar');
  bad({ sidecar: { manifest: { version: 2, sidecars: [] } } }, 'invalid-sidecar');
  bad({ sidecar: { manifest, id: 'missing-sidecar' } }, 'invalid-sidecar');
  bad({ sidecar: { manifest, platformKey: 'linux-arm64' } }, 'invalid-sidecar');
  bad({ sidecar: { manifest, platformKey: 'win32-x86' } }, 'invalid-sidecar');
  bad({ sidecar: { manifest, targetDir: 'relative/runtime' } }, 'invalid-sidecar');
  bad({ sidecar: { manifest, targetDir: path.join(root, 'a') + path.sep + '..' + path.sep + 'runtime' } },
    'invalid-sidecar');
  bad({ installSidecar: 'nope' }, 'invalid-options');
  bad({ verifySidecar: 'nope' }, 'invalid-options');
});

test('the shipped pin is accepted as the default sidecar configuration', (t) => {
  const root = tempRoot(t);
  const wizard = createFirstRunWizard({
    catalog,
    destinationDir: path.join(root, 'models'),
    sidecar: { manifest, platformKey: PLATFORM_KEY },
  });
  assert.equal(wizard.view().runtime.configured, true);
  assert.equal(wizard.view().runtime.installed, false);
});

test('a concurrent second start shares the in-flight install and returns the same plan', async (t) => {
  const root = tempRoot(t);
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { wizard } = makeWizard(t, {
    root,
    options: {
      sidecar: sidecarConfig(root),
      installSidecar: async (sidecar, installOptions) => {
        calls.push(installOptions);
        await gate;
        return sidecarResult(installOptions.targetDir);
      },
    },
  });
  await wizard.refresh();
  const first = wizard.start();
  const second = wizard.start();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(a.available, true);
  assert.equal(a, b);
  assert.equal(Object.isFrozen(a), true);
  assert.deepEqual(a, wizard.startPlan());
});
