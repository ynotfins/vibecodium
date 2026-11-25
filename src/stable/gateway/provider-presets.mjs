// M2 B1 provider preset catalog.
//
// A dependency-free, frozen catalog of the providers Vibecodium supports, plus a validated
// settings-JSON path for adding a provider without editing source. This module does not perform
// network I/O and never reads an API key: it only describes where a provider lives, which
// transport and capabilities it has, and which environment variable holds the credential.
// `provider-client.mjs` resolves the credential and gates every request through the M1 endpoint
// policy.

export const PROVIDER_PRESET_VERSION = 1;
export const MAX_PRESETS = 64;
export const MAX_LABEL_CHARS = 120;
export const MAX_MODEL_CHARS = 200;
export const MAX_BASE_URL_CHARS = 2048;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 120_000;
export const MIN_RESPONSE_BYTES = 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const TRANSPORTS = Object.freeze(['openai-chat', 'openai-responses']);
export const AUTH_MODES = Object.freeze(['bearer', 'none']);
export const CAPABILITIES = Object.freeze(['chat', 'stream', 'tools', 'embeddings']);

export const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
export const MODEL_NAME = /^[A-Za-z0-9._:/@+-]{1,200}$/;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LOOPBACK = ['127', '0', '0', '1'].join('.');
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const ENCODED_SEPARATOR = /%(?:2e|2f|5c)/i;
const SETTINGS_KEYS = new Set(['providers']);
const PRESET_KEYS = new Set([
  'id', 'label', 'transport', 'baseUrl', 'baseUrlEnv', 'model', 'defaultModel', 'apiKeyEnv',
  'apiKeyRequired', 'auth', 'capabilities', 'local',
]);

export class ProviderPresetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderPresetError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderPresetError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

// Reads a plain object once, without invoking accessors or walking a polluted prototype. The
// result has a null prototype so a caller cannot reach Object.prototype through it.
function readOwnData(value, label, maxKeys) {
  if (!isPlainObject(value)) fail('invalid-settings', label + ' must be a plain object');
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-settings', label + ' cannot be enumerated');
  }
  if (keys.length > maxKeys) fail('invalid-settings', label + ' has too many keys');
  const out = Object.create(null);
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) fail('invalid-settings', label + ' has a reserved key');
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail('invalid-settings', label + ' has an unsafe property');
    }
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      fail('invalid-settings', label + ' must contain data properties only');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function validateText(value, label, maximum, pattern) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    fail('invalid-preset', label + ' is invalid');
  }
  if (CONTROL_OR_BIDI.test(value)) fail('invalid-preset', label + ' contains unsafe characters');
  if (pattern && !pattern.test(value)) fail('invalid-preset', label + ' is invalid');
  return value;
}

function validateEnvironmentName(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ENV_NAME.test(value)) {
    fail('invalid-env-name', label + ' must be an uppercase environment variable name');
  }
  return value;
}

export function validateProviderBaseUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_BASE_URL_CHARS) {
    fail('invalid-base-url', 'baseUrl must be a non-empty URL of at most ' + MAX_BASE_URL_CHARS + ' characters');
  }
  if (CONTROL_OR_BIDI.test(value) || value.includes('\\')) {
    fail('invalid-base-url', 'baseUrl contains unsafe characters');
  }
  if (ENCODED_SEPARATOR.test(value)) fail('invalid-base-url', 'baseUrl contains an encoded separator or dot segment');
  if (value.includes('?') || value.includes('#')) {
    fail('invalid-base-url', 'baseUrl must not carry a query string or fragment');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-base-url', 'baseUrl could not be parsed');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('invalid-base-url', 'baseUrl must use http or https');
  }
  if (parsed.username || parsed.password) fail('invalid-base-url', 'baseUrl must not carry credentials');
  if (!parsed.hostname) fail('invalid-base-url', 'baseUrl must have a host');
  if (ENCODED_SEPARATOR.test(parsed.pathname)) fail('invalid-base-url', 'baseUrl path is unsafe');
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + pathname;
}

export function validateProviderModel(value) {
  return validateText(value, 'model', MAX_MODEL_CHARS, MODEL_NAME);
}

