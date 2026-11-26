// M3 local model downloader.
//
// Installs pinned GGUF weights from the shipped catalog: a resumable HTTP transfer into a `.part`
// file, a size and SHA-256 check over the finished bytes, and one atomic rename to the final name.
// Everything is validated before a socket is opened: the catalog entry, the destination directory,
// the target names and the download URL. The transfer follows redirects under a bounded deadline,
// keeps a partial file for a later resume, and never installs bytes that fail the digest.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statfsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const MODEL_MODULE_VERSION = 1;
export const MODEL_CATALOG_VERSION = 1;
export const MAX_CATALOG_MODELS = 16;
export const MIN_MODEL_BYTES = 1;
export const MAX_MODEL_BYTES = 12 * 1024 * 1024 * 1024;
export const MIN_CONTEXT_TOKENS = 128;
export const MAX_CONTEXT_TOKENS = 8 * 1024 * 1024;
export const MAX_PATH_CHARS = 4096;
export const MAX_URL_CHARS = 2048;
export const MAX_FILE_NAME_CHARS = 128;
export const MAX_LABEL_CHARS = 120;
export const MAX_REPO_CHARS = 96;
export const MAX_ID_CHARS = 64;
export const MIN_IDLE_TIMEOUT_MS = 50;
export const MAX_IDLE_TIMEOUT_MS = 600_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
export const MIN_TOTAL_TIMEOUT_MS = 1_000;
export const MAX_TOTAL_TIMEOUT_MS = 86_400_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 3_600_000;
export const HASH_CHUNK_BYTES = 1024 * 1024;
export const LOOPBACK_HOSTS = Object.freeze([['127', '0', '0', '1'].join('.'), '[::1]']);
export const ALLOWED_LICENSES = Object.freeze(['apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause']);
export const MODEL_ROLES = Object.freeze(['chat', 'embedding', 'code', 'edit']);

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const ID = /^[a-z0-9][a-z0-9.-]*$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/;
const QUANTIZATION = /^[a-z0-9][a-z0-9._-]*$/;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const ENTRY_KEYS = Object.freeze([
  'id', 'label', 'repo', 'revision', 'file', 'url', 'sha256', 'sizeBytes', 'license',
  'quantization', 'contextTokens', 'role',
]);
const ENTRY_KEY_SET = new Set(ENTRY_KEYS);
const CATALOG_KEYS = new Set(['version', 'models']);
const OPTION_KEYS = new Set([
  'destinationDir', 'onProgress', 'signal', 'fetchImpl', 'statfsImpl', 'idleTimeoutMs', 'totalTimeoutMs',
]);
const VERIFY_OPTION_KEYS = new Set(['destinationDir']);
const DISCARD_CODES = new Set(['size-mismatch', 'checksum-mismatch']);

const ACTIVE = new Set();

export class ModelDownloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelDownloadError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ModelDownloadError(code, message);
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

// Reads own data descriptors once so an accessor is rejected without being invoked and a polluted
// prototype cannot contribute a key.
function readOwnData(value, label, allowed, code) {
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

function requireText(value, label, maximum, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    fail(code, label + ' must be a bounded non-empty string');
  }
  if (CONTROL_OR_BIDI.test(value)) fail(code, label + ' contains unsafe characters');
  return value;
}

function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string') return false;
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase());
}

function assertDownloadUrl(value, code) {
  requireText(value, 'url', MAX_URL_CHARS, code);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code, 'url must be a valid absolute URL');
  }
  if (parsed.username || parsed.password) fail(code, 'url must not embed credentials');
  if (parsed.search) fail(code, 'url must not carry a query string');
  if (parsed.hash) fail(code, 'url must not carry a fragment');
  const secure = parsed.protocol === 'https:';
  const local = parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  if (!secure && !local) fail(code, 'url must use https, or http on a loopback host');
  return value;
}

