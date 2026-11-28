// M3 application data root and installer-owned runtime directory.
//
// The pinned runtime must never be installed into a path a webview can choose. This module is the one
// place that defines where Vibecodium keeps its own files, derives exactly one runtime directory per
// pinned target from that root, and proves the directory stays inside it after symlinks and junctions
// are resolved. Node built-ins only; it reads no secret, opens no socket and starts no process.

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';

export const APP_DATA_MODULE_VERSION = 1;
// The product-owned folder under the platform's application data location. Windows and macOS use the
// product's spelling; Linux follows the XDG convention of a lowercase application directory.
export const APP_DATA_DIRECTORY_NAME = 'Vibecodium';
export const POSIX_DATA_DIRECTORY_NAME = 'vibecodium';
// The folder under that root that holds installed local runtimes.
export const RUNTIME_DIRECTORY_NAME = 'runtime';
export const MAX_APP_DATA_PATH_CHARS = 4096;
export const MAX_ID_CHARS = 64;
export const MAX_VERSION_CHARS = 64;
export const APP_DATA_PLATFORMS = Object.freeze(['win32', 'linux', 'darwin']);
export const APP_DATA_SOURCES = Object.freeze([
  'local-appdata', 'roaming-appdata', 'xdg-data-home', 'home-xdg', 'home-library',
]);

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLATFORM_KEY = /^(?:win32|linux|darwin)-(?:x64|arm64)$/;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const RESOLVE_OPTION_KEYS = new Set(['env', 'platform', 'home']);
const RUNTIME_OPTION_KEYS = new Set(['id', 'version', 'platformKey']);

export class AppDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppDataError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AppDataError(code, message);
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (types.isProxy(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

// Own data descriptors only: an accessor is refused without being invoked and a polluted prototype
// cannot contribute a value.
function readOwnData(value, label, allowed, code) {
  const failure = code || 'invalid-options';
  if (!isPlainObject(value)) fail(failure, label + ' must be a plain object');
  let names;
  try {
    names = Object.keys(value);
  } catch {
    fail(failure, label + ' cannot be enumerated');
  }
  if (names.length > allowed.size) fail(failure, label + ' has too many properties');
  const out = Object.create(null);
  for (const name of names) {
    if (RESERVED_KEYS.has(name)) fail(failure, label + ' has a reserved property');
    if (!allowed.has(name)) fail(failure, label + ' has an unknown property');
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
    } catch {
      fail(failure, label + ' has an unsafe property');
    }
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      fail(failure, label + ' must contain data properties only');
    }
    out[name] = descriptor.value;
  }
  return out;
}

function requireText(value, label, maximum, code) {
  const failure = code || 'invalid-options';
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    fail(failure, label + ' must be a bounded non-empty string');
  }
  if (CONTROL_OR_BIDI.test(value)) fail(failure, label + ' contains unsafe characters');
  return value;
}

// Path flavour for the requested platform, so a Windows root is reasoned about with Windows rules even
// when the test or a planning tool runs on another host.
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isAbsoluteLocalPath(platform, value) {
  if (platform === 'win32') {
    // A UNC or device path is not a local application data root.
    if (value.startsWith('\\\\') || value.startsWith('//')) return false;
    return /^[A-Za-z]:[\\/]/.test(value) && value.length > 3;
  }
  return value.startsWith('/') && !value.startsWith('//');
}

function stripTrailingSeparators(platform, value) {
  const separator = platform === 'win32' ? /[\\/]+$/ : /\/+$/;
  const trimmed = value.replace(separator, '');
  return trimmed.length > 0 ? trimmed : value;
}

// Validates and normalises an absolute local application data path without touching the filesystem.
function validateAbsolute(platform, value, label, code) {
  requireText(value, label, MAX_APP_DATA_PATH_CHARS, code);
  if (!isAbsoluteLocalPath(platform, value)) fail(code, label + ' must be an absolute local path');
  const parts = value.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter((part) => part.length > 0);
  for (const part of parts) {
    if (part === '.' || part === '..') fail(code, label + ' must not contain relative segments');
    if (platform === 'win32' && /[. ]$/.test(part)) {
      fail(code, label + ' has a Win32-invalid trailing dot or space');
    }
    const isDrive = platform === 'win32' && /^[A-Za-z]:$/.test(part);
    if (platform === 'win32' && !isDrive && (part.includes(':') || RESERVED_DEVICE.test(part))) {
      fail(code, label + ' has a reserved Win32 name');
    }
  }
  return stripTrailingSeparators(platform, pathFor(platform).normalize(value));
}

