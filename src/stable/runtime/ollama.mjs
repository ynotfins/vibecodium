// M3 local Ollama discovery.
//
// Finds an already running local Ollama daemon and projects what it can serve without asking the
// user to type a URL or a model name. The probe is loopback-only and read-only: one GET to
// `/api/tags` on `127.0.0.1:<port>`, a bounded body, own-descriptor parsing of an untrusted answer,
// and no credentials. The result feeds the B1 `ollama` provider preset through the two overrides
// `resolveProviderConfig('ollama', ...)` takes (`baseUrl`, `model`). It never starts, installs, stops
// or updates Ollama, and it never pulls a model.

import { evaluateAIEndpointRequest } from '../security/ai-endpoint-policy.mjs';

export const OLLAMA_MODULE_VERSION = 1;
export const OLLAMA_HOST = ['127', '0', '0', '1'].join('.');
export const DEFAULT_OLLAMA_PORT = 11_434;
export const MIN_PORT = 1024;
export const MAX_PORT = 65_535;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 10_000;
export const DEFAULT_TIMEOUT_MS = 1_500;
export const MIN_RESPONSE_BYTES = 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RESPONSE_BYTES = 256 * 1024;
export const MAX_MODELS = 256;
export const MAX_MODEL_NAME_CHARS = 200;
export const MAX_METADATA_CHARS = 64;
export const MAX_REMOTE_CHARS = 512;
export const MAX_FAMILIES = 16;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
// A strict subset of the class the provider preset accepts, so a discovered name can never reach
// `resolveProviderConfig` and be rejected there.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const OPTION_KEYS = new Set(['port', 'timeoutMs', 'maxResponseBytes', 'fetch', 'evaluate']);
const PROVIDER_OPTION_KEYS = new Set(['model']);
const RESULT_KEYS = new Set([
  'version', 'available', 'reason', 'status', 'port', 'baseUrl', 'models', 'chatModel',
  'embeddingModel', 'notices',
]);
const MODEL_KEYS = new Set(['id', 'sizeBytes', 'parameterSize', 'quantization', 'family', 'embedding', 'remote']);
const ERROR_NOTICES = Object.freeze([
  'ollama-unreachable', 'ollama-timeout', 'ollama-http-error', 'ollama-invalid-response',
  'ollama-policy-denied',
]);
const SUCCESS_NOTICES = Object.freeze([
  'ollama-no-models', 'ollama-no-chat-model', 'ollama-no-embedding-model', 'ollama-remote-models',
]);
const NOTICE_ORDER = Object.freeze(ERROR_NOTICES.concat(SUCCESS_NOTICES));
const NOTICE_RANK = new Map(NOTICE_ORDER.map(function (code, index) { return [code, index]; }));

const UNREACHABLE_NOTICE = 'ollama-unreachable';
const TIMEOUT_NOTICE = 'ollama-timeout';
const HTTP_ERROR_NOTICE = 'ollama-http-error';
const INVALID_NOTICE = 'ollama-invalid-response';
const POLICY_NOTICE = 'ollama-policy-denied';

const DEADLINE = Symbol('deadline');

export class OllamaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OllamaError(code, message);
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

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

function readOptionalData(value, key, code) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(code, 'the daemon answer has an unsafe property');
  }
  if (!descriptor) return undefined;
  if ('get' in descriptor || 'set' in descriptor) fail(code, 'the daemon answer must contain data only');
  return descriptor.value;
}

function isWellFormed(value) {
  return typeof value.isWellFormed === 'function' ? value.isWellFormed() : true;
}

function safeText(value, label, maximum, code) {
  if (typeof value !== 'string' || value.length > maximum) {
    fail(code, label + ' is invalid');
  }
  if (CONTROL_OR_BIDI.test(value) || !isWellFormed(value)) fail(code, label + ' is invalid');
  return value;
}