export function validateModelEntry(value) {
  const own = readOwnData(value, 'model', ENTRY_KEY_SET, 'invalid-model');
  for (const key of ENTRY_KEYS) {
    if (own[key] === undefined) fail('invalid-model', 'model is missing the ' + key + ' field');
  }
  if (Object.keys(own).length !== ENTRY_KEYS.length) fail('invalid-model', 'model has an unknown field');
  requireText(own.id, 'id', MAX_ID_CHARS, 'invalid-model');
  if (!ID.test(own.id)) fail('invalid-model', 'id must be a lowercase slug');
  requireText(own.label, 'label', MAX_LABEL_CHARS, 'invalid-model');
  requireText(own.repo, 'repo', MAX_REPO_CHARS, 'invalid-model');
  if (!REPO.test(own.repo)) fail('invalid-model', 'repo must be an owner/name pair');
  if (typeof own.revision !== 'string' || !REVISION.test(own.revision)) {
    fail('invalid-model', 'revision must be a 40-character lowercase commit id');
  }
  requireText(own.file, 'file', MAX_FILE_NAME_CHARS, 'invalid-model');
  if (!FILE_NAME.test(own.file) || own.file.includes('..')) fail('invalid-model', 'file must be a plain .gguf name');
  if (RESERVED_DEVICE.test(own.file.replace(/\.[^.]*$/, ''))) fail('invalid-model', 'file must not be a reserved device name');
  assertDownloadUrl(own.url, 'invalid-model');
  if (typeof own.sha256 !== 'string' || !DIGEST.test(own.sha256)) {
    fail('invalid-model', 'sha256 must be a 64-character lowercase digest');
  }
  if (!Number.isSafeInteger(own.sizeBytes) || own.sizeBytes < MIN_MODEL_BYTES || own.sizeBytes > MAX_MODEL_BYTES) {
    fail('invalid-model', 'sizeBytes must be a whole byte count within the modeled range');
  }
  if (typeof own.license !== 'string' || !ALLOWED_LICENSES.includes(own.license)) {
    fail('invalid-model', 'license must be a permissive license in the allowed set');
  }
  requireText(own.quantization, 'quantization', 24, 'invalid-model');
  if (!QUANTIZATION.test(own.quantization)) fail('invalid-model', 'quantization must be a lowercase tag');
  if (!Number.isSafeInteger(own.contextTokens) || own.contextTokens < MIN_CONTEXT_TOKENS || own.contextTokens > MAX_CONTEXT_TOKENS) {
    fail('invalid-model', 'contextTokens must be a whole token count within the modeled range');
  }
  if (typeof own.role !== 'string' || !MODEL_ROLES.includes(own.role)) {
    fail('invalid-model', 'role must be one of the modeled roles');
  }
  return Object.freeze({
    id: own.id,
    label: own.label,
    repo: own.repo,
    revision: own.revision,
    file: own.file,
    url: own.url,
    sha256: own.sha256,
    sizeBytes: own.sizeBytes,
    license: own.license,
    quantization: own.quantization,
    contextTokens: own.contextTokens,
    role: own.role,
  });
}

export function validateCatalog(value) {
  try {
    const own = readOwnData(value, 'catalog', CATALOG_KEYS, 'invalid-catalog');
    if (own.version !== MODEL_CATALOG_VERSION) fail('invalid-catalog', 'catalog version is not supported');
    let length;
    try {
      if (!Array.isArray(own.models)) fail('invalid-catalog', 'catalog models must be an array');
      length = own.models.length;
    } catch (error) {
      if (error instanceof ModelDownloadError) throw error;
      fail('invalid-catalog', 'catalog models cannot be read');
    }
    if (!Number.isInteger(length) || length < 1 || length > MAX_CATALOG_MODELS) {
      fail('invalid-catalog', 'catalog must list a bounded number of models');
    }
    const models = [];
    const ids = new Set();
    const files = new Set();
    for (let index = 0; index < length; index += 1) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(own.models, String(index));
      } catch {
        fail('invalid-catalog', 'catalog models cannot be read');
      }
      if (!descriptor || !('value' in descriptor)) fail('invalid-catalog', 'catalog models must be dense data');
      const model = validateModelEntry(descriptor.value);
      if (ids.has(model.id)) fail('invalid-catalog', 'catalog has a duplicate id');
      if (files.has(model.file)) fail('invalid-catalog', 'catalog has a duplicate file name');
      ids.add(model.id);
      files.add(model.file);
      models.push(model);
    }
    return Object.freeze({ version: MODEL_CATALOG_VERSION, models: Object.freeze(models) });
  } catch (error) {
    if (error instanceof ModelDownloadError && error.code === 'invalid-catalog') throw error;
    fail('invalid-catalog', 'catalog is malformed');
  }
}

