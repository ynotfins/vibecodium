// M3 pinned runtime sidecar installer.
//
// Installs the `llama-server` files from a pinned archive: the manifest in `vibe/sidecars.json`
// fixes the archive URL, byte size and SHA-256 and every runtime file's path, byte size and digest.
// A transfer into a `.part` file is bounded by an idle and a total deadline, the archive digest is
// checked before it is parsed, only the allowlisted entries of a plain ZIP are extracted, each file
// is verified again before it is installed, and nothing is ever executed.
//
// The install is idempotent: a target directory whose files already match the pin is reported as
// skipped without opening a socket, so the first-run wizard can call it offline.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { validateLlamaExecutablePath } from './llama-server.mjs';

export const SIDECAR_MODULE_VERSION = 1;
export const SIDECAR_MANIFEST_VERSION = 1;
export const MAX_SIDECARS = 16;
export const MAX_TARGETS = 6;
export const MAX_TARGET_FILES = 64;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_ID_CHARS = 64;
export const MAX_VERSION_CHARS = 64;
export const MAX_PATH_CHARS = 4096;
export const MAX_FILE_NAME_CHARS = 128;
export const MAX_URL_CHARS = 2048;
export const MIN_IDLE_TIMEOUT_MS = 50;
export const MAX_IDLE_TIMEOUT_MS = 600_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
export const MIN_TOTAL_TIMEOUT_MS = 1_000;
export const MAX_TOTAL_TIMEOUT_MS = 3_600_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;
export const HASH_CHUNK_BYTES = 1024 * 1024;
export const MAX_ZIP_ENTRIES = 4096;
export const ALLOWED_LICENSES = Object.freeze([
  'mit',
  'apache-2.0',
  'apache-2.0-with-llvm-exception',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
]);
export const TARGET_PLATFORMS = Object.freeze(['win32', 'linux', 'darwin']);
export const TARGET_ARCHES = Object.freeze(['x64', 'arm64']);

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/;
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TARGET_KEY = /^(win32|linux|darwin)-(x64|arm64)$/;
const DIGEST = /^[0-9a-fA-F]{64}$/;
const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const LOOPBACK_HOSTS = Object.freeze([['127', '0', '0', '1'].join('.'), '[::1]']);

const MANIFEST_KEYS = new Set(['version', 'sidecars']);
const SIDECAR_KEYS = new Set(['id', 'version', 'licenses', 'publishedAt', 'source', 'targets']);
const TARGET_KEYS = new Set(['url', 'sha256', 'sizeBytes', 'executable', 'files']);
const FILE_KEYS = new Set(['path', 'sha256', 'sizeBytes']);
const INSTALL_OPTION_KEYS = new Set([
  'targetDir', 'platformKey', 'fetchImpl', 'onProgress', 'signal', 'idleTimeoutMs', 'totalTimeoutMs',
]);
const VERIFY_OPTION_KEYS = new Set(['targetDir', 'platformKey']);

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT_BYTES = 0xffff;
const EOCD_BYTES = 22;
const ZIP64_SENTINEL = 0xffffffff;
const MAX_EOCD_SCAN = EOCD_BYTES + MAX_COMMENT_BYTES;
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const ACTIVE = new Set();

export class SidecarError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SidecarError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SidecarError(code, message);
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype;
  } catch {
    return false;
  }
}

// Reads own data descriptors once so an accessor is rejected without being invoked, a Proxy cannot
// run a get trap, and a polluted prototype cannot contribute a key.
function readOwnData(value, label, allowed, code = 'invalid-manifest') {
  if (!isPlainObject(value)) fail(code, label + ' must be a plain object');
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail(code, label + ' cannot be enumerated');
  }
  if (keys.length > allowed.size) fail(code, label + ' has too many keys');
  const out = Object.create(null);
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) fail(code, label + ' has a reserved key');
    if (!allowed.has(key)) fail(code, label + ' has an unknown key');
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(code, label + ' has an unsafe property');
    }
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      fail(code, label + ' must contain data properties only');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function readOwnArray(value, label, maximum, code = 'invalid-manifest') {
  if (!Array.isArray(value)) fail(code, label + ' must be an array');
  let lengthDescriptor;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail(code, label + ' cannot be read');
  }
  if (!lengthDescriptor || !('value' in lengthDescriptor)) fail(code, label + ' must be dense data');
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > maximum) {
    fail(code, label + ' has an unsupported length');
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail(code, label + ' cannot be read');
    }
    if (!descriptor || !('value' in descriptor)) fail(code, label + ' must be dense data');
    out.push(descriptor.value);
  }
  return out;
}

function requireText(value, label, maximum, code = 'invalid-manifest') {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    fail(code, label + ' must be a bounded non-empty string');
  }
  if (CONTROL_OR_BIDI.test(value)) fail(code, label + ' contains unsafe characters');
  return value;
}

function normalizeDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail('invalid-manifest', label + ' must be a 64-character hex digest');
  }
  return value.toLowerCase();
}