function validateInteger(value, label, minimum, maximum, code) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail(code, label + ' must be an integer from ' + minimum + ' to ' + maximum);
  }
  return value;
}

function tagsUrl(port) {
  return 'http://' + OLLAMA_HOST + ':' + port + '/api/tags';
}

export function buildOllamaBaseUrl(port) {
  const checked = validateInteger(port, 'port', MIN_PORT, MAX_PORT, 'invalid-options');
  return 'http://' + OLLAMA_HOST + ':' + checked + '/v1';
}

function validateOptions(options) {
  const own = options === undefined ? Object.create(null) : readOwnData(options, 'options', OPTION_KEYS, 'invalid-options');
  const port = own.port === undefined
    ? DEFAULT_OLLAMA_PORT
    : validateInteger(own.port, 'port', MIN_PORT, MAX_PORT, 'invalid-options');
  const timeoutMs = own.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : validateInteger(own.timeoutMs, 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 'invalid-options');
  const maxResponseBytes = own.maxResponseBytes === undefined
    ? DEFAULT_RESPONSE_BYTES
    : validateInteger(own.maxResponseBytes, 'maxResponseBytes', MIN_RESPONSE_BYTES, MAX_RESPONSE_BYTES, 'invalid-options');
  if (own.fetch !== undefined && typeof own.fetch !== 'function') {
    fail('invalid-options', 'fetch must be a function');
  }
  if (own.evaluate !== undefined && typeof own.evaluate !== 'function') {
    fail('invalid-options', 'evaluate must be a function');
  }
  const fetchImpl = own.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('invalid-options', 'this runtime has no fetch implementation');
  const evaluate = own.evaluate ?? evaluateAIEndpointRequest;
  const injectedFetch = own.fetch !== undefined;
  return Object.freeze({ port, timeoutMs, maxResponseBytes, fetch: fetchImpl, evaluate, injectedFetch });
}

function readFamilies(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  let length;
  try {
    if (!Array.isArray(value)) length = -1;
    else length = value.length;
  } catch {
    fail(INVALID_NOTICE, 'the daemon answer has an unsafe family list');
  }
  if (!Number.isInteger(length) || length < 0 || length > MAX_FAMILIES) {
    fail(INVALID_NOTICE, 'the daemon answer has an invalid family list');
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail(INVALID_NOTICE, 'the daemon answer has an unsafe family entry');
    }
    if (!descriptor || !('value' in descriptor)) fail(INVALID_NOTICE, 'the daemon answer must contain data only');
    out.push(safeText(descriptor.value, 'a model family', MAX_METADATA_CHARS, INVALID_NOTICE));
  }
  return Object.freeze(out);
}

function optionalText(value, key, label, maximum) {
  const raw = readOptionalData(value, key, INVALID_NOTICE);
  if (raw === undefined || raw === null) return null;
  return safeText(raw, label, maximum, INVALID_NOTICE);
}