export function loadCatalog(text) {
  if (typeof text !== 'string' || text.length < 1) fail('invalid-catalog', 'catalog must be JSON text');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid-catalog', 'catalog is not valid JSON');
  }
  return validateCatalog(parsed);
}

export function loadCatalogFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    fail('invalid-catalog', 'catalog file cannot be read');
  }
  return loadCatalog(text);
}

export function findCatalogModel(catalog, id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID_CHARS) {
    fail('unknown-model', 'model id is not in the catalog');
  }
  const models = catalog && Array.isArray(catalog.models) ? catalog.models : [];
  for (const model of models) {
    if (model && model.id === id) return model;
  }
  fail('unknown-model', 'model id is not in the catalog');
}

function isAbsoluteLocalPath(value) {
  if (process.platform === 'win32') {
    if (value.startsWith('\\\\') || value.startsWith('//')) return false;
    return /^[A-Za-z]:[\\/]/.test(value) && value.length > 3;
  }
  return path.isAbsolute(value) && !value.startsWith('//');
}

function segments(value) {
  return value.split(/[\\/]+/).filter((part) => part.length > 0);
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function resolveDestination(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATH_CHARS) {
    fail('invalid-destination', 'destinationDir must be an absolute path');
  }
  if (CONTROL_OR_BIDI.test(value)) fail('invalid-destination', 'destinationDir contains unsafe characters');
  if (!isAbsoluteLocalPath(value)) fail('invalid-destination', 'destinationDir must be an absolute local path');
  const parts = segments(value);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '.' || part === '..') fail('invalid-destination', 'destinationDir must not contain relative segments');
    if (process.platform === 'win32' && /[. ]$/.test(part)) {
      fail('invalid-destination', 'destinationDir has a Win32-invalid trailing dot or space');
    }
    const isDrive = process.platform === 'win32' && index === 0 && /^[A-Za-z]:$/.test(part);
    if (process.platform === 'win32' && !isDrive && (part.includes(':') || RESERVED_DEVICE.test(part.replace(/\.[^.]*$/, '')))) {
      fail('invalid-destination', 'destinationDir has a reserved Win32 name');
    }
  }
  let info;
  try {
    info = lstatSync(value);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') fail('invalid-destination', 'destinationDir cannot be inspected');
    // Verify the nearest existing ancestor before creating anything, so a junction above the new
    // directory cannot send the creation outside the intended tree.
    let ancestor = path.dirname(value);
    let ancestorInfo = null;
    for (;;) {
      try {
        ancestorInfo = lstatSync(ancestor);
        break;
      } catch (error2) {
        if (!error2 || error2.code !== 'ENOENT') fail('invalid-destination', 'destinationDir cannot be inspected');
        const parent = path.dirname(ancestor);
        if (parent === ancestor) fail('invalid-destination', 'destinationDir cannot be created');
        ancestor = parent;
      }
    }
    if (ancestorInfo.isSymbolicLink() || !ancestorInfo.isDirectory()) {
      fail('invalid-destination', 'destinationDir must be a directory');
    }
    let ancestorReal;
    try {
      ancestorReal = realpathSync.native(ancestor);
    } catch {
      fail('invalid-destination', 'destinationDir cannot be resolved');
    }
    if (!samePath(ancestorReal, path.resolve(ancestor))) {
      fail('invalid-destination', 'destinationDir must not traverse a symlink or junction');
    }
    try {
      mkdirSync(value, { recursive: true });
      info = lstatSync(value);
    } catch {
      fail('invalid-destination', 'destinationDir cannot be created');
    }
  }
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    fail('invalid-destination', 'destinationDir must be a directory');
  }
  let real;
  try {
    real = realpathSync.native(value);
  } catch {
    fail('invalid-destination', 'destinationDir cannot be resolved');
  }
  const resolved = path.resolve(value);
  if (!samePath(real, resolved)) fail('invalid-destination', 'destinationDir must not traverse a symlink or junction');
  return resolved;
}