function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string') return false;
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase());
}

// Rejects a literal loopback, private, link-local or metadata address on a final URL when the
// pinned URL was not loopback. A DNS name is not resolved here; the digest remains the gate.
function isV4Internal(a, b) {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 240) return true;
  return false;
}

function expandV6(host) {
  if (typeof host !== 'string' || !host.includes(':') || !/^[0-9a-f:.]+$/.test(host)) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parse = (text) => {
    const out = [];
    if (text === '') return out;
    for (const group of text.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parse(halves[1]);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return head.concat(new Array(fill).fill(0), tail);
}

// Embedded-IPv4 and reserved-range check for a literal IPv6 host. The literal forms below reach an
// IPv4 service through a v6 address, so the dotted and half-hex checks in the isInternalHost helper
// alone would let a redirect to an internal endpoint through.
function isEmbeddedInternalV6(host) {
  const groups = expandV6(host);
  if (groups === null) return false;
  const zeroPrefix = (count) => {
    for (let i = 0; i < count; i += 1) if (groups[i] !== 0) return false;
    return true;
  };
  const embedded = (high, low) => isV4Internal(high >> 8, high & 0xff) || isV4Internal(low >> 8, low & 0xff);
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;
  if (zeroPrefix(5)) return embedded(groups[6], groups[7]);
  if (zeroPrefix(4) && groups[4] === 0xffff && groups[5] === 0) return embedded(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    if (groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
      return embedded(groups[6], groups[7]);
    }
    if (groups[2] === 1) return true;
  }
  if (groups[0] === 0x2002) return embedded(groups[1], groups[2]);
  return false;
}

function isInternalHost(hostname) {
  if (typeof hostname !== 'string') return true;
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') return true;
  if (isEmbeddedInternalV6(host)) return true;
  const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const dotted = mapped
    ? mapped.slice(1).join('.')
    : (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host) ? host : null);
  if (dotted) {
    const parts = dotted.split('.').map(Number);
    if (isV4Internal(parts[0], parts[1])) return true;
  }
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hexMapped) {
    const high = parseInt(hexMapped[1], 16);
    const low = parseInt(hexMapped[2], 16);
    if (isV4Internal(high >> 8, high & 0xff) || isV4Internal(low >> 8, low & 0xff)) return true;
  }
  return false;
}

function assertRemoteUrl(value, label) {
  requireText(value, label, MAX_URL_CHARS);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-manifest', label + ' must be a valid absolute URL');
  }
  if (parsed.username || parsed.password) fail('invalid-manifest', label + ' must not embed credentials');
  if (parsed.search) fail('invalid-manifest', label + ' must not carry a query string');
  if (parsed.hash) fail('invalid-manifest', label + ' must not carry a fragment');
  const secure = parsed.protocol === 'https:';
  const local = parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  if (!secure && !local) fail('invalid-manifest', label + ' must use https, or http on a loopback host');
  return value;
}

function assertSafeRelativePath(value, label) {
  requireText(value, label, MAX_FILE_NAME_CHARS);
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) {
    fail('invalid-manifest', label + ' must be a forward-slash relative path');
  }
  if (value.includes(':')) fail('invalid-manifest', label + ' must not carry a drive or stream segment');
  const parts = value.split('/');
  const seen = new Set();
  for (const part of parts) {
    if (part.length < 1 || part === '.' || part === '..') {
      fail('invalid-manifest', label + ' has an invalid path segment');
    }
    if (!FILE_SEGMENT.test(part)) fail('invalid-manifest', label + ' has an invalid path segment');
    if (/[. ]$/.test(part)) fail('invalid-manifest', label + ' has a Win32-invalid trailing dot or space');
    if (RESERVED_DEVICE.test(part)) {
      fail('invalid-manifest', label + ' must not name a reserved Win32 device');
    }
    const folded = part.toLowerCase();
    if (seen.has(folded)) fail('invalid-manifest', label + ' has a duplicate path segment');
    seen.add(folded);
  }
  return value;
}

function validateTargetFile(value) {
  const own = readOwnData(value, 'file', FILE_KEYS);
  for (const key of FILE_KEYS) {
    if (own[key] === undefined) fail('invalid-manifest', 'file is missing the ' + key + ' field');
  }
  const filePath = assertSafeRelativePath(own.path, 'file path');
  const sha256 = normalizeDigest(own.sha256, 'file sha256');
  if (!Number.isSafeInteger(own.sizeBytes) || own.sizeBytes < 1 || own.sizeBytes > MAX_FILE_BYTES) {
    fail('invalid-manifest', 'file sizeBytes is outside the supported range');
  }
  return Object.freeze({ path: filePath, sha256, sizeBytes: own.sizeBytes });
}

