// Acceptance tests for the nightly intake gates (ADR-0011 decision 7): the manifest loader binds every
// remote archive URL to the recorded `source` and `version`, and the intake policy, the installer and the
// `sidecar-intake` CLI enforce the seven-day public window that decision 2 used to leave to the radar review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTAKE_MIN_PUBLIC_DAYS,
  SidecarError,
  assertIntakePolicy,
  installSidecar,
  loadSidecarManifestFile,
  validateSidecarManifest,
  verifySidecarInstall,
} from '../../src/stable/runtime/sidecar.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHIPPED = path.join(ROOT, 'vibe', 'sidecars.json');
const CLI = path.join(ROOT, 'vibe', 'tools', 'sidecar-intake.mjs');
const PINNED_URL = 'https://github.com/ggml-org/llama.cpp/releases/download/b12426/llama.zip';
const BINDING_MESSAGE = 'target url is not bound to the sidecar source and version';

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-intake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sidecar({ publishedAt = '2026-11-15', url = PINNED_URL, version = 'b12426', source = 'ggml-org/llama.cpp' } = {}) {
  return {
    id: 'llama-server',
    version,
    licenses: ['mit'],
    publishedAt,
    source,
    targets: {
      'win32-x64': {
        url,
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
        executable: 'llama-server.exe',
        files: [{ path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 1 }],
      },
    },
  };
}

function manifest(options) {
  return { version: 1, sidecars: [sidecar(options)] };
}

function rejectsBinding(url, label, options = {}) {
  assert.throws(() => validateSidecarManifest(manifest({ ...options, url })), (error) => {
    assert.ok(error instanceof SidecarError, label + ': expected a SidecarError');
    assert.equal(error.code, 'invalid-manifest', label + ': expected invalid-manifest');
    assert.equal(error.message, BINDING_MESSAGE, label + ': expected the bounded binding message');
    assert.ok(!error.message.includes(url), label + ': the error must not echo the url');
    return true;
  }, label);
}

test('the loader accepts the shipped pin and keeps its bound release url', () => {
  const loaded = loadSidecarManifestFile(SHIPPED);
  const target = loaded.sidecars[0].targets['win32-x64'];
  assert.equal(target.url, 'https://github.com/ggml-org/llama.cpp/releases/download/b12426/llama-b12426-bin-win-cpu-x64.zip');
});

test('a remote archive url must be exactly the recorded source tag and asset', () => {
  rejectsBinding('https://gitlab.com/ggml-org/llama.cpp/releases/download/b12426/llama.zip', 'other host');
  rejectsBinding('https://github.com/other/llama.cpp/releases/download/b12426/llama.zip', 'other owner');
  rejectsBinding('https://github.com/ggml-org/other/releases/download/b12426/llama.zip', 'other repo');
  rejectsBinding('https://github.com/ggml-org/llama.cpp/releases/download/b1/llama.zip', 'other tag');
  rejectsBinding('https://github.com/ggml-org/llama.cpp/releases/download/b12426/extra/llama.zip', 'extra segment');
  rejectsBinding('https://github.com/ggml-org/llama.cpp/releases/download/b12426/llama.tar.gz', 'non-zip asset');
  rejectsBinding('https://github.com/ggml-org/llama.cpp/releases/download/b12426/', 'missing asset name');
  rejectsBinding('https://github.com/ggml-org/llama.cpp/releases/download/b12426/llama%2Ezip', 'encoded asset name');
  rejectsBinding('https://github.com:443/ggml-org/llama.cpp/releases/download/b12426/llama.zip', 'explicit port');
  rejectsBinding('https://GitHub.com/ggml-org/llama.cpp/releases/download/b12426/llama.zip', 'non-canonical host spelling');
  rejectsBinding('https://github.com/ggml-org/llama.cpp/releases/download/b12426/llama.zip/', 'trailing slash');
  rejectsBinding('https://github.com/ggml-org/llama.cpp/archive/b12426/llama.zip', 'non-release path');
  rejectsBinding('https://github.com/ggml-org/llama.cpp/releases/download/b12426/llama.zip', 'http loopback only',
    { source: 'someone/else' });
});

test('the binding follows the recorded source and version, not a fixed repository', () => {
  const other = 'https://github.com/someone/else/releases/download/v1/asset.zip';
  const loaded = validateSidecarManifest(manifest({ source: 'someone/else', version: 'v1', url: other }));
  assert.equal(loaded.sidecars[0].targets['win32-x64'].url, other);
});

test('a loopback http pin is the local test seam and is exempt from the release binding', () => {
  const loopback = 'http://' + ['127', '0', '0', '1'].join('.') + ':8123/any-name.zip';
  const loaded = validateSidecarManifest(manifest({ source: 'someone/else', version: 'v1', url: loopback }));
  assert.equal(loaded.sidecars[0].targets['win32-x64'].url, loopback);
  // Only `http:` on loopback is exempt; an https loopback pin is a remote pin like any other.
  rejectsBinding('https://' + ['127', '0', '0', '1'].join('.') + ':8443/any-name.zip', 'https loopback');
});

