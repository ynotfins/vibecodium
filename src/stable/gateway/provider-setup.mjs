// M2 B5 point-and-click provider setup.
//
// The setup service owns the non-secret provider settings file and the secret store. It exposes a
// validated view for the extension panel, adds or overrides a provider from a settings object
// alone, switches the active provider, and imports a key from a chosen environment variable into
// the OS secret store. No method returns a secret value and no secret value is ever written to the
// settings file, the view or an error.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createProviderClient } from './provider-client.mjs';
import {
  ENV_NAME,
  MAX_PRESETS,
  MODEL_NAME,
  PROVIDER_ID,
  ProviderPresetError,
  getProviderPreset,
  listProviderPresets,
} from './provider-presets.mjs';
import { SecretStoreError, validateSecretId, validateSecretValue } from './secret-store.mjs';

export const PROVIDER_SETUP_VERSION = 1;
export const MAX_ENV_NAMES = 500;
export const SETTINGS_FILE = 'providers.json';

const SETTINGS_KEYS = new Set(['version', 'activeProvider', 'providers', 'secretProviders']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_FIELDS = new Set(['secret', 'apikey', 'api_key', 'token', 'password']);
const CREDENTIAL_ENV = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET)$/i;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export class ProviderSetupError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ProviderSetupError';
    this.code = code;
    if (extra.provider !== undefined) this.provider = extra.provider;
    if (extra.envName !== undefined) this.envName = extra.envName;
  }
}

function fail(code, message, extra) {
  throw new ProviderSetupError(code, message, extra);
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

function ownKeys(value, label) {
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-input', label + ' cannot be read');
  }
  return keys;
}

// Copies a plain object's own data properties. Accessors are rejected without being invoked.
function readOwnData(value, label) {
  if (!isPlainObject(value)) fail('invalid-input', label + ' must be a plain object');
  const out = Object.create(null);
  for (const key of ownKeys(value, label)) {
    if (RESERVED_KEYS.has(key)) fail('invalid-input', label + ' has a reserved key');
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail('invalid-input', label + ' has an unsafe property');
    }
    if (!descriptor || !('value' in descriptor)) {
      fail('invalid-input', label + ' must contain data properties only');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function readEnvironment(env, name) {
  if (env === null || typeof env !== 'object') return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(env, name);
  } catch {
    return undefined;
  }
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function normalizePresetError(error) {
  if (error instanceof ProviderPresetError) {
    return new ProviderSetupError(error.code, error.message);
  }
  if (error instanceof SecretStoreError) {
    return new ProviderSetupError(error.code, error.message, {});
  }
  return error;
}

function emptyState() {
  return { version: PROVIDER_SETUP_VERSION, activeProvider: null, providers: Object.create(null), secretProviders: [] };
}

function validateLoadedState(raw) {
  if (!isPlainObject(raw)) fail('settings-corrupt', 'the provider settings file is not an object');
  const data = readOwnData(raw, 'settings');
  for (const key of Object.keys(data)) {
    if (!SETTINGS_KEYS.has(key)) fail('settings-corrupt', 'the provider settings file has an unknown field: ' + key);
  }
  if (data.version !== PROVIDER_SETUP_VERSION) fail('settings-corrupt', 'the provider settings version is unsupported');
  const activeProvider = data.activeProvider === undefined ? null : data.activeProvider;
  if (activeProvider !== null && (typeof activeProvider !== 'string' || !PROVIDER_ID.test(activeProvider))) {
    fail('settings-corrupt', 'the active provider is invalid');
  }
  const providers = data.providers === undefined ? Object.create(null) : readOwnData(data.providers, 'providers');
  if (Object.keys(providers).length > MAX_PRESETS) fail('settings-corrupt', 'the provider settings file has too many providers');
  for (const id of Object.keys(providers)) {
    let definition;
    try {
      definition = providers[id];
      if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) continue;
      for (const key of Object.keys(definition)) {
        if (SECRET_FIELDS.has(key.toLowerCase())) {
          fail('secret-not-allowed', 'a provider definition must not contain a secret value; store it in the secret store');
        }
      }
    } catch (error) {
      if (error instanceof ProviderSetupError) throw error;
      fail('settings-corrupt', 'a provider definition cannot be read');
    }
  }
  const secretProviders = data.secretProviders === undefined ? [] : data.secretProviders;
  if (!Array.isArray(secretProviders) || secretProviders.length > MAX_PRESETS) {
    fail('settings-corrupt', 'the stored-secret index is invalid');
  }
  const seen = new Set();
  const ids = [];
  for (let index = 0; index < secretProviders.length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(secretProviders, String(index));
    } catch {
      fail('settings-corrupt', 'the stored-secret index cannot be read');
    }
    if (!descriptor || !('value' in descriptor)) fail('settings-corrupt', 'the stored-secret index is invalid');
    const id = descriptor.value;
    if (typeof id !== 'string' || !PROVIDER_ID.test(id) || seen.has(id)) {
      fail('settings-corrupt', 'the stored-secret index is invalid');
    }
    seen.add(id);
    ids.push(id);
  }
  try {
    listProviderPresets({ providers });
  } catch (error) {
    throw normalizePresetError(error);
  }
  if (activeProvider !== null) {
    try {
      getProviderPreset(activeProvider, { providers });
    } catch (error) {
      throw normalizePresetError(error);
    }
  }
  return {
    version: PROVIDER_SETUP_VERSION,
    activeProvider,
    providers,
    secretProviders: ids.sort(),
  };
}