function validateTarget(value, platformKey) {
  const own = readOwnData(value, 'target', TARGET_KEYS);
  for (const key of TARGET_KEYS) {
    if (own[key] === undefined) fail('invalid-manifest', 'target is missing the ' + key + ' field');
  }
  const url = assertRemoteUrl(own.url, 'target url');
  const sha256 = normalizeDigest(own.sha256, 'target sha256');
  if (!Number.isSafeInteger(own.sizeBytes) || own.sizeBytes < 1 || own.sizeBytes > MAX_ARCHIVE_BYTES) {
    fail('invalid-manifest', 'target sizeBytes is outside the supported range');
  }
  const executable = assertSafeRelativePath(own.executable, 'target executable');
  const fileValues = readOwnArray(own.files, 'target files', MAX_TARGET_FILES);
  const files = [];
  const paths = new Set();
  let total = 0;
  for (const fileValue of fileValues) {
    const file = validateTargetFile(fileValue);
    const folded = file.path.toLowerCase();
    if (paths.has(folded)) fail('invalid-manifest', 'target has a duplicate file path');
    paths.add(folded);
    total += file.sizeBytes;
    if (total > MAX_TOTAL_BYTES) fail('invalid-manifest', 'target files exceed the supported total size');
    files.push(file);
  }
  const executableFolded = executable.toLowerCase();
  if (!paths.has(executableFolded)) fail('invalid-manifest', 'target executable is not in the file list');
  if (platformKey.startsWith('win32-') && !executableFolded.endsWith('.exe')) {
    fail('invalid-manifest', 'target executable must be a Windows executable');
  }
  return Object.freeze({ url, sha256, sizeBytes: own.sizeBytes, executable, files: Object.freeze(files) });
}

function validateSidecar(value) {
  const own = readOwnData(value, 'sidecar', SIDECAR_KEYS);
  for (const key of SIDECAR_KEYS) {
    if (own[key] === undefined) fail('invalid-manifest', 'sidecar is missing the ' + key + ' field');
  }
  requireText(own.id, 'id', MAX_ID_CHARS);
  if (!ID.test(own.id)) fail('invalid-manifest', 'id must be a lowercase slug');
  requireText(own.version, 'version', MAX_VERSION_CHARS);
  if (!VERSION.test(own.version)) fail('invalid-manifest', 'version must be a bounded tag');
  const licenseList = readOwnArray(own.licenses, 'licenses', 4);
  const seenLicenses = new Set();
  for (const license of licenseList) {
    if (typeof license !== 'string' || !ALLOWED_LICENSES.includes(license)) {
      fail('invalid-manifest', 'licenses must be permissive licenses in the allowed set');
    }
    if (seenLicenses.has(license)) fail('invalid-manifest', 'licenses must be unique');
    seenLicenses.add(license);
  }
  const licenses = Object.freeze(licenseList.slice());
  if (typeof own.publishedAt !== 'string' || !DATE.test(own.publishedAt)) {
    fail('invalid-manifest', 'publishedAt must be a YYYY-MM-DD date');
  }
  const when = Date.parse(own.publishedAt + 'T00:00:00Z');
  if (!Number.isFinite(when) || new Date(when).toISOString().slice(0, 10) !== own.publishedAt) {
    fail('invalid-manifest', 'publishedAt must be a real calendar date');
  }
  requireText(own.source, 'source', 96);
  if (!SOURCE.test(own.source)) fail('invalid-manifest', 'source must be an owner/name pair');
  const targetValues = readOwnData(own.targets, 'targets', new Set(targetKeys()), 'invalid-manifest');
  const targetKeysList = Object.keys(targetValues);
  if (targetKeysList.length < 1) fail('invalid-manifest', 'sidecar has no targets');
  const targets = {};
  for (const targetKey of targetKeysList) {
    if (!TARGET_KEY.test(targetKey)) fail('invalid-manifest', 'target key must be <platform>-<arch>');
    targets[targetKey] = validateTarget(targetValues[targetKey], targetKey);
  }
  return Object.freeze({
    id: own.id,
    version: own.version,
    licenses: licenses,
    publishedAt: own.publishedAt,
    source: own.source,
    targets: Object.freeze(targets),
  });
}

function targetKeys() {
  const keys = [];
  for (const platform of TARGET_PLATFORMS) {
    for (const arch of TARGET_ARCHES) keys.push(platform + '-' + arch);
  }
  return keys;
}

export function validateSidecarManifest(value) {
  try {
    const own = readOwnData(value, 'manifest', MANIFEST_KEYS);
    if (own.version !== SIDECAR_MANIFEST_VERSION) {
      fail('invalid-manifest', 'manifest version is not supported');
    }
    const sidecarValues = readOwnArray(own.sidecars, 'manifest sidecars', MAX_SIDECARS);
    const sidecars = [];
    const ids = new Set();
    for (const sidecarValue of sidecarValues) {
      const sidecar = validateSidecar(sidecarValue);
      if (ids.has(sidecar.id)) fail('invalid-manifest', 'manifest has a duplicate sidecar id');
      ids.add(sidecar.id);
      sidecars.push(sidecar);
    }
    return Object.freeze({ version: SIDECAR_MANIFEST_VERSION, sidecars: Object.freeze(sidecars) });
  } catch (error) {
    if (error instanceof SidecarError && error.code === 'invalid-manifest') throw error;
    fail('invalid-manifest', 'manifest is malformed');
  }
}