function validateCapabilities(value) {
  if (!Array.isArray(value)) fail('invalid-capabilities', 'capabilities must be an array');
  let length;
  try {
    length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  } catch {
    fail('invalid-capabilities', 'capabilities cannot be read');
  }
  if (!Number.isInteger(length) || length < 1 || length > CAPABILITIES.length) {
    fail('invalid-capabilities', 'capabilities has an invalid length');
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail('invalid-capabilities', 'capabilities cannot be read');
    }
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      fail('invalid-capabilities', 'capabilities must contain data values only');
    }
    const item = descriptor.value;
    if (typeof item !== 'string' || !CAPABILITIES.includes(item)) {
      fail('invalid-capabilities', 'unknown capability');
    }
    if (out.includes(item)) fail('invalid-capabilities', 'duplicate capability');
    out.push(item);
  }
  if (!out.includes('chat')) fail('invalid-capabilities', 'capabilities must include chat');
  return Object.freeze(out);
}

function validateTransport(value) {
  if (typeof value !== 'string' || !TRANSPORTS.includes(value)) {
    fail('invalid-transport', 'transport must be one of ' + TRANSPORTS.join(', '));
  }
  return value;
}

function validateAuth(value) {
  if (typeof value !== 'string' || !AUTH_MODES.includes(value)) {
    fail('invalid-preset', 'auth must be one of ' + AUTH_MODES.join(', '));
  }
  return value;
}

function normalizePreset(id, input, base, { custom }) {
  const merged = Object.assign(Object.create(null), base ?? {}, input);
  if (merged.id !== undefined && merged.id !== id) fail('invalid-id', 'preset id does not match its key');
  merged.id = id;
  for (const key of Object.keys(merged)) {
    if (!PRESET_KEYS.has(key)) fail('invalid-settings', 'unknown preset field: ' + key);
  }
  const transport = validateTransport(merged.transport);
  const auth = validateAuth(merged.auth ?? 'bearer');
  const capabilities = validateCapabilities(merged.capabilities);
  const local = merged.local === undefined ? false : merged.local;
  if (typeof local !== 'boolean') fail('invalid-preset', 'local must be a boolean');
  const baseUrl = merged.baseUrl === undefined ? undefined : validateProviderBaseUrl(merged.baseUrl);
  const baseUrlEnv = validateEnvironmentName(merged.baseUrlEnv, 'baseUrlEnv');
  if (baseUrl === undefined && baseUrlEnv === undefined) {
    fail('invalid-base-url', 'a preset needs a baseUrl or a baseUrlEnv');
  }
  const apiKeyEnv = validateEnvironmentName(merged.apiKeyEnv, 'apiKeyEnv');
  const defaultModel = merged.defaultModel === undefined && merged.model === undefined
    ? undefined
    : validateProviderModel(merged.defaultModel ?? merged.model);
  const apiKeyRequired = merged.apiKeyRequired === undefined
    ? auth === 'bearer' && !local
    : merged.apiKeyRequired;
  if (typeof apiKeyRequired !== 'boolean') fail('invalid-preset', 'apiKeyRequired must be a boolean');
  if (apiKeyRequired && apiKeyEnv === undefined) {
    fail('invalid-preset', 'apiKeyEnv is required when a key is required');
  }
  if (custom && (merged.label === undefined || typeof merged.label !== 'string')) {
    fail('invalid-preset', 'a custom provider needs a label');
  }
  const label = validateText(merged.label, 'label', MAX_LABEL_CHARS, /^[^\n\r]+$/);
  return Object.freeze({
    id,
    label,
    transport,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(baseUrlEnv === undefined ? {} : { baseUrlEnv }),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    auth,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    apiKeyRequired,
    capabilities,
    local,
  });
}

function definePreset(entry) {
  return normalizePreset(entry.id, entry, undefined, { custom: false });
}

