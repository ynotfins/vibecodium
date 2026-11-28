import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AppDataError,
  APP_DATA_DIRECTORY_NAME,
  assertOwnedRuntimeDirectory,
  ownedRuntimeDirectory,
  resolveAppDataRoot,
} from '../../src/stable/runtime/app-data.mjs';

function tempRoot(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'vibe-app-data-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function rejects(fn, code, label) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AppDataError, label + ': a plain Error was thrown');
    assert.equal(error.code, code, label + ': ' + error.message);
    return true;
  }, label);
}

function accessor(value) {
  const bag = {};
  Object.defineProperty(bag, 'env', {
    enumerable: true,
    get() {
      throw new Error('the getter must never run');
    },
  });
  bag.value = value;
  return bag;
}

test('the Windows root is product-owned and prefers the local application data folder', () => {
  const resolved = resolveAppDataRoot({
    platform: 'win32',
    env: {
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
    },
  });
  assert.deepEqual(resolved, {
    platform: 'win32',
    root: 'C:\\Users\\dev\\AppData\\Local\\' + APP_DATA_DIRECTORY_NAME,
    source: 'local-appdata',
  });
  assert.ok(Object.isFrozen(resolved));
});

test('the Windows root falls back to APPDATA and fails without either variable', () => {
  assert.deepEqual(
    resolveAppDataRoot({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
    }),
    {
      platform: 'win32',
      root: 'C:\\Users\\dev\\AppData\\Roaming\\' + APP_DATA_DIRECTORY_NAME,
      source: 'roaming-appdata',
    },
  );
  rejects(() => resolveAppDataRoot({ platform: 'win32', env: {} }), 'missing-app-data-root', 'empty env');
  rejects(
    () => resolveAppDataRoot({ platform: 'win32', env: { LOCALAPPDATA: '' } }),
    'invalid-app-data-root',
    'empty local app data',
  );
});

test('Linux uses XDG_DATA_HOME or the home fallback and macOS uses Application Support', () => {
  assert.deepEqual(
    resolveAppDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/data' } }),
    { platform: 'linux', root: '/data/vibecodium', source: 'xdg-data-home' },
  );
  assert.deepEqual(
    resolveAppDataRoot({ platform: 'linux', env: { HOME: '/home/dev' } }),
    { platform: 'linux', root: '/home/dev/.local/share/vibecodium', source: 'home-xdg' },
  );
  assert.deepEqual(
    resolveAppDataRoot({ platform: 'linux', env: {}, home: '/srv/dev' }),
    { platform: 'linux', root: '/srv/dev/.local/share/vibecodium', source: 'home-xdg' },
  );
  assert.deepEqual(
    resolveAppDataRoot({ platform: 'darwin', env: { HOME: '/Users/dev' } }),
    {
      platform: 'darwin',
      root: '/Users/dev/Library/Application Support/' + APP_DATA_DIRECTORY_NAME,
      source: 'home-library',
    },
  );
  rejects(() => resolveAppDataRoot({ platform: 'linux', env: {} }), 'missing-app-data-root', 'no home');
  rejects(() => resolveAppDataRoot({ platform: 'darwin', env: {} }), 'missing-app-data-root', 'no home');
});

test('an unsupported platform fails closed', () => {
  rejects(() => resolveAppDataRoot({ platform: 'aix', env: {} }), 'unsupported-platform', 'aix');
  rejects(() => resolveAppDataRoot({ platform: 1, env: {} }), 'unsupported-platform', 'number');
});