// A drive root (C:\) or the filesystem root (/) is not a product-owned folder: the derived runtime
// directory has to live under a named directory.
function validateRoot(platform, value, label, code) {
  const normalized = validateAbsolute(platform, value, label, code);
  const parts = normalized.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter((part) => part.length > 0);
  if (parts.length < (platform === 'win32' ? 2 : 1)) fail(code, label + ' must not be a filesystem root');
  return normalized;
}

function readEnvValue(env, name) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(env, name);
  } catch {
    fail('invalid-options', 'the environment cannot be inspected');
  }
  if (!descriptor) return undefined;
  if ('get' in descriptor || 'set' in descriptor) {
    fail('invalid-options', 'the environment must contain data properties only');
  }
  const value = descriptor.value;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1) {
    fail('invalid-app-data-root', 'the application data environment variable is not a path');
  }
  return value;
}

function requireEnv(env, name) {
  const value = readEnvValue(env, name);
  if (value === undefined) return undefined;
  return value;
}

// Canonicalises the existing prefix of an absolute path with realpath, keeping the not-yet-created
// suffix. A symlink or junction anywhere in the existing prefix is therefore resolved before any
// containment decision, so a link planted inside the root cannot redirect the install outside it, and
// a link that legitimately sits above the root (a macOS /var or Windows junction) is handled instead of
// rejected. A foreign platform is resolved lexically only, because its paths cannot exist on this host.
function canonicalize(platform, value, label, code) {
  const normalized = validateAbsolute(platform, value, label, code);
  if (platform !== process.platform) return normalized;
  const flavour = pathFor(platform);
  let existing = normalized;
  let missing = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') fail(code, label + ' cannot be inspected');
      const parent = flavour.dirname(existing);
      if (parent === existing) fail(code, label + ' cannot be resolved');
      missing = [flavour.basename(existing), ...missing];
      existing = parent;
    }
  }
  let real;
  try {
    real = realpathSync.native(existing);
  } catch {
    fail(code, label + ' cannot be resolved');
  }
  const joined = missing.length === 0 ? real : flavour.join(real, ...missing);
  return stripTrailingSeparators(platform, flavour.normalize(joined));
}