function providerInput(raw) {
  const data = readOwnData(raw, 'provider');
  for (const key of Object.keys(data)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) {
      fail('secret-not-allowed', 'a provider definition must not contain a secret value; store it in the secret store');
    }
  }
  if (data.id === undefined) fail('invalid-provider', 'a provider needs an id');
  if (typeof data.id !== 'string' || !PROVIDER_ID.test(data.id)) {
    fail('invalid-provider', 'a provider id must be a lowercase identifier');
  }
  if (data.model !== undefined && (typeof data.model !== 'string' || !MODEL_NAME.test(data.model))) {
    fail('invalid-provider', 'a provider model is invalid');
  }
  if (data.apiKeyEnv !== undefined && (typeof data.apiKeyEnv !== 'string' || !ENV_NAME.test(data.apiKeyEnv))) {
    fail('invalid-provider', 'a provider key environment variable is invalid');
  }
  return data;
}

export function createProviderSetup(options = {}) {
  if (!isPlainObject(options)) fail('invalid-options', 'setup options must be an object');
  const settingsPath = options.settingsPath;
  if (typeof settingsPath !== 'string' || settingsPath.length < 1) {
    fail('invalid-options', 'settingsPath is required');
  }
  const secretStore = options.secretStore;
  if (!secretStore || typeof secretStore.get !== 'function' || typeof secretStore.set !== 'function' ||
      typeof secretStore.delete !== 'function') {
    fail('invalid-options', 'a secret store is required');
  }
  const env = options.env ?? process.env;

  let state = load();

  function load() {
    if (!existsSync(settingsPath)) return emptyState();
    let text;
    try {
      text = readFileSync(settingsPath, 'utf8');
    } catch {
      fail('settings-corrupt', 'the provider settings file cannot be read');
    }
    if (text.length > 1024 * 1024) fail('settings-corrupt', 'the provider settings file is too large');
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      fail('settings-corrupt', 'the provider settings file is not valid JSON');
    }
    return validateLoadedState(raw);
  }

  function persist() {
    const serializable = {
      version: PROVIDER_SETUP_VERSION,
      activeProvider: state.activeProvider,
      providers: state.providers,
      secretProviders: state.secretProviders,
    };
    try {
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      const temporary = settingsPath + '.tmp';
      writeFileSync(temporary, JSON.stringify(serializable, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, settingsPath);
    } catch {
      fail('settings-unwritable', 'the provider settings file could not be written');
    }
  }

  function settingsForClient() {
    return { providers: { ...state.providers } };
  }

  function presets() {
    try {
      return listProviderPresets(settingsForClient());
    } catch (error) {
      throw normalizePresetError(error);
    }
  }

  function requireProvider(id) {
    if (typeof id !== 'string' || !PROVIDER_ID.test(id)) fail('invalid-provider', 'a provider id must be a lowercase identifier');
    const found = presets().find((preset) => preset.id === id);
    if (!found) fail('unknown-provider', 'unknown provider: ' + id, { provider: id });
    return found;
  }

  function envNames() {
    const names = new Set();
    for (const preset of presets()) {
      if (preset.apiKeyEnv !== undefined) names.add(preset.apiKeyEnv);
    }
    let keys;
    try {
      keys = Object.keys(env ?? {});
    } catch {
      keys = [];
    }
    for (const name of keys) {
      if (names.size >= MAX_ENV_NAMES) break;
      if (!ENV_NAME.test(name)) continue;
      if (!CREDENTIAL_ENV.test(name)) continue;
      if (readEnvironment(env, name) === undefined) continue;
      names.add(name);
    }
    return Object.freeze([...names].sort());
  }

  function view() {
    const active = state.activeProvider;
    const providers = presets().map((preset) => Object.freeze({
      id: preset.id,
      label: preset.label,
      transport: preset.transport,
      auth: preset.auth,
      ...(preset.baseUrl === undefined ? {} : { baseUrl: preset.baseUrl }),
      ...(preset.baseUrlEnv === undefined ? {} : { baseUrlEnv: preset.baseUrlEnv }),
      ...(preset.defaultModel === undefined ? {} : { model: preset.defaultModel }),
      ...(preset.apiKeyEnv === undefined ? {} : { apiKeyEnv: preset.apiKeyEnv }),
      apiKeyRequired: preset.apiKeyRequired,
      capabilities: preset.capabilities,
      local: preset.local,
      configured: Object.prototype.hasOwnProperty.call(state.providers, preset.id),
      secretStored: state.secretProviders.includes(preset.id),
      active: preset.id === active,
    }));
    return Object.freeze({
      version: PROVIDER_SETUP_VERSION,
      activeProvider: active,
      providers: Object.freeze(providers),
      envNames: envNames(),
    });
  }

  function addProvider(raw) {
    const input = providerInput(raw);
    const id = input.id;
    const definition = Object.assign(Object.create(null), input);
    delete definition.id;
    const providers = { ...state.providers, [id]: definition };
    let normalized;
    try {
      normalized = getProviderPreset(id, { providers });
    } catch (error) {
      throw normalizePresetError(error);
    }
    const next = { ...state.providers };
    next[id] = normalized;
    state = { ...state, providers: next };
    persist();
    return view();
  }

  async function setSecret({ provider, secret } = {}) {
    requireProvider(provider);
    const value = validateSecretValue(secret);
    await secretStore.set(provider, value);
    if (!state.secretProviders.includes(provider)) {
      state = { ...state, secretProviders: [...state.secretProviders, provider].sort() };
      persist();
    }
    return view();
  }

  async function importSecretFromEnvironment({ provider, envName } = {}) {
    requireProvider(provider);
    if (typeof envName !== 'string' || !ENV_NAME.test(envName)) {
      fail('invalid-env-name', 'an environment variable name must be an uppercase identifier', { provider, envName });
    }
    const value = readEnvironment(env, envName);
    if (typeof value !== 'string' || value.length === 0) {
      fail('missing-environment-variable', 'the selected environment variable is not set', { provider, envName });
    }
    return setSecret({ provider, secret: value });
  }

  async function clearSecret({ provider } = {}) {
    requireProvider(provider);
    await secretStore.delete(provider);
    if (state.secretProviders.includes(provider)) {
      state = { ...state, secretProviders: state.secretProviders.filter((id) => id !== provider) };
      persist();
    }
    return view();
  }

  async function hasSecret(provider) {
    requireProvider(provider);
    return secretStore.get(provider).then((value) => value !== null);
  }

  function selectProvider(id) {
    requireProvider(id);
    state = { ...state, activeProvider: id };
    persist();
    return view();
  }

  async function removeProvider(id) {
    requireProvider(id);
    if (Object.prototype.hasOwnProperty.call(state.providers, id) === false) {
      fail('built-in-provider', 'a built-in provider cannot be removed; add an override instead', { provider: id });
    }
    const providers = { ...state.providers };
    delete providers[id];
    state = {
      ...state,
      providers,
      activeProvider: state.activeProvider === id ? null : state.activeProvider,
      secretProviders: state.secretProviders.filter((entry) => entry !== id),
    };
    try {
      await secretStore.delete(id);
    } catch {
      // The settings record is already gone; a stale OS credential is harmless and is retried by
      // the next clear. Never surface the store error text here.
    }
    persist();
    return view();
  }

  async function createClient(id, clientOptions = {}) {
    const preset = requireProvider(id);
    let secret = null;
    if (preset.apiKeyRequired || state.secretProviders.includes(id)) {
      secret = await secretStore.get(id);
    }
    if (secret === null && preset.apiKeyRequired) {
      const fromEnv = preset.apiKeyEnv === undefined ? undefined : readEnvironment(env, preset.apiKeyEnv);
      if (typeof fromEnv !== 'string' || fromEnv.length === 0) {
        fail('missing-secret', 'provider ' + id + ' has no stored key', { provider: id });
      }
    }
    return createProviderClient(id, {
      ...clientOptions,
      env,
      settings: settingsForClient(),
      ...(secret === null ? {} : { apiKey: secret }),
    });
  }

  return Object.freeze({
    describe: () => Object.freeze({
      version: PROVIDER_SETUP_VERSION,
      settingsPath,
      activeProvider: state.activeProvider,
      providers: Object.freeze(presets().map((preset) => preset.id)),
      secretProviders: Object.freeze([...state.secretProviders]),
    }),
    view,
    list: view,
    envNames,
    addProvider,
    setSecret,
    importSecretFromEnvironment,
    clearSecret,
    hasSecret,
    selectProvider,
    removeProvider,
    createClient,
    settingsForClient,
  });
}