test('options and the injected environment are read through own data descriptors', () => {
  assert.throws(
    () => resolveAppDataRoot(accessor({ LOCALAPPDATA: 'C:\\x' })),
    (error) => error instanceof AppDataError && error.code === 'invalid-options',
  );
  let invoked = false;
  const env = {};
  Object.defineProperty(env, 'LOCALAPPDATA', {
    enumerable: true,
    get() {
      invoked = true;
      return 'C:\\Users\\dev\\AppData\\Local';
    },
  });
  rejects(() => resolveAppDataRoot({ platform: 'win32', env }), 'invalid-options', 'accessor env');
  assert.equal(invoked, false);
  rejects(() => resolveAppDataRoot({ platform: 'win32', env: {}, extra: true }), 'invalid-options', 'unknown key');
  rejects(
    () => resolveAppDataRoot({ platform: 'win32', env: {}, constructor: true }),
    'invalid-options',
    'reserved key',
  );
  rejects(() => resolveAppDataRoot({ platform: 'win32', env: [] }), 'invalid-options', 'array env');
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  rejects(() => resolveAppDataRoot(revoked.proxy), 'invalid-options', 'revoked proxy');
  // A null-prototype environment is still a plain data bag.
  const bare = Object.create(null);
  bare.LOCALAPPDATA = 'C:\\Users\\dev\\AppData\\Local';
  assert.equal(
    resolveAppDataRoot({ platform: 'win32', env: bare }).source,
    'local-appdata',
  );
});

