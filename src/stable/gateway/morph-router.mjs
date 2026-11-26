// M2 B6 Morph Router difficulty adapter.
//
// The direct provider's Router (POST /v1/router/classify) classifies a prompt as easy, medium or
// hard in about 180 ms and lets the caller map that difficulty to one of three model tiers. This
// module is a bounded, dependency-free adapter: it validates its options once, reads the Morph API
// key once from an explicit value or the configured environment variable, gates the request with
// the M1 deny-by-default endpoint policy, sends exactly one documented classify request under a
// deadline and a response cap, validates the answer field by field, and returns a frozen tier
// decision. When the Router is unavailable it returns the caller's conservative default tier
// instead of failing a chat turn; only invalid options, an invalid prompt, a policy denial and
// caller cancellation throw. It never returns, serializes or logs the key, the prompt or a
// response body. Router facts: https://docs.morphllm.com/llms.txt (read 2026-11-26).

import { assertAIEndpointAllowed, evaluateAIEndpointRequest } from '../security/ai-endpoint-policy.mjs';
import { MAX_API_KEY_CHARS } from './provider-client.mjs';
import { validateProviderBaseUrl } from './provider-presets.mjs';

export const MORPH_ROUTER_VERSION = 1;
export const ROUTER_CLASSIFY_PATH = '/router/classify';
export const MORPH_ROUTER_BASE_URL = 'https://api.morphllm.com/v1';
export const MORPH_ROUTER_API_KEY_ENV = 'MORPH_API_KEY';
export const ROUTER_CLASSES = Object.freeze(['difficulty']);
export const ROUTER_TIERS = Object.freeze(['cheap', 'standard', 'powerful']);
export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);
export const TIER_BY_DIFFICULTY = Object.freeze({ easy: 'cheap', medium: 'standard', hard: 'powerful' });
export const DEFAULT_ROUTER_TIMEOUT_MS = 8000;
export const MIN_ROUTER_TIMEOUT_MS = 100;
export const MAX_ROUTER_TIMEOUT_MS = 60_000;
export const MAX_ROUTER_INPUT_CHARS = 32 * 1024;
export const MAX_ROUTER_INPUT_BYTES = 128 * 1024;
export const MIN_ROUTER_RESPONSE_BYTES = 1024;
export const MAX_ROUTER_RESPONSE_BYTES = 32 * 1024;
export const MAX_ROUTER_RESPONSE_BYTES_LIMIT = 1024 * 1024;
export const MAX_API_KEY_ENV_CHARS = 128;

const OPTION_KEYS = new Set([
  'baseUrl',
  'apiKey',
  'apiKeyEnv',
  'env',
  'policy',
  'timeoutMs',
  'maxResponseBytes',
  'defaultTier',
  'tierByDifficulty',
  'fetch',
]);
const CALL_OPTION_KEYS = new Set(['signal']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export class MorphRouterError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'MorphRouterError';
    this.code = code;
    if (Number.isInteger(extra.status)) this.status = extra.status;
  }
}

function fail(code, message, extra) {
  throw new MorphRouterError(code, message, extra);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  let array;
  try {
    array = Array.isArray(value);
  } catch {
    return false;
  }
  if (array) return false;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

function ownData(object, key, label) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    fail('invalid-options', label + ' cannot be read');
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) fail('invalid-options', label + ' must be a data property');
  return descriptor.value;
}

function keysOf(value, label) {
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-options', label + ' cannot be enumerated');
  }
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) fail('invalid-options', label + ' carries a reserved key');
  }
  return keys;
}

function isWellFormed(value) {
  if (typeof value.isWellFormed === 'function') return value.isWellFormed();
  return !LONE_SURROGATE.test(value);
}

function validateInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail('invalid-options', name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return value;
}

function validateApiKeyEnv(value) {
  if (value !== MORPH_ROUTER_API_KEY_ENV) {
    fail('invalid-options', 'apiKeyEnv must be ' + MORPH_ROUTER_API_KEY_ENV + '; pass apiKey for another source');
  }
  return value;
}

function validateApiKey(value) {
  if (typeof value !== 'string') fail('invalid-api-key', 'the Router API key is invalid');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed !== value || value.length > MAX_API_KEY_CHARS || CONTROL_OR_BIDI.test(value)) {
    fail('invalid-api-key', 'the Router API key is invalid');
  }
  return value;
}

function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  return /^127(?:\.[0-9]{1,3}){3}$/u.test(host);
}