function inspectFile(filePath) {
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('unsafe-path', 'a target file cannot be inspected');
  }
  if (info.isSymbolicLink() || !info.isFile()) fail('unsafe-path', 'a target path must be a regular file');
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

function checkFileSize(filePath, entry) {
  let info;
  try {
    info = lstatSync(filePath);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (info.isSymbolicLink() || !info.isFile()) return { ok: false, reason: 'missing' };
  if (info.size !== entry.sizeBytes) return { ok: false, reason: 'size' };
  return { ok: true, reason: 'size' };
}

async function verifyFile(filePath, entry) {
  const basic = checkFileSize(filePath, entry);
  if (!basic.ok) return basic;
  let digest;
  try {
    digest = await hashFile(filePath);
  } catch {
    return { ok: false, reason: 'read' };
  }
  if (digest !== entry.sha256) return { ok: false, reason: 'checksum' };
  return { ok: true, reason: 'checksum' };
}

function parseContentRange(value) {
  if (typeof value !== 'string') return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

function assertResponseUrl(value, allowLoopback) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('insecure-redirect', 'the download did not end on a validated URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('insecure-redirect', 'the download did not end on a validated URL');
  }
  const secure = parsed.protocol === 'https:';
  const local = allowLoopback && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  if (!secure && !local) fail('insecure-redirect', 'the download did not end on a validated URL');
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function';
}

function validateInteger(value, label, minimum, maximum, fallback, code = 'invalid-options') {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail(code, label + ' must be an integer within the supported range');
  }
  return value;
}

function defaultStatfs(dirPath) {
  if (typeof statfsSync !== 'function') return null;
  try {
    return statfsSync(dirPath);
  } catch {
    return null;
  }
}

export async function verifyInstalledModel(model, options = {}) {
  const entry = validateModelEntry(model);
  const own = readOwnData(options, 'options', VERIFY_OPTION_KEYS, 'invalid-options');
  const dir = resolveDestination(own.destinationDir);
  const filePath = path.join(dir, entry.file);
  const info = inspectFile(filePath);
  if (!info) return Object.freeze({ verified: false, path: filePath, sizeBytes: entry.sizeBytes });
  if (info.size !== entry.sizeBytes) return Object.freeze({ verified: false, path: filePath, sizeBytes: entry.sizeBytes });
  const verified = await verifyFile(filePath, entry);
  return Object.freeze({ verified: verified.ok, path: filePath, sizeBytes: entry.sizeBytes });
}