function samePath(platform, left, right) {
  return platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function contains(platform, root, directory) {
  const relation = pathFor(platform).relative(root, directory);
  if (relation.length < 1) return false;
  if (relation === '..' || relation.startsWith('..' + pathFor(platform).sep)) return false;
  return !pathFor(platform).isAbsolute(relation);
}

// Resolves the platform application data root from the environment. The Windows-first product root is
// `%LOCALAPPDATA%\Vibecodium`, with `%APPDATA%\Vibecodium` as the fallback. A caller may inject the
// environment (and, on macOS/Linux, the home directory) so the resolution is testable without touching
// the real profile; the injected environment is read through own data descriptors only.
export function resolveAppDataRoot(options = {}) {
  const own = readOwnData(options, 'options', RESOLVE_OPTION_KEYS);
  const platform = own.platform === undefined ? process.platform : own.platform;
  if (typeof platform !== 'string' || !APP_DATA_PLATFORMS.includes(platform)) {
    fail('unsupported-platform', 'platform must be win32, linux or darwin');
  }
  let env;
  if (own.env === undefined) {
    env = process.env;
  } else {
    if (!isPlainObject(own.env)) fail('invalid-options', 'env must be a plain object');
    env = own.env;
  }
  const flavour = pathFor(platform);
  if (platform === 'win32') {
    const local = requireEnv(env, 'LOCALAPPDATA');
    if (local !== undefined) return resolvedRoot(platform, local, 'local-appdata', APP_DATA_DIRECTORY_NAME);
    const roaming = requireEnv(env, 'APPDATA');
    if (roaming !== undefined) return resolvedRoot(platform, roaming, 'roaming-appdata', APP_DATA_DIRECTORY_NAME);
    fail('missing-app-data-root', 'the Windows application data variables are not set');
  }
  if (platform === 'linux') {
    const xdg = requireEnv(env, 'XDG_DATA_HOME');
    if (xdg !== undefined) return resolvedRoot(platform, xdg, 'xdg-data-home', POSIX_DATA_DIRECTORY_NAME);
  }
  const home = own.home !== undefined
    ? requireText(own.home, 'home', MAX_APP_DATA_PATH_CHARS, 'invalid-app-data-root')
    : requireEnv(env, 'HOME');
  if (home === undefined) fail('missing-app-data-root', 'the home directory is not set');
  if (own.home !== undefined) validateAbsolute(platform, home, 'home', 'invalid-app-data-root');
  if (platform === 'linux') {
    return resolvedRoot(platform, home, 'home-xdg', '.local', 'share', POSIX_DATA_DIRECTORY_NAME);
  }
  return resolvedRoot(platform, home, 'home-library', 'Library', 'Application Support', APP_DATA_DIRECTORY_NAME);

  function resolvedRoot(platformName, base, source, ...segments) {
    const basePath = validateRoot(platformName, base, 'application data variable', 'invalid-app-data-root');
    const root = flavour.join(basePath, ...segments);
    const canonical = canonicalize(platformName, root, 'application data root', 'invalid-app-data-root');
    return Object.freeze({ platform: platformName, root: canonical, source });
  }
}

// Derives the installer-owned runtime directory for one pinned target:
// `<root>/runtime/<platformKey>/<id>-<version>`. The version is part of the path, so a re-pin installs
// beside the previous runtime instead of mixing files from two builds in one directory.
export function ownedRuntimeDirectory(root, options = {}) {
  const own = readOwnData(options, 'runtime directory options', RUNTIME_OPTION_KEYS);
  for (const key of RUNTIME_OPTION_KEYS) {
    if (own[key] === undefined) fail('invalid-options', 'runtime directory options require ' + key);
  }
  const id = requireText(own.id, 'id', MAX_ID_CHARS);
  if (!ID.test(id) || id === '.' || id === '..') fail('invalid-options', 'id must be a lowercase slug');
  const version = requireText(own.version, 'version', MAX_VERSION_CHARS);
  if (!VERSION.test(version) || version === '.' || version === '..') {
    fail('invalid-options', 'version must be a bounded tag');
  }
  if (typeof own.platformKey !== 'string' || !PLATFORM_KEY.test(own.platformKey)) {
    fail('invalid-options', 'platformKey must be <platform>-<arch>');
  }
  const platform = process.platform;
  const rootPath = canonicalize(platform,
    validateRoot(platform, root, 'application data root', 'invalid-app-data-root'),
    'application data root', 'invalid-app-data-root');
  const flavour = pathFor(platform);
  const directory = flavour.join(rootPath, RUNTIME_DIRECTORY_NAME, own.platformKey, id + '-' + version);
  const owned = assertOwnedRuntimeDirectory(rootPath, directory);
  return Object.freeze({ root: rootPath, directory: owned, platformKey: own.platformKey });
}

// Proves a directory stays strictly inside the application data root after symlinks and junctions are
// resolved, and returns the resolved directory. Nothing is created and nothing is written.
export function assertOwnedRuntimeDirectory(root, directory) {
  const platform = process.platform;
  const rootPath = canonicalize(platform,
    validateRoot(platform, root, 'application data root', 'invalid-app-data-root'),
    'application data root', 'invalid-app-data-root');
  const directoryPath = canonicalize(platform, directory, 'runtime directory', 'outside-app-data');
  if (samePath(platform, rootPath, directoryPath) || !contains(platform, rootPath, directoryPath)) {
    fail('outside-app-data', 'the runtime directory leaves the application data root');
  }
  return directoryPath;
}