function validateBaseUrl(raw) {
  let baseUrl;
  try {
    baseUrl = validateProviderBaseUrl(raw);
  } catch {
    fail('invalid-base-url', 'baseUrl is invalid');
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail('invalid-base-url', 'baseUrl is invalid');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    fail('invalid-base-url', 'baseUrl must use https unless it is a loopback address');
  }
  return baseUrl;
}

function joinPath(baseUrl, pathname) {
  return baseUrl.replace(/\/+$/u, '') + pathname;
}

// A caller who opts into external providers opts into the host they configured, but only when the
// M1 policy classifies that endpoint as an external provider or an unknown third-party host. A
// Copilot, telemetry, GitHub or metadata endpoint keeps its own switch or hard deny. This mirrors
// the B1 client so the Router cannot widen the policy beyond the configured host.
function resolveRequestPolicy(baseUrl, policy) {
  const allowExternalProviders = ownData(policy, 'allowExternalProviders', 'policy.allowExternalProviders');
  if (allowExternalProviders !== true) return policy;
  let url;
  try {
    url = new URL(baseUrl).href;
  } catch {
    return policy;
  }
  const decision = evaluateAIEndpointRequest(url, policy);
  if (decision.allowed) return policy;
  if (decision.code === 'forbidden-endpoint') assertAIEndpointAllowed(url, policy);
  if (decision.category !== 'external-provider' && decision.category !== 'unknown') {
    assertAIEndpointAllowed(url, policy);
  }
  const host = decision.host;
  if (typeof host !== 'string' || host.length === 0) return policy;
  const supplied = ownData(policy, 'allowHosts', 'policy.allowHosts');
  const existing = Array.isArray(supplied) ? supplied : [];
  if (existing.includes(host)) return policy;
  const scoped = Object.freeze(Object.assign(Object.create(null), policy, { allowHosts: Object.freeze([...existing, host]) }));
  assertAIEndpointAllowed(url, scoped);
  return scoped;
}

function validateTierMap(value) {
  let map = TIER_BY_DIFFICULTY;
  if (value !== undefined) {
    if (!isPlainObject(value)) fail('invalid-options', 'tierByDifficulty must be a plain object');
    const keys = keysOf(value, 'tierByDifficulty');
    if (keys.length !== DIFFICULTIES.length) fail('invalid-options', 'tierByDifficulty must map exactly easy, medium and hard');
    const seen = new Set();
    const next = {};
    for (const difficulty of DIFFICULTIES) {
      const tier = ownData(value, difficulty, 'tierByDifficulty.' + difficulty);
      if (!ROUTER_TIERS.includes(tier)) fail('invalid-options', 'tierByDifficulty.' + difficulty + ' is not a known tier');
      if (seen.has(tier)) fail('invalid-options', 'tierByDifficulty must map to three distinct tiers');
      seen.add(tier);
      next[difficulty] = tier;
    }
    map = next;
  }
  return Object.freeze(map);
}

function readEnvironment(env, name) {
  let value;
  try {
    value = env[name];
  } catch {
    fail('invalid-options', 'env cannot be read');
  }
  return value;
}

// The M1 policy core also rejects accessor options, but the Router can fail earlier and with its
// own error: copy the caller's policy through own data descriptors and refuse an accessor policy
// field before any value is read.
function snapshotPolicy(policy) {
  const keys = keysOf(policy, 'policy');
  const copy = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(policy, key);
    } catch {
      fail('invalid-options', 'policy cannot be read');
    }
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('invalid-options', 'policy must use data properties');
    }
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

async function readBoundedText(response, maximum) {
  if (response === null || typeof response !== 'object') fail('invalid-response', 'the Router response is invalid');
  let header;
  try {
    header = response.headers?.get?.('content-length');
  } catch {
    fail('invalid-response', 'the Router response headers are invalid');
  }
  if (header !== null && header !== undefined) {
    const length = Number(header);
    if (!Number.isFinite(length) || length < 0) fail('invalid-response', 'the Router response headers are invalid');
    if (length > maximum) fail('response-too-large', 'the Router response exceeded the size limit');
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    fail('invalid-response', 'the Router response has no body');
  }
  let text = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    let declared;
    if (typeof chunk === 'string') declared = Buffer.byteLength(chunk, 'utf8');
    else if (chunk instanceof Uint8Array) {
      try {
        declared = chunk.byteLength;
      } catch {
        fail('invalid-response', 'the Router response body is invalid');
      }
    } else {
      fail('invalid-response', 'the Router response body is invalid');
    }
    if (!Number.isInteger(declared) || declared < 0) fail('invalid-response', 'the Router response body is invalid');
    if (declared > maximum - bytes) fail('response-too-large', 'the Router response exceeded the size limit');
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    if (buffer.byteLength > maximum - bytes) fail('response-too-large', 'the Router response exceeded the size limit');
    bytes += buffer.byteLength;
    try {
      text += UTF8.decode(buffer, { stream: true });
    } catch {
      fail('invalid-response', 'the Router response is not valid UTF-8');
    }
  }
  try {
    text += UTF8.decode();
  } catch {
    fail('invalid-response', 'the Router response is not valid UTF-8');
  }
  return text;
}