export function loadSidecarManifest(text) {
  if (typeof text !== 'string' || text.length < 1) fail('invalid-manifest', 'manifest must be JSON text');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid-manifest', 'manifest is not valid JSON');
  }
  return validateSidecarManifest(parsed);
}

export function loadSidecarManifestFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    fail('invalid-manifest', 'manifest file cannot be read');
  }
  return loadSidecarManifest(text);
}

export function findSidecar(manifest, id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID_CHARS) {
    fail('unknown-sidecar', 'sidecar id is not in the manifest');
  }
  let sidecars;
  try {
    const descriptor = manifest && typeof manifest === 'object'
      ? Object.getOwnPropertyDescriptor(manifest, 'sidecars')
      : null;
    sidecars = descriptor && 'value' in descriptor && Array.isArray(descriptor.value) ? descriptor.value : [];
  } catch {
    fail('unknown-sidecar', 'sidecar id is not in the manifest');
  }
  let lengthDescriptor;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(sidecars, 'length');
  } catch {
    fail('unknown-sidecar', 'sidecar id is not in the manifest');
  }
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : 0;
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(sidecars, String(index));
    } catch {
      fail('unknown-sidecar', 'sidecar id is not in the manifest');
    }
    const sidecar = descriptor && 'value' in descriptor ? descriptor.value : null;
    if (sidecar === null || typeof sidecar !== 'object') continue;
    let idDescriptor;
    try {
      idDescriptor = Object.getOwnPropertyDescriptor(sidecar, 'id');
    } catch {
      continue;
    }
    if (idDescriptor && 'value' in idDescriptor && idDescriptor.value === id) return sidecar;
  }
  fail('unknown-sidecar', 'sidecar id is not in the manifest');
}

export function resolveSidecarTarget(sidecar, platformKey = process.platform + '-' + process.arch) {
  if (typeof platformKey !== 'string' || !TARGET_KEY.test(platformKey)) {
    fail('unsupported-platform', 'platform key must be <platform>-<arch>');
  }
  let targets;
  try {
    const descriptor = sidecar && typeof sidecar === 'object'
      ? Object.getOwnPropertyDescriptor(sidecar, 'targets')
      : null;
    targets = descriptor && 'value' in descriptor ? descriptor.value : null;
  } catch {
    fail('unsupported-platform', 'the sidecar has no target for this platform');
  }
  if (!targets || typeof targets !== 'object') {
    fail('unsupported-platform', 'the sidecar has no target for this platform');
  }
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(targets, platformKey);
  } catch {
    fail('unsupported-platform', 'the sidecar has no target for this platform');
  }
  if (!descriptor || !('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object') {
    fail('unsupported-platform', 'the sidecar has no target for this platform');
  }
  return Object.freeze({ platformKey, target: descriptor.value });
}

function isAbsoluteLocalPath(value) {
  if (process.platform === 'win32') {
    if (value.startsWith('\\\\') || value.startsWith('//')) return false;
    return /^[A-Za-z]:[\\/]/.test(value) && value.length > 3;
  }
  return path.isAbsolute(value) && !value.startsWith('//');
}

function pathSegments(value) {
  return value.split(/[\\/]+/).filter((part) => part.length > 0);
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function resolveTargetDir(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATH_CHARS) {
    fail('invalid-destination', 'targetDir must be an absolute path');
  }
  if (CONTROL_OR_BIDI.test(value)) fail('invalid-destination', 'targetDir contains unsafe characters');
  if (!isAbsoluteLocalPath(value)) fail('invalid-destination', 'targetDir must be an absolute local path');
  for (const part of pathSegments(value)) {
    if (part === '.' || part === '..') {
      fail('invalid-destination', 'targetDir must not contain relative segments');
    }
    if (process.platform === 'win32' && /[. ]$/.test(part)) {
      fail('invalid-destination', 'targetDir has a Win32-invalid trailing dot or space');
    }
    const isDrive = process.platform === 'win32' && /^[A-Za-z]:$/.test(part);
    if (process.platform === 'win32' && !isDrive && (part.includes(':') || RESERVED_DEVICE.test(part))) {
      fail('invalid-destination', 'targetDir has a reserved Win32 name');
    }
  }
  let info;
  try {
    info = lstatSync(value);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') fail('invalid-destination', 'targetDir cannot be inspected');
    let ancestor = path.dirname(value);
    let ancestorInfo = null;
    for (;;) {
      try {
        ancestorInfo = lstatSync(ancestor);
        break;
      } catch (error2) {
        if (!error2 || error2.code !== 'ENOENT') fail('invalid-destination', 'targetDir cannot be inspected');
        const parent = path.dirname(ancestor);
        if (parent === ancestor) fail('invalid-destination', 'targetDir cannot be created');
        ancestor = parent;
      }
    }
    if (ancestorInfo.isSymbolicLink() || !ancestorInfo.isDirectory()) {
      fail('invalid-destination', 'targetDir must be a directory');
    }
    let ancestorReal;
    try {
      ancestorReal = realpathSync.native(ancestor);
    } catch {
      fail('invalid-destination', 'targetDir cannot be resolved');
    }
    if (!samePath(ancestorReal, path.resolve(ancestor))) {
      fail('invalid-destination', 'targetDir must not traverse a symlink or junction');
    }
    try {
      mkdirSync(value, { recursive: true });
      info = lstatSync(value);
    } catch {
      fail('invalid-destination', 'targetDir cannot be created');
    }
  }
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    fail('invalid-destination', 'targetDir must be a directory');
  }
  let real;
  try {
    real = realpathSync.native(value);
  } catch {
    fail('invalid-destination', 'targetDir cannot be resolved');
  }
  const resolved = path.resolve(value);
  if (!samePath(real, resolved)) fail('invalid-destination', 'targetDir must not traverse a symlink or junction');
  return resolved;
}