// The B1 list. Provider endpoints are documented defaults; a settings override or an environment
// variable wins. kie.ai's gpt-6-1-sol is served by its OpenAI Responses-compatible `/codex/v1`
// path; abliteration.ai serves an OpenAI Chat Completions-compatible `/v1` path.
export const PROVIDER_PRESETS = Object.freeze([
  definePreset({
    id: 'omniroute',
    label: 'OmniRoute',
    transport: 'openai-chat',
    baseUrlEnv: 'OMNIROUTE_BASE_URL',
    auth: 'bearer',
    apiKeyEnv: 'OMNIROUTE_API_KEY',
    apiKeyRequired: false,
    capabilities: ['chat', 'stream', 'tools', 'embeddings'],
  }),
  definePreset({
    id: 'morph',
    label: 'Morph',
    transport: 'openai-chat',
    baseUrl: 'https://api.morphllm.com/v1',
    auth: 'bearer',
    apiKeyEnv: 'MORPH_API_KEY',
    capabilities: ['chat', 'stream', 'tools', 'embeddings'],
  }),
  definePreset({
    id: 'kie',
    label: 'kie.ai',
    transport: 'openai-responses',
    baseUrl: 'https://api.kie.ai/codex/v1',
    auth: 'bearer',
    apiKeyEnv: 'KIE_API_KEY',
    defaultModel: 'gpt-6-1-sol',
    capabilities: ['chat', 'stream', 'tools'],
  }),
  definePreset({
    id: 'deepinfra',
    label: 'DeepInfra',
    transport: 'openai-chat',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    auth: 'bearer',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    capabilities: ['chat', 'stream', 'tools', 'embeddings'],
  }),
  definePreset({
    id: 'abliteration',
    label: 'Abliteration',
    transport: 'openai-chat',
    baseUrl: 'https://api.abliteration.ai/v1',
    auth: 'bearer',
    apiKeyEnv: 'ABLITERATION_API_KEY',
    defaultModel: 'abliterated-model-large-v2',
    capabilities: ['chat', 'stream', 'tools', 'embeddings'],
  }),
  definePreset({
    id: 'openrouter',
    label: 'OpenRouter',
    transport: 'openai-chat',
    baseUrl: 'https://' + ['openrouter', 'ai'].join('.') + '/api/v1',
    auth: 'bearer',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    capabilities: ['chat', 'stream', 'tools', 'embeddings'],
  }),
  definePreset({
    id: 'requesty',
    label: 'Requesty',
    transport: 'openai-chat',
    baseUrl: 'https://router.requesty.ai/v1',
    auth: 'bearer',
    apiKeyEnv: 'REQUESTY_API_KEY',
    capabilities: ['chat', 'stream', 'tools', 'embeddings'],
  }),
  definePreset({
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    transport: 'openai-chat',
    baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL',
    auth: 'bearer',
    apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
    apiKeyRequired: false,
    capabilities: ['chat', 'stream', 'tools', 'embeddings'],
  }),
  definePreset({
    id: 'llama-cpp',
    label: 'llama.cpp',
    transport: 'openai-chat',
    baseUrl: 'http://' + LOOPBACK + ':8080/v1',
    auth: 'none',
    apiKeyRequired: false,
    capabilities: ['chat', 'stream', 'tools', 'embeddings'],
    local: true,
  }),
  definePreset({
    id: 'ollama',
    label: 'Ollama',
    transport: 'openai-chat',
    baseUrl: 'http://' + LOOPBACK + ':11434/v1',
    auth: 'none',
    apiKeyRequired: false,
    capabilities: ['chat', 'stream', 'tools', 'embeddings'],
    local: true,
  }),
]);

const BUILTINS_BY_ID = new Map(PROVIDER_PRESETS.map((entry) => [entry.id, entry]));

function settingsProviders(settings) {
  if (settings === undefined) return Object.create(null);
  const root = readOwnData(settings, 'settings', 8);
  for (const key of Object.keys(root)) {
    if (!SETTINGS_KEYS.has(key)) fail('invalid-settings', 'unknown settings key: ' + key);
    if (RESERVED_KEYS.has(key)) fail('invalid-settings', 'settings has a reserved key');
  }
  if (root.providers === undefined) return Object.create(null);
  const providers = readOwnData(root.providers, 'providers', MAX_PRESETS);
  for (const key of Object.keys(providers)) {
    if (RESERVED_KEYS.has(key)) fail('invalid-id', 'provider id is reserved');
    if (!PROVIDER_ID.test(key)) fail('invalid-id', 'provider id is invalid');
  }
  return providers;
}

export function listProviderPresets(settings) {
  const overrides = settingsProviders(settings);
  const entries = [];
  for (const builtin of PROVIDER_PRESETS) {
    const override = overrides[builtin.id];
    entries.push(override === undefined
      ? builtin
      : normalizePreset(builtin.id, readOwnData(override, 'provider ' + builtin.id, PRESET_KEYS.size), builtin, { custom: false }));
  }
  for (const id of Object.keys(overrides).sort()) {
    if (BUILTINS_BY_ID.has(id)) continue;
    const override = readOwnData(overrides[id], 'provider ' + id, PRESET_KEYS.size);
    entries.push(normalizePreset(id, override, undefined, { custom: true }));
  }
  if (entries.length > MAX_PRESETS) fail('too-many-providers', 'too many providers');
  return Object.freeze(entries);
}

export function getProviderPreset(id, settings) {
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) fail('invalid-id', 'provider id is invalid');
  const presets = listProviderPresets(settings);
  const found = presets.find((entry) => entry.id === id);
  if (!found) fail('unknown-provider', 'unknown provider: ' + id);
  return found;
}