function parseDifficulty(payload) {
  if (!isPlainObject(payload)) fail('invalid-response', 'the Router answer is invalid');
  const classifications = ownData(payload, 'classifications', 'classifications');
  if (!isPlainObject(classifications)) fail('invalid-response', 'the Router answer is invalid');
  const difficulty = ownData(classifications, 'difficulty', 'difficulty');
  if (!isPlainObject(difficulty)) fail('invalid-response', 'the Router answer is invalid');
  const label = ownData(difficulty, 'label', 'difficulty.label');
  if (label !== 'needs_info' && !DIFFICULTIES.includes(label)) fail('invalid-response', 'the Router difficulty is unknown');
  const confidence = ownData(difficulty, 'confidence', 'difficulty.confidence');
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail('invalid-response', 'the Router confidence is invalid');
  }
  const meetsThreshold = ownData(difficulty, 'meets_threshold', 'difficulty.meets_threshold');
  if (meetsThreshold !== undefined && typeof meetsThreshold !== 'boolean') {
    fail('invalid-response', 'the Router threshold flag is invalid');
  }
  return { label, confidence, meetsThreshold: meetsThreshold === true };
}

function fallbackResult(defaultTier, code, status) {
  return Object.freeze({
    tier: defaultTier,
    difficulty: null,
    confidence: null,
    meetsThreshold: false,
    needsInfo: true,
    fallback: true,
    code,
    status: Number.isInteger(status) ? status : null,
  });
}