function containedPath(dir, relative) {
  const full = path.join(dir, ...relative.split('/'));
  const relation = path.relative(dir, full);
  if (relation.length < 1 || relation.startsWith('..') || path.isAbsolute(relation)) {
    fail('unsafe-path', 'an installed file would leave the target directory');
  }
  return full;
}

function inspectFile(filePath) {
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('unsafe-path', 'an installed file cannot be inspected');
  }
  if (info.isSymbolicLink() || !info.isFile()) fail('unsafe-path', 'an installed path must be a regular file');
  return info;
}

function removeQuietly(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
    /* the file is already gone */
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, { highWaterMark: HASH_CHUNK_BYTES });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function targetTotalBytes(target) {
  let total = 0;
  for (const file of target.files) total += file.sizeBytes;
  return total;
}

function installedSummary(sidecar, target, dir, installed, skipped) {
  return Object.freeze({
    verified: true,
    installed,
    skipped,
    executablePath: containedPath(dir, target.executable),
    version: sidecar.version,
    files: Object.freeze(target.files.map((file) => Object.freeze({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    }))),
    sizeBytes: targetTotalBytes(target),
  });
}

async function inspectInstall(sidecar, target, dir) {
  for (const file of target.files) {
    const full = containedPath(dir, file.path);
    let info;
    try {
      info = inspectFile(full);
    } catch {
      return { verified: false, reason: 'unsafe-path' };
    }
    if (!info) return { verified: false, reason: 'missing' };
    if (info.size !== file.sizeBytes) return { verified: false, reason: 'size' };
    let digest;
    try {
      digest = await hashFile(full);
    } catch {
      return { verified: false, reason: 'unsafe-path' };
    }
    if (digest !== file.sha256) return { verified: false, reason: 'checksum' };
  }
  return { verified: true };
}

function assertArchiveEntryName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_PATH_CHARS) {
    fail('unsafe-entry', 'an archive entry name is not bounded');
  }
  if (name.includes('\u0000') || CONTROL_OR_BIDI.test(name)) {
    fail('unsafe-entry', 'an archive entry name contains unsafe characters');
  }
  if (name.startsWith('/') || name.startsWith('\\') || name.includes('\\') || name.includes(':')) {
    fail('unsafe-entry', 'an archive entry name must be a relative path');
  }
  const directory = name.endsWith('/');
  const parts = name.split('/');
  const limit = directory ? parts.length - 1 : parts.length;
  if (limit < 1) fail('unsafe-entry', 'an archive entry name must be a relative path');
  for (let index = 0; index < limit; index += 1) {
    const part = parts[index];
    if (part.length < 1 || part.length > MAX_FILE_NAME_CHARS) {
      fail('unsafe-entry', 'an archive entry name has an invalid segment');
    }
    if (part === '.' || part === '..') fail('unsafe-entry', 'an archive entry name has a relative segment');
    if (/[. ]$/.test(part)) fail('unsafe-entry', 'an archive entry name has a Win32-invalid segment');
    if (RESERVED_DEVICE.test(part)) {
      fail('unsafe-entry', 'an archive entry name uses a reserved Win32 device');
    }
  }
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_BYTES) fail('invalid-archive', 'the archive is not a ZIP file');
  let eocd = -1;
  const first = Math.max(0, buffer.length - MAX_EOCD_SCAN);
  for (let at = buffer.length - EOCD_BYTES; at >= first; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) fail('invalid-archive', 'the archive has no ZIP directory');
  const disk = buffer.readUInt16LE(eocd + 4);
  const directoryDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries) {
    fail('invalid-archive', 'multi-disk archives are not supported');
  }
  if (totalEntries < 1 || totalEntries > MAX_ZIP_ENTRIES) fail('invalid-archive', 'the archive has an unsupported entry count');
  if (totalEntries === 0xffff || directorySize === ZIP64_SENTINEL || directoryOffset === ZIP64_SENTINEL) {
    fail('invalid-archive', 'ZIP64 archives are not supported');
  }
  if (directorySize < 1 || directorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    fail('invalid-archive', 'the archive directory is out of bounds');
  }
  if (directoryOffset + directorySize > buffer.length) fail('invalid-archive', 'the archive directory is out of bounds');
  const entries = [];
  const names = new Set();
  let at = directoryOffset;
  const end = directoryOffset + directorySize;
  for (let index = 0; index < totalEntries; index += 1) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      fail('invalid-archive', 'the archive directory is malformed');
    }
    const flags = buffer.readUInt16LE(at + 8);
    if ((flags & 0x1) !== 0) fail('invalid-archive', 'encrypted archive entries are not supported');
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const startDisk = buffer.readUInt16LE(at + 34);
    const externalAttributes = buffer.readUInt32LE(at + 38);
    const localOffset = buffer.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (nameLength < 1 || next > end) fail('invalid-archive', 'the archive directory is malformed');
    if (startDisk !== 0) fail('invalid-archive', 'multi-disk archives are not supported');
    let name;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(at + 46, at + 46 + nameLength));
    } catch {
      fail('invalid-archive', 'an archive entry name is not UTF-8');
    }
    assertArchiveEntryName(name);
    if (names.has(name)) fail('invalid-archive', 'the archive has a duplicate entry');
    names.add(name);
    if (((externalAttributes >>> 16) & S_IFMT) === S_IFLNK) {
      fail('unsafe-entry', 'the archive carries a symbolic link');
    }
    entries.push({ name, flags, method, compressedSize, size, externalAttributes, localOffset });
    at = next;
  }
  return entries;
}