function projectModel(entry) {
  if (!isPlainObject(entry)) fail(INVALID_NOTICE, 'the daemon answer has an invalid model entry');
  const name = readOptionalData(entry, 'name', INVALID_NOTICE);
  const fallback = readOptionalData(entry, 'model', INVALID_NOTICE);
  const raw = name === undefined ? fallback : name;
  if (typeof raw !== 'string' || !MODEL_NAME.test(raw) || CONTROL_OR_BIDI.test(raw) || !isWellFormed(raw)) {
    fail(INVALID_NOTICE, 'the daemon answer has an invalid model name');
  }
  const id = raw;
  let sizeBytes = readOptionalData(entry, 'size', INVALID_NOTICE);
  if (sizeBytes === undefined || sizeBytes === null) {
    sizeBytes = null;
  } else if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > Number.MAX_SAFE_INTEGER) {
    fail(INVALID_NOTICE, 'the daemon answer has an invalid model size');
  }
  const details = readOptionalData(entry, 'details', INVALID_NOTICE);
  let family = null;
  let families = Object.freeze([]);
  let parameterSize = null;
  let quantization = null;
  if (details !== undefined && details !== null) {
    if (!isPlainObject(details)) fail(INVALID_NOTICE, 'the daemon answer has invalid model details');
    family = optionalText(details, 'family', 'a model family', MAX_METADATA_CHARS);
    const familiesValue = readOptionalData(details, 'families', INVALID_NOTICE);
    if (familiesValue !== undefined) families = readFamilies(familiesValue);
    parameterSize = optionalText(details, 'parameter_size', 'a parameter size', MAX_METADATA_CHARS);
    quantization = optionalText(details, 'quantization_level', 'a quantization level', MAX_METADATA_CHARS);
  }
  const remoteModel = optionalText(entry, 'remote_model', 'a remote model', MAX_REMOTE_CHARS);
  const remoteHost = optionalText(entry, 'remote_host', 'a remote host', MAX_REMOTE_CHARS);
  const remote = remoteModel !== null || remoteHost !== null || /:cloud$/iu.test(id);
  const embedding = families.some((value) => /bert/iu.test(value))
    || (family !== null && /bert/iu.test(family))
    || /embed/iu.test(id);
  return Object.freeze({
    id,
    sizeBytes,
    parameterSize,
    quantization,
    family,
    embedding,
    remote,
  });
}

function sizeOf(entry) {
  return entry.sizeBytes === null ? -1 : entry.sizeBytes;
}

function pickModel(models, embedding) {
  let best = null;
  for (const entry of models) {
    if (entry.remote || entry.embedding !== embedding) continue;
    if (best === null) {
      best = entry;
      continue;
    }
    const size = sizeOf(entry);
    const bestSize = sizeOf(best);
    if (size > bestSize || (size === bestSize && entry.id < best.id)) best = entry;
  }
  return best === null ? null : best.id;
}

function orderedNotices(notices) {
  return Object.freeze([...new Set(notices)].sort(function (left, right) {
    const leftRank = NOTICE_RANK.has(left) ? NOTICE_RANK.get(left) : NOTICE_ORDER.length;
    const rightRank = NOTICE_RANK.has(right) ? NOTICE_RANK.get(right) : NOTICE_ORDER.length;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left < right ? -1 : left > right ? 1 : 0;
  }));
}

function unavailable(port, reason, notice, status) {
  return Object.freeze({
    version: OLLAMA_MODULE_VERSION,
    available: false,
    reason,
    status: status === undefined ? null : status,
    port,
    baseUrl: null,
    models: Object.freeze([]),
    chatModel: null,
    embeddingModel: null,
    notices: orderedNotices([notice]),
  });
}