export function createMorphRouter(options = {}) {
  if (!isPlainObject(options)) fail('invalid-options', 'options must be an object');
  for (const key of keysOf(options, 'options')) {
    if (!OPTION_KEYS.has(key)) fail('invalid-options', 'options carries an unknown key');
  }

  const rawBaseUrl = ownData(options, 'baseUrl', 'baseUrl');
  const baseUrl = validateBaseUrl(rawBaseUrl === undefined ? MORPH_ROUTER_BASE_URL : rawBaseUrl);
  const apiKeyEnv = validateApiKeyEnv(
    ownData(options, 'apiKeyEnv', 'apiKeyEnv') === undefined ? MORPH_ROUTER_API_KEY_ENV : ownData(options, 'apiKeyEnv', 'apiKeyEnv'),
  );
  const envOption = ownData(options, 'env', 'env');
  const env = envOption === undefined ? process.env : envOption;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) fail('invalid-options', 'env must be an object');
  const supplied = ownData(options, 'apiKey', 'apiKey');
  const rawKey = supplied === undefined ? readEnvironment(env, apiKeyEnv) : supplied;
  if (rawKey === undefined || rawKey === null) fail('missing-api-key', 'the Router needs a Morph API key');
  const apiKey = validateApiKey(rawKey);

  const policy = optionValue(options, 'policy', {});
  if (!isPlainObject(policy)) fail('invalid-options', 'policy must be a plain object');
  const requestPolicy = resolveRequestPolicy(baseUrl, snapshotPolicy(policy));

  const timeoutMs = validateInteger(
    'timeoutMs',
    optionValue(options, 'timeoutMs', DEFAULT_ROUTER_TIMEOUT_MS),
    MIN_ROUTER_TIMEOUT_MS,
    MAX_ROUTER_TIMEOUT_MS,
  );
  const maxResponseBytes = validateInteger(
    'maxResponseBytes',
    optionValue(options, 'maxResponseBytes', MAX_ROUTER_RESPONSE_BYTES),
    MIN_ROUTER_RESPONSE_BYTES,
    MAX_ROUTER_RESPONSE_BYTES_LIMIT,
  );
  const tierByDifficulty = validateTierMap(ownData(options, 'tierByDifficulty', 'tierByDifficulty'));
  const defaultTier = optionValue(options, 'defaultTier', 'standard');
  if (!ROUTER_TIERS.includes(defaultTier)) fail('invalid-options', 'defaultTier is not a known tier');

  const fetchImpl = optionValue(options, 'fetch', globalThis.fetch);
  if (typeof fetchImpl !== 'function') fail('missing-fetch', 'no fetch implementation is available');

  const url = joinPath(baseUrl, ROUTER_CLASSIFY_PATH);

  const describe = () => Object.freeze({
    version: MORPH_ROUTER_VERSION,
    path: ROUTER_CLASSIFY_PATH,
    classes: Object.freeze([...ROUTER_CLASSES]),
    tiers: Object.freeze([...ROUTER_TIERS]),
    tierByDifficulty: Object.freeze({ ...tierByDifficulty }),
    defaultTier,
    maxInputChars: MAX_ROUTER_INPUT_CHARS,
    timeoutMs,
    maxResponseBytes,
  });

  async function classify(prompt, callOptions = {}) {
    if (!isPlainObject(callOptions)) fail('invalid-options', 'call options must be an object');
    for (const key of keysOf(callOptions, 'call options')) {
      if (!CALL_OPTION_KEYS.has(key)) fail('invalid-options', 'call options carry an unknown key');
    }
    const signal = ownData(callOptions, 'signal', 'signal');
    if (signal !== undefined && (signal === null || typeof signal !== 'object' ||
        typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      fail('invalid-options', 'signal is invalid');
    }
    if (typeof prompt !== 'string') fail('invalid-input', 'the Router prompt must be a string');
    if (!isWellFormed(prompt)) fail('invalid-input', 'the Router prompt is not well-formed Unicode');
    if (prompt.includes('\u0000')) fail('invalid-input', 'the Router prompt carries a NUL character');
    const trimmed = prompt.trim();
    if (trimmed.length === 0) fail('invalid-input', 'the Router prompt is empty');
    if (prompt.length > MAX_ROUTER_INPUT_CHARS) fail('invalid-input', 'the Router prompt is too long');
    if (Buffer.byteLength(prompt, 'utf8') > MAX_ROUTER_INPUT_BYTES) fail('invalid-input', 'the Router prompt is too long');
    if (signal?.aborted) fail('aborted', 'the Router request was aborted');

    assertAIEndpointAllowed(url, requestPolicy);

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    timer.unref?.();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    };
    if (signal !== undefined) signal.addEventListener('abort', abort, { once: true });
    const callerAborted = () => signal?.aborted === true;

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({ input: prompt, classes: [...ROUTER_CLASSES] }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      release();
      if (timedOut) return fallbackResult(defaultTier, 'timeout');
      if (callerAborted()) fail('aborted', 'the Router request was aborted');
      return fallbackResult(defaultTier, 'network-error');
    }

    try {
      if (response === null || typeof response !== 'object') return fallbackResult(defaultTier, 'invalid-response');
      if (response.ok === false) {
        return fallbackResult(defaultTier, 'http-status', Number.isInteger(response.status) ? response.status : undefined);
      }
      let text;
      try {
        text = await readBoundedText(response, maxResponseBytes);
      } catch (error) {
        if (timedOut) return fallbackResult(defaultTier, 'timeout');
        if (callerAborted()) fail('aborted', 'the Router request was aborted');
        if (error instanceof MorphRouterError) return fallbackResult(defaultTier, error.code, error.status);
        return fallbackResult(defaultTier, 'network-error');
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return fallbackResult(defaultTier, 'invalid-response');
      }
      let parsed;
      try {
        parsed = parseDifficulty(payload);
      } catch {
        return fallbackResult(defaultTier, 'invalid-response');
      }
      const needsInfo = parsed.label === 'needs_info' || parsed.meetsThreshold !== true;
      return Object.freeze({
        tier: needsInfo ? defaultTier : tierByDifficulty[parsed.label],
        difficulty: parsed.label,
        confidence: parsed.confidence,
        meetsThreshold: parsed.meetsThreshold,
        needsInfo,
        fallback: false,
        code: null,
        status: null,
      });
    } catch (error) {
      if (error instanceof MorphRouterError) throw error;
      if (timedOut) return fallbackResult(defaultTier, 'timeout');
      if (callerAborted()) fail('aborted', 'the Router request was aborted');
      return fallbackResult(defaultTier, 'invalid-response');
    } finally {
      release();
    }
  }

  return deepFreeze({ classify, describe });
}

function optionValue(options, key, fallback) {
  const value = ownData(options, key, key);
  return value === undefined ? fallback : value;
}