function extractAllowlisted(buffer, entries, target) {
  const byName = new Map();
  for (const entry of entries) byName.set(entry.name, entry);
  const out = new Map();
  let total = 0;
  for (const file of target.files) {
    const record = byName.get(file.path);
    if (!record) fail('missing-entry', 'the archive does not carry a pinned runtime file');
    if ((record.flags & 0x1) !== 0) fail('invalid-archive', 'encrypted archive entries are not supported');
    const mode = record.externalAttributes >>> 16;
    if ((mode & S_IFMT) === S_IFLNK) fail('unsafe-entry', 'the archive carries a symbolic link');
    if (record.size > MAX_FILE_BYTES) fail('entry-too-large', 'an archive entry is too large');
    if (record.method !== 0 && record.method !== 8) {
      fail('invalid-archive', 'an archive entry uses an unsupported compression method');
    }
    if (record.localOffset + 30 > buffer.length || buffer.readUInt32LE(record.localOffset) !== LOCAL_SIGNATURE) {
      fail('invalid-archive', 'an archive entry header is malformed');
    }
    const localNameLength = buffer.readUInt16LE(record.localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(record.localOffset + 28);
    const dataStart = record.localOffset + 30 + localNameLength + localExtraLength;
    const localName = buffer.subarray(record.localOffset + 30, record.localOffset + 30 + localNameLength);
    if (!localName.equals(Buffer.from(record.name, 'utf8'))) {
      fail('invalid-archive', 'an archive entry header is malformed');
    }
    if (dataStart + record.compressedSize > buffer.length) {
      fail('invalid-archive', 'an archive entry runs past the archive');
    }
    const stored = buffer.subarray(dataStart, dataStart + record.compressedSize);
    let data;
    if (record.method === 0) {
      if (record.compressedSize !== record.size) fail('invalid-archive', 'an archive entry has an inconsistent size');
      data = Buffer.from(stored);
    } else {
      try {
        data = inflateRawSync(stored, { maxOutputLength: record.size + 1 });
      } catch {
        fail('invalid-archive', 'an archive entry cannot be decompressed');
      }
    }
    if (data.length !== record.size) fail('invalid-archive', 'an archive entry has an inconsistent size');
    if (data.length !== file.sizeBytes) fail('entry-size', 'an archive entry does not match the pinned size');
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) {
      fail('entry-checksum', 'an archive entry does not match the pinned digest');
    }
    total += data.length;
    if (total > MAX_TOTAL_BYTES) fail('entry-too-large', 'the archive exceeds the supported total size');
    out.set(file.path, data);
  }
  return out;
}