function projectPayload(payload, port) {
  if (!isPlainObject(payload)) fail(INVALID_NOTICE, 'the daemon answer is not an object');
  const modelsValue = readOptionalData(payload, 'models', INVALID_NOTICE);
  let length;
  try {
    if (!Array.isArray(modelsValue)) length = -1;
    else length = modelsValue.length;
  } catch {
    fail(INVALID_NOTICE, 'the daemon answer has an unsafe model list');
  }
  if (!Number.isInteger(length) || length < 0 || length > MAX_MODELS) {
    fail(INVALID_NOTICE, 'the daemon answer has an invalid model list');
  }
  const models = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(modelsValue, String(index));
    } catch {
      fail(INVALID_NOTICE, 'the daemon answer has an unsafe model entry');
    }
    if (!descriptor || !('value' in descriptor)) fail(INVALID_NOTICE, 'the daemon answer must contain data only');
    models.push(projectModel(descriptor.value));
  }
  models.sort(function (left, right) {
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const frozenModels = Object.freeze(models);
  const chatModel = pickModel(frozenModels, false);
  const embeddingModel = pickModel(frozenModels, true);
  const notices = [];
  if (frozenModels.length === 0) notices.push('ollama-no-models');
  if (chatModel === null) notices.push('ollama-no-chat-model');
  if (embeddingModel === null) notices.push('ollama-no-embedding-model');
  if (frozenModels.some((entry) => entry.remote)) notices.push('ollama-remote-models');
  return Object.freeze({
    version: OLLAMA_MODULE_VERSION,
    available: true,
    reason: null,
    status: 200,
    port,
    baseUrl: buildOllamaBaseUrl(port),
    models: frozenModels,
    chatModel,
    embeddingModel,
    notices: orderedNotices(notices),
  });
}

async function readBoundedBody(response, maxBytes, allowTextFallback) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    if (!allowTextFallback) {
      throw new OllamaError(INVALID_NOTICE, 'the daemon answer has no body stream');
    }
    let text;
    try {
      text = await response.text();
    } catch {
      throw new OllamaError(INVALID_NOTICE, 'the daemon answer cannot be read');
    }
    if (typeof text !== 'string') {
      throw new OllamaError(INVALID_NOTICE, 'the daemon answer is invalid');
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new OllamaError(INVALID_NOTICE, 'the daemon answer is too large');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const value = step.value;
      if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
        throw new OllamaError(INVALID_NOTICE, 'the daemon answer has an invalid body chunk');
      }
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* the stream may already be gone */
        }
        throw new OllamaError(INVALID_NOTICE, 'the daemon answer is too large');
      }
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      chunks.push(Buffer.from(bytes));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* the lock may already be released */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function contentTypeOf(response) {
  try {
    const headers = response.headers;
    if (!headers || typeof headers.get !== 'function') return null;
    const value = headers.get('content-type');
    return typeof value === 'string' ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function discoverOllama(options) {
  const config = validateOptions(options);
  const url = tagsUrl(config.port);
  try {
    const decision = config.evaluate(url);
    if (!decision || decision.allowed !== true) throw new Error('denied');
  } catch {
    return unavailable(config.port, 'policy-denied', POLICY_NOTICE);
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(DEADLINE);
      controller.abort();
    }, config.timeoutMs);
    timer.unref?.();
  });

  const work = (async () => {
    const response = await config.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response || typeof response !== 'object') {
      throw new OllamaError(INVALID_NOTICE, 'the daemon answer is not a response');
    }
    if (response.status !== 200) {
      const status = typeof response.status === 'number' && Number.isInteger(response.status)
        ? response.status
        : null;
      throw new HttpStatusError(status);
    }
    const contentType = contentTypeOf(response);
    const isJson = contentType === null
      || contentType === 'application/json'
      || contentType.startsWith('application/json;');
    if (!isJson) {
      throw new OllamaError(INVALID_NOTICE, 'the daemon answer is not JSON');
    }
    return readBoundedBody(response, config.maxResponseBytes, config.injectedFetch);
  })();

  let settled;
  try {
    settled = await Promise.race([
      work.then(
        (value) => ({ kind: 'value', value }),
        (error) => ({ kind: 'error', error }),
      ),
      deadline,
    ]);
  } catch {
    settled = DEADLINE;
  }
  clearTimeout(timer);
  if (settled === DEADLINE) {
    work.catch(() => {});
    return unavailable(config.port, 'timeout', TIMEOUT_NOTICE);
  }
  if (settled.kind === 'error') {
    try {
      controller.abort();
    } catch {
      /* the request is already gone */
    }
    if (timedOut) return unavailable(config.port, 'timeout', TIMEOUT_NOTICE);
    const error = settled.error;
    if (error instanceof HttpStatusError) {
      return unavailable(config.port, 'http-error', HTTP_ERROR_NOTICE, error.status);
    }
    if (error instanceof OllamaError) {
      return unavailable(config.port, 'invalid-response', INVALID_NOTICE);
    }
    return unavailable(config.port, 'unreachable', UNREACHABLE_NOTICE);
  }
  let payload;
  try {
    payload = JSON.parse(settled.value);
  } catch {
    return unavailable(config.port, 'invalid-response', INVALID_NOTICE);
  }
  try {
    return projectPayload(payload, config.port);
  } catch {
    return unavailable(config.port, 'invalid-response', INVALID_NOTICE);
  }
}