export async function downloadModel(model, options = {}) {
  const entry = validateModelEntry(model);
  const own = readOwnData(options, 'options', OPTION_KEYS, 'invalid-options');
  if (own.destinationDir === undefined) fail('invalid-options', 'destinationDir is required');
  const dir = resolveDestination(own.destinationDir);
  const onProgress = own.onProgress;
  if (onProgress !== undefined && typeof onProgress !== 'function') fail('invalid-options', 'onProgress must be a function');
  if (own.signal !== undefined && !isAbortSignal(own.signal)) fail('invalid-options', 'signal must be an AbortSignal');
  const fetchImpl = own.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('runtime-unavailable', 'this runtime has no fetch implementation');
  const statfsImpl = own.statfsImpl ?? defaultStatfs;
  if (typeof statfsImpl !== 'function') fail('invalid-options', 'statfsImpl must be a function');
  const idleTimeoutMs = validateInteger(own.idleTimeoutMs, 'idleTimeoutMs', MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS);
  const totalTimeoutMs = validateInteger(own.totalTimeoutMs, 'totalTimeoutMs', MIN_TOTAL_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS);
  const finalPath = path.join(dir, entry.file);
  const partPath = finalPath + '.part';
  const pinnedUrl = new URL(entry.url);
  const allowLoopbackFinal = pinnedUrl.protocol === 'http:' && isLoopbackHost(pinnedUrl.hostname);
  const slot = process.platform === 'win32' ? finalPath.toLowerCase() : finalPath;
  if (ACTIVE.has(slot)) fail('busy', 'this model file is already downloading');
  ACTIVE.add(slot);
  try {
    return await run();
  } finally {
    ACTIVE.delete(slot);
  }

  async function run() {
    const deadline = Date.now() + totalTimeoutMs;
    if (own.signal && own.signal.aborted) fail('aborted', 'the download was cancelled before it started');
    let replacedInvalid = false;
    const existing = inspectFile(finalPath);
    if (existing) {
      const present = await verifyFile(finalPath, entry);
      if (present.ok) {
        return Object.freeze({
          verified: true,
          skipped: true,
          resumed: false,
          resumedFrom: 0,
          restarted: false,
          replacedInvalid: false,
          sizeBytes: entry.sizeBytes,
          sha256: entry.sha256,
          path: finalPath,
        });
      }
      replacedInvalid = true;
    }

    let resumedFrom = 0;
    const part = inspectFile(partPath);
    if (part) {
      resumedFrom = part.size;
      if (resumedFrom > entry.sizeBytes) {
        removeQuietly(partPath);
        resumedFrom = 0;
      }
    }
    if (resumedFrom === entry.sizeBytes) {
      const complete = await verifyFile(partPath, entry);
      if (complete.ok) {
        renameSync(partPath, finalPath);
        return Object.freeze({
          verified: true,
          skipped: false,
          resumed: true,
          resumedFrom,
          restarted: false,
          replacedInvalid,
          sizeBytes: entry.sizeBytes,
          sha256: entry.sha256,
          path: finalPath,
        });
      }
      removeQuietly(partPath);
      resumedFrom = 0;
    }

    let free = null;
    try {
      const info = await statfsImpl(dir);
      if (info && Number.isFinite(Number(info.bavail)) && Number.isFinite(Number(info.bsize))) {
        free = Number(info.bavail) * Number(info.bsize);
      }
    } catch {
      free = null;
    }
    if (free !== null && free < entry.sizeBytes) {
      fail('insufficient-space', 'the destination does not have room for the model');
    }

    let startedAt = resumedFrom;
    let restarted = false;
    let attemptIndex = 0;
    const retryAllowed = resumedFrom > 0;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) fail('timeout', 'the download did not finish in time');
      let outcome;
      try {
        outcome = await transfer({ startAt: startedAt, remainingMs });
      } catch (error) {
        if (error instanceof ModelDownloadError && DISCARD_CODES.has(error.code)) removeQuietly(partPath);
        throw error;
      }
      startedAt = outcome.startAt;
      restarted = restarted || outcome.restarted;
      attemptIndex += 1;
      const result = await verifyFile(partPath, entry);
      if (result.ok) {
        try {
          renameSync(partPath, finalPath);
        } catch {
          fail('install-failed', 'the verified model could not be installed');
        }
        return Object.freeze({
          verified: true,
          skipped: false,
          resumed: resumedFrom > 0 && !restarted,
          resumedFrom,
          restarted,
          replacedInvalid,
          sizeBytes: entry.sizeBytes,
          sha256: entry.sha256,
          path: finalPath,
        });
      }
      removeQuietly(partPath);
      if (attemptIndex >= 2 || !retryAllowed) {
        fail(result.reason === 'size' ? 'size-mismatch' : 'checksum-mismatch', 'the downloaded model did not match the pinned file');
      }
      startedAt = 0;
      restarted = true;
    }
  }

  async function transfer({ startAt, remainingMs }) {
    const controller = new AbortController();
    let reason = null;
    const callerSignal = own.signal;
    const onCallerAbort = () => {
      if (reason === null) reason = 'aborted';
      try { controller.abort(); } catch { /* already aborted */ }
    };
    if (callerSignal) callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    let idle = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        if (reason === null) reason = 'stalled';
        try { controller.abort(); } catch { /* already aborted */ }
      }, idleTimeoutMs);
      if (typeof idle.unref === 'function') idle.unref();
    };
    const totalTimer = setTimeout(() => {
      if (reason === null) reason = 'timeout';
      try { controller.abort(); } catch { /* already aborted */ }
    }, remainingMs);
    if (typeof totalTimer.unref === 'function') totalTimer.unref();
    const cleanup = () => {
      if (idle) clearTimeout(idle);
      clearTimeout(totalTimer);
      if (callerSignal) {
        try { callerSignal.removeEventListener('abort', onCallerAbort); } catch { /* ignore */ }
      }
    };

    let received = startAt;
    let restartFromZero = false;
    let writer = null;
    try {
      touch();
      const headers = { accept: 'application/octet-stream' };
      if (startAt > 0) headers.range = 'bytes=' + startAt + '-';
      let response;
      try {
        response = await fetchImpl(entry.url, {
          method: 'GET',
          headers,
          redirect: 'follow',
          signal: controller.signal,
        });
      } catch {
        fail(reason ?? 'network-error', 'the download request failed');
      }
      assertResponseUrl(response && response.url, allowLoopbackFinal);
      const status = response.status;
      if (status === 416) {
        try { await response.body?.cancel?.(); } catch { /* ignore */ }
        fail('range-not-satisfiable', 'the server rejected the resume offset');
      }
      if (status === 206) {
        const range = parseContentRange(response.headers?.get?.('content-range'));
        if (!range || range.start !== startAt || range.total !== entry.sizeBytes) {
          try { await response.body?.cancel?.(); } catch { /* ignore */ }
          fail('invalid-range-response', 'the server returned an unexpected range');
        }
      } else if (status !== 200) {
        try { await response.body?.cancel?.(); } catch { /* ignore */ }
        const error = new ModelDownloadError('http-status', 'the download server returned an error status');
        error.status = Number.isInteger(status) ? status : 0;
        throw error;
      } else if (startAt > 0) {
        restartFromZero = true;
        received = 0;
      }
      if (status === 200 && !restartFromZero) {
        const declared = response.headers?.get?.('content-length');
        if (declared !== null && declared !== undefined && Number(declared) !== entry.sizeBytes) {
          try { await response.body?.cancel?.(); } catch { /* ignore */ }
          fail('size-mismatch', 'the server announced an unexpected file size');
        }
      }
      const body = response.body;
      if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
        fail('invalid-response', 'the download server returned no body');
      }
      if (onProgress) {
        try {
          onProgress(Object.freeze({ received, total: entry.sizeBytes, resumedFrom: startAt }));
        } catch { /* a progress display must not break the transfer */ }
      }
      const flags = restartFromZero ? 'w' : (startAt > 0 ? 'a' : 'w');
      // Re-check the partial path at the point of use: a symlink planted after the initial
      // inspection must not be appended to or truncated.
      inspectFile(partPath);
      try {
        writer = createWriteStream(partPath, { flags });
      } catch {
        fail('write-failed', 'the partial file could not be opened');
      }
      writer.on('error', () => {});
      for await (const chunk of body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > entry.sizeBytes) {
          fail('size-mismatch', 'the download server sent more bytes than the pinned file');
        }
        const ok = writer.write(bytes);
        if (!ok) {
          try {
            await waitForDrain(writer, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) fail(reason ?? 'aborted', 'the download was interrupted');
            fail('write-failed', 'the partial file could not be written');
          }
        }
        touch();
        if (onProgress) {
          try {
            onProgress(Object.freeze({ received, total: entry.sizeBytes, resumedFrom: startAt }));
          } catch { /* a progress display must not break the transfer */ }
        }
      }
      await new Promise((resolve, reject) => {
        if (writer.closed) {
          resolve();
          return;
        }
        writer.once('close', resolve);
        writer.once('error', reject);
        writer.end();
      });
      if (received !== entry.sizeBytes) fail('network-error', 'the download ended before the pinned size');
      return { startAt: restartFromZero ? 0 : startAt, restarted: restartFromZero };
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
      if (error instanceof ModelDownloadError) throw error;
      fail(reason ?? 'network-error', 'the download failed');
    } finally {
      cleanup();
    }
  }
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