function writeInstall(dir, target, buffers) {
  const pending = [];
  try {
    for (const file of target.files) {
      const full = containedPath(dir, file.path);
      const parent = path.dirname(full);
      try {
        mkdirSync(parent, { recursive: true });
      } catch {
        fail('write-failed', 'an install directory cannot be created');
      }
      let realParent;
      try {
        realParent = realpathSync.native(parent);
      } catch {
        fail('write-failed', 'an install directory cannot be resolved');
      }
      const relation = path.relative(dir, realParent);
      if (!samePath(realParent, path.resolve(parent)) || relation.startsWith('..') || path.isAbsolute(relation)) {
        fail('unsafe-path', 'an install directory would leave the target directory');
      }
      const temp = path.join(parent, '.install-' + randomBytes(8).toString('hex') + '.tmp');
      try {
        writeFileSync(temp, buffers.get(file.path), { flag: 'wx' });
      } catch {
        removeQuietly(temp);
        fail('write-failed', 'an install file cannot be written');
      }
      pending.push({ temp, full });
    }
    for (const item of pending) {
      try {
        renameSync(item.temp, item.full);
      } catch {
        fail('install-failed', 'a verified file cannot be installed');
      }
    }
  } catch (error) {
    for (const item of pending) removeQuietly(item.temp);
    throw error;
  }
}

function validateExecutable(dir, target) {
  const executablePath = containedPath(dir, target.executable);
  if (process.platform !== 'win32') {
    try {
      chmodSync(executablePath, 0o755);
    } catch {
      fail('invalid-executable', 'the installed executable cannot be marked executable');
    }
  }
  try {
    validateLlamaExecutablePath(executablePath);
  } catch {
    fail('invalid-executable', 'the installed executable does not satisfy the supervisor contract');
  }
  return executablePath;
}

function assertResponseUrl(value, allowLoopback) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('insecure-redirect', 'the transfer did not end on a validated URL');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    fail('insecure-redirect', 'the transfer did not end on a validated URL');
  }
  const secure = parsed.protocol === 'https:';
  const local = allowLoopback && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  if (!secure && !local) fail('insecure-redirect', 'the transfer did not end on a validated URL');
  if (!allowLoopback && isInternalHost(parsed.hostname)) {
    fail('insecure-redirect', 'the transfer did not end on a validated URL');
  }
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function';
}

function validateInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail('invalid-options', label + ' must be an integer within the supported range');
  }
  return value;
}

function waitForDrain(stream, signal) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) {
      reject(new Error('write failed'));
      return;
    }
    const settle = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
    };
    const onDrain = () => { settle(); resolve(); };
    const onError = () => { settle(); reject(new Error('write failed')); };
    const onClose = () => { settle(); reject(new Error('write closed')); };
    const onAbort = () => { settle(); reject(new Error('write aborted')); };
    stream.once('drain', onDrain);
    stream.once('error', onError);
    stream.once('close', onClose);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function closeWriter(writer) {
  return new Promise((resolve, reject) => {
    if (writer.closed) {
      resolve();
      return;
    }
    writer.once('close', resolve);
    writer.once('error', reject);
    writer.end();
  });
}

async function downloadArchive(target, partPath, options) {
  const pinnedUrl = new URL(target.url);
  const allowLoopback = pinnedUrl.protocol === 'http:' && isLoopbackHost(pinnedUrl.hostname);
  const controller = new AbortController();
  let reason = null;
  const stop = (why) => {
    if (reason === null) reason = why;
    try { controller.abort(); } catch { /* already aborted */ }
  };
  const onCallerAbort = () => stop('aborted');
  if (options.signal) {
    if (options.signal.aborted) fail('aborted', 'the download was cancelled before it started');
    options.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  let idle = null;
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => stop('stalled'), options.idleTimeoutMs);
  };
  const totalTimer = setTimeout(() => stop('timeout'), options.totalTimeoutMs);
  let writer = null;
  let received = 0;
  try {
    touch();
    let response;
    try {
      response = await options.fetchImpl(target.url, {
        method: 'GET',
        headers: { accept: 'application/zip' },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch {
      fail(reason ?? 'network-error', 'the runtime binary request failed');
    }
    assertResponseUrl(response && response.url, allowLoopback);
    if (response.status !== 200) {
      try { await response.body?.cancel?.(); } catch { /* ignore */ }
      const error = new SidecarError('http-status', 'the runtime binary server returned an error status');
      error.status = Number.isInteger(response.status) ? response.status : 0;
      throw error;
    }
    const declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined && Number(declared) !== target.sizeBytes) {
      try { await response.body?.cancel?.(); } catch { /* ignore */ }
      fail('size-mismatch', 'the server announced an unexpected archive size');
    }
    const body = response.body;
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
      fail('invalid-response', 'the runtime binary server returned no body');
    }
    if (options.onProgress) {
      try {
        options.onProgress(Object.freeze({ received: 0, total: target.sizeBytes }));
      } catch { /* a progress display must not break the transfer */ }
    }
    writer = createWriteStream(partPath, { flags: 'wx' });
    writer.on('error', () => {});
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      if (received > target.sizeBytes) fail('size-mismatch', 'the server sent more bytes than the pinned archive');
      if (!writer.write(bytes)) {
        try {
          await waitForDrain(writer, controller.signal);
        } catch {
          if (controller.signal.aborted) fail(reason ?? 'aborted', 'the download was interrupted');
          fail('write-failed', 'the partial archive could not be written');
        }
      }
      touch();
      if (options.onProgress) {
        try {
          options.onProgress(Object.freeze({ received, total: target.sizeBytes }));
        } catch { /* a progress display must not break the transfer */ }
      }
    }
    await closeWriter(writer);
    writer = null;
    if (received !== target.sizeBytes) fail('network-error', 'the download ended before the pinned size');
  } catch (error) {
    if (writer) {
      const closing = writer;
      writer = null;
      await new Promise((resolve) => {
        if (closing.closed) {
          resolve();
          return;
        }
        try {
          closing.once('close', resolve);
          closing.once('error', resolve);
          closing.end();
        } catch {
          resolve();
        }
      });
    }
    removeQuietly(partPath);
    if (error instanceof SidecarError) throw error;
    fail(reason ?? 'network-error', 'the runtime binary download failed');
  } finally {
    if (idle) clearTimeout(idle);
    clearTimeout(totalTimer);
    if (options.signal) {
      try { options.signal.removeEventListener('abort', onCallerAbort); } catch { /* ignore */ }
    }
  }
}