test('the loader still refuses a non-https remote url before the binding runs', () => {
  for (const url of ['ftp://github.com/ggml-org/llama.cpp/releases/download/b12426/llama.zip',
    'http://github.com/ggml-org/llama.cpp/releases/download/b12426/llama.zip']) {
    assert.throws(() => validateSidecarManifest(manifest({ url })), (error) => error.code === 'invalid-manifest');
  }
});

test('assertIntakePolicy enforces the seven-day window at its exact boundary', () => {
  const pin = manifest();
  const window = INTAKE_MIN_PUBLIC_DAYS * 86_400_000;
  const eligible = new Date(Date.parse('2026-11-15T00:00:00Z') + window);
  assert.equal(eligible.toISOString(), '2026-11-22T00:00:00.000Z');

  assert.throws(() => assertIntakePolicy(pin, { now: new Date(eligible.getTime() - 1) }), (error) => {
    assert.ok(error instanceof SidecarError);
    assert.equal(error.code, 'intake-too-recent');
    assert.equal(error.message, 'sidecar llama-server b12426 is younger than the 7-day intake window');
    return true;
  });
  assert.equal(assertIntakePolicy(pin, { now: eligible }).sidecars.length, 1);
  assert.equal(assertIntakePolicy(pin, { now: new Date('2026-11-27T00:00:00Z') }).sidecars.length, 1);
});

test('assertIntakePolicy refuses a pin published in the future and an unusable clock', () => {
  assert.throws(() => assertIntakePolicy(manifest({ publishedAt: '2026-12-01' }), { now: new Date('2026-11-27T00:00:00Z') }),
    (error) => error.code === 'intake-too-recent');

  for (const now of ['2026-11-27', 0, null, new Date('not a date'), {}]) {
    assert.throws(() => assertIntakePolicy(manifest(), { now }), (error) => {
      assert.equal(error.code, 'invalid-options');
      return true;
    }, 'now ' + String(now));
  }
  assert.throws(() => assertIntakePolicy(manifest(), { now: new Date(), root: '/' }),
    (error) => error.code === 'invalid-options');
});

test('assertIntakePolicy reads its options through own data descriptors', () => {
  let invoked = 0;
  const options = {};
  Object.defineProperty(options, 'now', {
    enumerable: true,
    configurable: true,
    get() {
      invoked += 1;
      return new Date();
    },
  });
  assert.throws(() => assertIntakePolicy(manifest(), options), (error) => error.code === 'invalid-options');
  assert.equal(invoked, 0);
});

test('a malformed manifest still fails as invalid-manifest, not as an intake error', () => {
  assert.throws(() => assertIntakePolicy({ version: 2, sidecars: [] }, { now: new Date('2026-12-31T00:00:00Z') }),
    (error) => error.code === 'invalid-manifest');
});

test('the shipped pin is eligible today and the default check needs no injected clock', () => {
  const loaded = assertIntakePolicy(loadSidecarManifestFile(SHIPPED));
  assert.equal(loaded.sidecars[0].id, 'llama-server');
  assert.ok(Object.isFrozen(loaded));
});

test('installSidecar refuses a too-recent pin before any fetch or write', async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const pin = validateSidecarManifest(manifest({ publishedAt: today })).sidecars[0];
  const dir = path.join(tempDir(t), 'runtime');
  let calls = 0;
  await assert.rejects(installSidecar(pin, {
    platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('a too-recent pin must not be downloaded');
    },
  }), (error) => {
    assert.ok(error instanceof SidecarError);
    assert.equal(error.code, 'intake-too-recent');
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(existsSync(dir), false);
});

test('offline verification of an already installed runtime is not affected by the window', async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const pin = validateSidecarManifest(manifest({ publishedAt: today })).sidecars[0];
  const result = await verifySidecarInstall(pin, { platformKey: 'win32-x64', targetDir: path.join(tempDir(t), 'runtime') });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'missing');
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('the intake CLI passes on the shipped pin and fails inside the seven-day window', () => {
  const pass = runCli(['--now', '2026-11-22']);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /ok {6}llama-server b12426 published 2026-11-15, eligible 2026-11-22/);
  assert.match(pass.stdout, /sidecar-intake: PASS \(0 errors, 0 warnings\)/);

  const early = runCli(['--now', '2026-11-21']);
  assert.equal(early.status, 1);
  assert.match(early.stdout, /FAIL {2}sidecar-intake: intake-too-recent: sidecar llama-server b12426 is younger/);
  assert.match(early.stdout, /sidecar-intake: FAIL \(1 errors, 0 warnings\)/);

  const today = runCli([]);
  assert.equal(today.status, 0, today.stdout + today.stderr);
});

test('the intake CLI refuses an unusable --now', () => {
  for (const value of ['2026-02-30', '2026-1-1', 'not-a-date']) {
    const result = runCli(['--now', value]);
    assert.equal(result.status, 1, value + ': ' + result.stdout + result.stderr);
    assert.match(result.stdout, /sidecar-intake: invalid-options: --now must be/);
  }
  const flagOnly = runCli(['--now']);
  assert.equal(flagOnly.status, 1);
  assert.match(flagOnly.stdout, /sidecar-intake: invalid-options: --now must be a YYYY-MM-DD date/);
});