class HttpStatusError extends Error {
  constructor(status) {
    super('the daemon answered with a non-200 status');
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

function readDiscoveryResult(result) {
  const own = readOwnData(result, 'result', RESULT_KEYS, 'invalid-result');
  if (own.version !== OLLAMA_MODULE_VERSION) fail('invalid-result', 'the result version is not supported');
  if (typeof own.available !== 'boolean') fail('invalid-result', 'the result availability flag is invalid');
  if (own.available !== true) fail('ollama-unavailable', 'the daemon is not available');
  const port = validateInteger(own.port, 'port', MIN_PORT, MAX_PORT, 'invalid-result');
  const baseUrl = buildOllamaBaseUrl(port);
  if (own.baseUrl !== baseUrl) fail('invalid-result', 'the result base URL is invalid');
  if (own.chatModel !== null && typeof own.chatModel !== 'string') {
    fail('invalid-result', 'the result chat model is invalid');
  }
  if (own.embeddingModel !== null && typeof own.embeddingModel !== 'string') {
    fail('invalid-result', 'the result embedding model is invalid');
  }
  let length;
  try {
    if (!Array.isArray(own.models)) length = -1;
    else length = own.models.length;
  } catch {
    fail('invalid-result', 'the result model list is invalid');
  }
  if (!Number.isInteger(length) || length < 0 || length > MAX_MODELS) {
    fail('invalid-result', 'the result model list is invalid');
  }
  const models = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(own.models, String(index));
    } catch {
      fail('invalid-result', 'the result model entry is unsafe');
    }
    if (!descriptor || !('value' in descriptor)) fail('invalid-result', 'the result must contain data only');
    const entry = readOwnData(descriptor.value, 'model', MODEL_KEYS, 'invalid-result');
    if (typeof entry.id !== 'string' || !MODEL_NAME.test(entry.id)) fail('invalid-result', 'the result model id is invalid');
    if (typeof entry.remote !== 'boolean' || typeof entry.embedding !== 'boolean') {
      fail('invalid-result', 'the result model flags are invalid');
    }
    models.push(entry);
  }
  const hasLocal = (id, embedding) => models.some((entry) => (
    entry.id === id && entry.remote === false && entry.embedding === embedding
  ));
  if (own.chatModel !== null && !hasLocal(own.chatModel, false)) {
    fail('invalid-result', 'the result chat model is not a local chat model');
  }
  if (own.embeddingModel !== null && !hasLocal(own.embeddingModel, true)) {
    fail('invalid-result', 'the result embedding model is not a local embedding model');
  }
  return { port, baseUrl, chatModel: own.chatModel, models };
}

export function toOllamaProviderOptions(result, options) {
  const parsed = readDiscoveryResult(result);
  const own = options === undefined
    ? Object.create(null)
    : readOwnData(options, 'options', PROVIDER_OPTION_KEYS, 'invalid-options');
  if (own.model !== undefined && (typeof own.model !== 'string' || !MODEL_NAME.test(own.model))) {
    fail('invalid-options', 'model is invalid');
  }
  if (own.model === undefined) {
    if (parsed.chatModel === null) fail('ollama-no-chat-model', 'the daemon has no local chat model');
    return Object.freeze({ baseUrl: parsed.baseUrl, model: parsed.chatModel });
  }
  const match = parsed.models.find(function (entry) {
    return entry.id === own.model && entry.remote === false && entry.embedding === false;
  });
  if (!match) fail('unknown-model', 'model is not an installed local chat model');
  return Object.freeze({ baseUrl: parsed.baseUrl, model: match.id });
}