function verifiedSummary(sidecar, target, dir) {
  return Object.freeze({
    verified: true,
    executablePath: containedPath(dir, target.executable),
    version: sidecar.version,
    files: Object.freeze(target.files.map((file) => Object.freeze({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    }))),
    sizeBytes: targetTotalBytes(target),
  });
}

export async function verifySidecarInstall(sidecar, options = {}) {
  const validated = validateSidecar(sidecar);
  const own = readOwnData(options, 'options', VERIFY_OPTION_KEYS, 'invalid-options');
  if (own.targetDir === undefined) fail('invalid-options', 'targetDir is required');
  const dir = resolveTargetDir(own.targetDir);
  const platformKey = own.platformKey ?? process.platform + '-' + process.arch;
  const resolved = resolveSidecarTarget(validated, platformKey);
  const result = await inspectInstall(validated, resolved.target, dir);
  if (!result.verified) {
    return Object.freeze({ verified: false, reason: result.reason, version: validated.version });
  }
  return verifiedSummary(validated, resolved.target, dir);
}

export async function installSidecar(sidecar, options = {}) {
  const validated = validateSidecar(sidecar);
  const own = readOwnData(options, 'options', INSTALL_OPTION_KEYS, 'invalid-options');
  if (own.targetDir === undefined) fail('invalid-options', 'targetDir is required');
  const dir = resolveTargetDir(own.targetDir);
  const platformKey = own.platformKey ?? process.platform + '-' + process.arch;
  const resolved = resolveSidecarTarget(validated, platformKey);
  const fetchImpl = own.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('runtime-unavailable', 'this runtime has no fetch implementation');
  if (own.onProgress !== undefined && typeof own.onProgress !== 'function') {
    fail('invalid-options', 'onProgress must be a function');
  }
  if (own.signal !== undefined && !isAbortSignal(own.signal)) fail('invalid-options', 'signal must be an AbortSignal');
  const idleTimeoutMs = validateInteger(own.idleTimeoutMs, 'idleTimeoutMs', MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS);
  const totalTimeoutMs = validateInteger(own.totalTimeoutMs, 'totalTimeoutMs', MIN_TOTAL_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS);
  const slot = process.platform === 'win32' ? dir.toLowerCase() : dir;
  if (ACTIVE.has(slot)) fail('busy', 'this sidecar directory is already installing');
  ACTIVE.add(slot);
  try {
    return await run();
  } finally {
    ACTIVE.delete(slot);
  }

  async function run() {
    const existing = await inspectInstall(validated, resolved.target, dir);
    if (existing.verified) return installedSummary(validated, resolved.target, dir, false, true);
    const partPath = path.join(dir, '.' + validated.id + '-' + validated.version + '.zip.part');
    inspectFile(partPath);
    removeQuietly(partPath);
    try {
      await downloadArchive(resolved.target, partPath, {
        fetchImpl,
        onProgress: own.onProgress,
        signal: own.signal,
        idleTimeoutMs,
        totalTimeoutMs,
      });
      let archive;
      try {
        archive = readFileSync(partPath);
      } catch {
        fail('invalid-archive', 'the downloaded archive cannot be read');
      }
      if (createHash('sha256').update(archive).digest('hex') !== resolved.target.sha256) {
        fail('checksum-mismatch', 'the downloaded archive did not match the pinned digest');
      }
      const entries = readZipEntries(archive);
      const buffers = extractAllowlisted(archive, entries, resolved.target);
      writeInstall(dir, resolved.target, buffers);
      const after = await inspectInstall(validated, resolved.target, dir);
      if (!after.verified) fail('install-failed', 'the installed runtime files did not verify');
      validateExecutable(dir, resolved.target);
      return installedSummary(validated, resolved.target, dir, true, false);
    } finally {
      removeQuietly(partPath);
    }
  }
}