test('an unsafe application data root fails closed', () => {
  const cases = [
    ['relative', { platform: 'win32', env: { LOCALAPPDATA: 'AppData\\Local' } }, 'relative-appdata'],
    ['drive relative', { platform: 'win32', env: { LOCALAPPDATA: 'C:Users\\dev' } }, 'drive-relative-appdata'],
    ['unc', { platform: 'win32', env: { LOCALAPPDATA: '\\\\server\\share' } }, 'unc-appdata'],
    ['traversal', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\..\\Windows' } }, 'traversal-appdata'],
    ['control', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\de\u0007v' } }, 'control-appdata'],
    ['bidi', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\de\u202Ev' } }, 'bidi-appdata'],
    ['drive root', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\' } }, 'drive-root'],
    ['filesystem root', { platform: 'linux', env: { XDG_DATA_HOME: '/' } }, 'posix-root'],
    ['reserved device', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\con' } }, 'reserved'],
    ['trailing dot', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\dev.' } }, 'trailing-dot'],
  ];
  for (const [label, options] of cases) {
    rejects(() => resolveAppDataRoot(options), 'invalid-app-data-root', label);
  }
  // HOME only feeds a POSIX root, where a drive-letter path is not absolute and therefore refused.
  rejects(
    () => resolveAppDataRoot({ platform: 'linux', env: { HOME: 'C:\\Users\\dev' } }),
    'invalid-app-data-root',
    'windows home on posix',
  );
});

test('ownedRuntimeDirectory derives one directory per pinned target', (t) => {
  const root = tempRoot(t);
  const owned = ownedRuntimeDirectory(root, {
    id: 'llama-server',
    version: 'b12426',
    platformKey: 'win32-x64',
  });
  const expected = path.join(root, 'runtime', 'win32-x64', 'llama-server-b12426');
  assert.deepEqual(owned, { root, directory: expected, platformKey: 'win32-x64' });
  assert.ok(Object.isFrozen(owned));
  assert.ok(expected.startsWith(root + path.sep));
  // The version is part of the path, so a re-pin lands beside the previous runtime.
  const next = ownedRuntimeDirectory(root, {
    id: 'llama-server',
    version: 'b12774',
    platformKey: 'win32-x64',
  });
  assert.notEqual(next.directory, owned.directory);
  assert.ok(next.directory.startsWith(expected.slice(0, expected.lastIndexOf('-')) + '-'));
});

test('ownedRuntimeDirectory refuses an unsafe descriptor without invoking a getter', (t) => {
  const root = tempRoot(t);
  const base = { id: 'llama-server', version: 'b12426', platformKey: 'win32-x64' };
  const cases = [
    ['empty id', { ...base, id: '' }],
    ['uppercase id', { ...base, id: 'Llama' }],
    ['dot id', { ...base, id: '.' }],
    ['slash id', { ...base, id: 'a/b' }],
    ['slash version', { ...base, version: '../x' }],
    ['empty version', { ...base, version: '' }],
    ['bad platform', { ...base, platformKey: 'win32-ia32' }],
    ['missing key', { id: 'llama-server', version: 'b12426' }],
    ['unknown key', { ...base, targetDir: path.join(root, 'elsewhere') }],
    ['reserved key', { ...base, constructor: true }],
    ['array', []],
  ];
  for (const [label, descriptor] of cases) {
    rejects(() => ownedRuntimeDirectory(root, descriptor), 'invalid-options', label);
  }
  let invoked = false;
  const descriptor = {};
  Object.defineProperty(descriptor, 'id', {
    enumerable: true,
    get() {
      invoked = true;
      return 'llama-server';
    },
  });
  descriptor.version = 'b12426';
  descriptor.platformKey = 'win32-x64';
  rejects(() => ownedRuntimeDirectory(root, descriptor), 'invalid-options', 'accessor');
  assert.equal(invoked, false);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  rejects(() => ownedRuntimeDirectory(root, revoked.proxy), 'invalid-options', 'revoked proxy');
});

test('ownedRuntimeDirectory refuses a relative, root-level or unsafe application data root', (t) => {
  const root = tempRoot(t);
  const descriptor = { id: 'llama-server', version: 'b12426', platformKey: 'win32-x64' };
  rejects(() => ownedRuntimeDirectory('relative\\root', descriptor), 'invalid-app-data-root', 'relative');
  rejects(() => ownedRuntimeDirectory(path.parse(root).root, descriptor), 'invalid-app-data-root', 'root');
  rejects(() => ownedRuntimeDirectory(undefined, descriptor), 'invalid-app-data-root', 'missing root');
  rejects(() => ownedRuntimeDirectory('', descriptor), 'invalid-app-data-root', 'empty root');
});

test('assertOwnedRuntimeDirectory accepts an inside directory and rejects every escape', (t) => {
  const root = tempRoot(t);
  const inside = path.join(root, 'runtime', 'win32-x64', 'llama-server-b12426');
  assert.equal(assertOwnedRuntimeDirectory(root, inside), inside);
  if (process.platform === 'win32') {
    assert.equal(assertOwnedRuntimeDirectory(root.toUpperCase(), inside), inside);
  }
  rejects(() => assertOwnedRuntimeDirectory(root, root), 'outside-app-data', 'the root itself');
  rejects(
    () => assertOwnedRuntimeDirectory(root, path.join(root, '..', path.basename(root) + '-other')),
    'outside-app-data',
    'sibling',
  );
  rejects(
    () => assertOwnedRuntimeDirectory(root, path.join(root, '..', 'elsewhere')),
    'outside-app-data',
    'parent escape',
  );
  rejects(
    () => assertOwnedRuntimeDirectory(root, path.join(root, 'runtime', '..', '..', 'elsewhere')),
    'outside-app-data',
    'dot-dot escape',
  );
  rejects(() => assertOwnedRuntimeDirectory('relative', inside), 'invalid-app-data-root', 'relative root');
  rejects(
    () => assertOwnedRuntimeDirectory(root, 'relative\\dir'),
    'outside-app-data',
    'relative directory',
  );
  // A missing root and a missing directory still resolve lexically inside the same prefix.
  const future = path.join(root, 'not-created', 'runtime');
  assert.equal(assertOwnedRuntimeDirectory(path.join(root, 'not-created'), future), future);
  assert.equal(existsSync(path.join(root, 'not-created')), false);
});

test('a symlink or junction inside the root cannot redirect the runtime directory outside it', (t) => {
  const root = tempRoot(t);
  const outside = tempRoot(t);
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  const link = path.join(root, 'runtime', 'escaped');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  rejects(
    () => assertOwnedRuntimeDirectory(root, path.join(link, 'win32-x64', 'llama-server-b12426')),
    'outside-app-data',
    'junction inside the root',
  );
  // A link above the root is canonicalised: the root and the directory resolve through the same link.
  const parent = tempRoot(t);
  const real = path.join(parent, 'real-root');
  mkdirSync(real, { recursive: true });
  const alias = path.join(parent, 'alias-root');
  symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const owned = ownedRuntimeDirectory(alias, {
    id: 'llama-server',
    version: 'b12426',
    platformKey: 'win32-x64',
  });
  assert.equal(owned.root, realpathSync.native(real));
  assert.ok(owned.directory.startsWith(owned.root + path.sep));
});
