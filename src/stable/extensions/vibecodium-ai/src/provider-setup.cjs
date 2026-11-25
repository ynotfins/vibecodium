'use strict';

const crypto = require('node:crypto');

const PROVIDER_SETUP_VERSION = 1;
const MAX_PROVIDERS = 64;
const MAX_CATALOG = 64;
const MAX_ENV_NAMES = 512;
const MAX_SECRET_CHARS = 4096;
const MAX_LABEL_CHARS = 120;
const MAX_MODEL_CHARS = 200;
const MAX_BASE_URL_CHARS = 2048;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const MODEL_NAME = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const SAFE_NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\p{Cf}]/u;
const SECRET_KEY_PREFIX = 'vibecodium.provider.';
const DOCUMENT_KEYS = new Set(['version', 'activeProvider', 'providers']);
const ENTRY_KEYS = new Set(['id', 'label', 'model', 'apiKeyEnv', 'transport', 'auth', 'baseUrl', 'baseUrlEnv']);
const PRESET_KEYS = new Set([
  'id', 'label', 'transport', 'baseUrl', 'baseUrlEnv', 'defaultModel', 'model', 'auth',
  'apiKeyEnv', 'apiKeyRequired', 'capabilities', 'local',
]);
const TRANSPORTS = new Set(['openai-chat', 'openai-responses']);
const CREDENTIAL_SOURCES = new Set(['secret-storage', 'environment', 'none']);

class ProviderSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderSetupError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderSetupError(code, message);
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

function ownData(object, key, code, label) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    fail(code, label + ' cannot be read');
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) fail(code, label + ' must be a data property');
  return descriptor.value;
}

function methodOf(object, key, code, label) {
  let current = object;
  for (let depth = 0; depth < 32; depth += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      fail(code, label + ' cannot be read');
    }
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        fail(code, label + ' must be a data method');
      }
      return descriptor.value;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      fail(code, label + ' cannot be read');
    }
    if (current === null) break;
  }
  fail(code, label + ' needs a ' + key + ' method');
}

function readArray(value, code, label, maximum) {
  if (!Array.isArray(value)) fail(code, label + ' must be an array');
  let length;
  try {
    length = Object.getOwnPropertyDescriptor(value, 'length').value;
  } catch {
    fail(code, label + ' cannot be read');
  }
  if (!Number.isInteger(length) || length > maximum) fail(code, label + ' has an invalid length');
  const items = [];
  for (let index = 0; index < length; index += 1) {
    const item = ownData(value, String(index), code, label + ' entry');
    if (item === undefined) fail(code, label + ' cannot be sparse');
    items.push(item);
  }
  return items;
}

function validateId(value) {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) fail('invalid-provider', 'the provider id is invalid');
  return value;
}

function validateLabel(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_LABEL_CHARS || UNSAFE_TEXT.test(value)) {
    fail('invalid-provider', 'the provider label is invalid');
  }
  return value;
}

function validateModel(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_MODEL_CHARS || !MODEL_NAME.test(value)) {
    fail('invalid-provider', 'the provider model is invalid');
  }
  return value;
}

function validateEnvironmentName(value) {
  if (typeof value !== 'string' || !ENV_NAME.test(value)) {
    fail('invalid-environment-name', 'the environment variable name is invalid');
  }
  return value;
}

function validateBaseUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_BASE_URL_CHARS ||
      UNSAFE_TEXT.test(value) || value.includes('\\')) {
    fail('invalid-provider', 'the provider base URL is invalid');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-provider', 'the provider base URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('invalid-provider', 'the provider base URL must use http or https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('invalid-provider', 'the provider base URL carries credentials, a query or a fragment');
  }
  return value;
}

function validateCapabilities(value) {
  const items = readArray(value, 'invalid-catalog', 'preset capabilities', 8);
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 32 || UNSAFE_TEXT.test(item)) {
      fail('invalid-catalog', 'a preset capability is invalid');
    }
    if (!out.includes(item)) out.push(item);
  }
  return Object.freeze(out);
}

function validateSecret(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_SECRET_CHARS || UNSAFE_TEXT.test(value)) {
    fail('invalid-secret', 'the credential is invalid');
  }
  return value;
}

function normalizeEnvironmentNames(raw) {
  if (raw === undefined) return Object.freeze([]);
  const items = readArray(raw, 'invalid-environment', 'environment names', MAX_ENV_NAMES);
  const seen = new Set();
  const names = [];
  for (const item of items) {
    const name = validateEnvironmentName(item);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  names.sort();
  return Object.freeze(names);
}

function normalizePreset(raw) {
  if (!isPlainObject(raw)) fail('invalid-catalog', 'a preset must be an object');
  for (const key of Object.keys(raw)) {
    if (!PRESET_KEYS.has(key)) fail('invalid-catalog', 'a preset has an unknown field');
  }
  const id = validateId(ownData(raw, 'id', 'invalid-catalog', 'preset id'));
  const label = validateLabel(ownData(raw, 'label', 'invalid-catalog', 'preset label'));
  const transport = ownData(raw, 'transport', 'invalid-catalog', 'preset transport');
  if (typeof transport !== 'string' || !TRANSPORTS.has(transport)) fail('invalid-catalog', 'a preset transport is invalid');
  const auth = ownData(raw, 'auth', 'invalid-catalog', 'preset auth');
  if (auth !== 'bearer' && auth !== 'none') fail('invalid-catalog', 'a preset auth mode is invalid');
  const baseUrl = ownData(raw, 'baseUrl', 'invalid-catalog', 'preset base URL');
  const baseUrlEnv = ownData(raw, 'baseUrlEnv', 'invalid-catalog', 'preset base URL variable');
  if (baseUrl === undefined && baseUrlEnv === undefined) fail('invalid-catalog', 'a preset needs a base URL or a base URL variable');
  const defaultModelRaw = ownData(raw, 'defaultModel', 'invalid-catalog', 'preset model');
  const defaultModel = defaultModelRaw === undefined ? undefined : validateModel(defaultModelRaw);
  const apiKeyEnvRaw = ownData(raw, 'apiKeyEnv', 'invalid-catalog', 'preset credential variable');
  const apiKeyEnv = apiKeyEnvRaw === undefined ? undefined : validateEnvironmentName(apiKeyEnvRaw);
  const apiKeyRequired = ownData(raw, 'apiKeyRequired', 'invalid-catalog', 'preset credential flag');
  if (typeof apiKeyRequired !== 'boolean') fail('invalid-catalog', 'a preset credential flag is invalid');
  if (apiKeyRequired && apiKeyEnv === undefined) fail('invalid-catalog', 'a preset that needs a key must name its environment variable');
  const local = ownData(raw, 'local', 'invalid-catalog', 'preset local flag');
  if (typeof local !== 'boolean') fail('invalid-catalog', 'a preset local flag is invalid');
  const capabilities = validateCapabilities(ownData(raw, 'capabilities', 'invalid-catalog', 'preset capabilities'));
  return Object.freeze({
    id,
    label,
    transport,
    ...(baseUrl === undefined ? {} : { baseUrl: validateBaseUrl(baseUrl) }),
    ...(baseUrlEnv === undefined ? {} : { baseUrlEnv: validateEnvironmentName(baseUrlEnv) }),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    auth,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    apiKeyRequired,
    capabilities,
    local,
  });
}

function normalizeCatalog(raw) {
  const items = readArray(raw, 'invalid-catalog', 'presets', MAX_CATALOG);
  if (items.length < 1) fail('invalid-catalog', 'the catalog needs at least one preset');
  const seen = new Set();
  const presets = [];
  for (const item of items) {
    const preset = normalizePreset(item);
    if (seen.has(preset.id)) fail('invalid-catalog', 'a preset id is duplicated');
    seen.add(preset.id);
    presets.push(preset);
  }
  return Object.freeze(presets);
}

function catalogIndex(catalog) {
  const index = Object.create(null);
  for (const preset of catalog) index[preset.id] = preset;
  return index;
}

function providerBinding(preset) {
  return {
    transport: preset.transport,
    auth: preset.auth,
    ...(preset.baseUrl === undefined ? {} : { baseUrl: preset.baseUrl }),
    ...(preset.baseUrlEnv === undefined ? {} : { baseUrlEnv: preset.baseUrlEnv }),
  };
}

function normalizeDocument(raw, index) {
  if (raw === undefined) {
    return Object.freeze({
      version: PROVIDER_SETUP_VERSION,
      activeProvider: null,
      providers: Object.freeze([]),
    });
  }
  if (!isPlainObject(raw)) fail('invalid-document', 'the saved setup must be an object');
  for (const key of Object.keys(raw)) {
    if (!DOCUMENT_KEYS.has(key)) fail('invalid-document', 'the saved setup has an unknown field');
  }
  const version = ownData(raw, 'version', 'invalid-document', 'setup version');
  if (version !== PROVIDER_SETUP_VERSION) fail('invalid-document', 'the saved setup version is not supported');
  const activeRaw = ownData(raw, 'activeProvider', 'invalid-document', 'active provider');
  if (activeRaw !== null && activeRaw !== undefined &&
      (typeof activeRaw !== 'string' || !PROVIDER_ID.test(activeRaw))) {
    fail('invalid-document', 'the active provider is invalid');
  }
  const providersRaw = ownData(raw, 'providers', 'invalid-document', 'providers');
  const items = providersRaw === undefined
    ? []
    : readArray(providersRaw, 'invalid-document', 'providers', MAX_PROVIDERS);
  const seen = new Set();
  const providers = [];
  for (const item of items) {
    if (!isPlainObject(item)) fail('invalid-document', 'a saved provider must be an object');
    for (const key of Object.keys(item)) {
      if (!ENTRY_KEYS.has(key)) fail('invalid-document', 'a saved provider has an unknown field');
    }
    const idRaw = ownData(item, 'id', 'invalid-document', 'provider id');
    if (typeof idRaw !== 'string' || !PROVIDER_ID.test(idRaw)) fail('invalid-document', 'a saved provider id is invalid');
    const preset = index[idRaw];
    if (!preset) fail('invalid-document', 'a saved provider is not in the catalog');
    if (seen.has(idRaw)) fail('invalid-document', 'a saved provider is duplicated');
    seen.add(idRaw);
    const model = validateModel(ownData(item, 'model', 'invalid-document', 'provider model'));
    const labelRaw = ownData(item, 'label', 'invalid-document', 'provider label');
    const label = labelRaw === undefined ? preset.label : validateLabel(labelRaw);
    const envRaw = ownData(item, 'apiKeyEnv', 'invalid-document', 'provider credential variable');
    const apiKeyEnv = envRaw === undefined ? preset.apiKeyEnv : validateEnvironmentName(envRaw);
    if (preset.apiKeyRequired && apiKeyEnv === undefined) {
      fail('invalid-document', 'a saved provider that needs a key must name its environment variable');
    }
    const transport = ownData(item, 'transport', 'invalid-document', 'provider transport');
    const auth = ownData(item, 'auth', 'invalid-document', 'provider auth');
    const baseUrl = ownData(item, 'baseUrl', 'invalid-document', 'provider base URL');
    const baseUrlEnv = ownData(item, 'baseUrlEnv', 'invalid-document', 'provider base URL variable');
    if (transport !== preset.transport || auth !== preset.auth ||
        baseUrl !== preset.baseUrl || baseUrlEnv !== preset.baseUrlEnv) {
      fail('invalid-document', 'a saved provider endpoint or auth mode no longer matches the catalog');
    }
    providers.push(Object.freeze({
      id: idRaw,
      label,
      model,
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      ...providerBinding(preset),
    }));
  }
  const activeProvider = activeRaw === undefined ? null : activeRaw;
  if (activeProvider !== null && !seen.has(activeProvider)) {
    fail('invalid-document', 'the active provider is not configured');
  }
  return Object.freeze({
    version: PROVIDER_SETUP_VERSION,
    activeProvider,
    providers: Object.freeze(providers),
  });
}

function secretKeyForProvider(id) {
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) fail('invalid-provider', 'the provider id is invalid');
  return SECRET_KEY_PREFIX + id + '.apiKey';
}

function createProviderSetupModel(options = {}) {
  if (!isPlainObject(options)) fail('invalid-options', 'the setup options must be an object');
  const secretStorage = ownData(options, 'secretStorage', 'invalid-options', 'secret storage');
  if (secretStorage === null || typeof secretStorage !== 'object') fail('invalid-options', 'secret storage is required');
  for (const method of ['get', 'store', 'delete']) {
    methodOf(secretStorage, method, 'invalid-options', 'secret storage ' + method);
  }
  const environmentNames = normalizeEnvironmentNames(
    ownData(options, 'environmentNames', 'invalid-options', 'environment names'),
  );
  const presetsRaw = ownData(options, 'presets', 'invalid-options', 'presets');
  let catalog = presetsRaw === undefined ? Object.freeze([]) : normalizeCatalog(presetsRaw);
  let index = catalogIndex(catalog);
  let document = normalizeDocument(ownData(options, 'document', 'invalid-options', 'saved setup'), index);

  function ensureCatalog() {
    if (catalog.length === 0) fail('invalid-catalog', 'the provider catalog is empty');
  }

  function configured(id) {
    const entry = document.providers.find((candidate) => candidate.id === id);
    if (!entry) fail('unknown-provider', 'the provider is not configured');
    return entry;
  }

  function cloneDocument() {
    return Object.freeze({
      version: PROVIDER_SETUP_VERSION,
      activeProvider: document.activeProvider,
      providers: Object.freeze(document.providers.map((entry) => Object.freeze({
        id: entry.id,
        label: entry.label,
        model: entry.model,
        ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
        ...(entry.transport === undefined ? {} : { transport: entry.transport }),
        ...(entry.auth === undefined ? {} : { auth: entry.auth }),
        ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
        ...(entry.baseUrlEnv === undefined ? {} : { baseUrlEnv: entry.baseUrlEnv }),
      }))),
    });
  }

  async function secretOf(id) {
    let value;
    try {
      value = await secretStorage.get(secretKeyForProvider(id));
    } catch {
      fail('secret-store-unavailable', 'the secret store could not be read');
    }
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') fail('secret-store-unavailable', 'the secret store returned an invalid value');
    return value;
  }

  async function view() {
    const providers = [];
    for (const entry of document.providers) {
      const secret = await secretOf(entry.id);
      const envKnown = entry.apiKeyEnv !== undefined && environmentNames.includes(entry.apiKeyEnv);
      providers.push(Object.freeze({
        id: entry.id,
        label: entry.label,
        model: entry.model,
        ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
        hasSecret: secret !== undefined,
        credentialSource: secret !== undefined ? 'secret-storage' : envKnown ? 'environment' : 'none',
        active: document.activeProvider === entry.id,
      }));
    }
    return Object.freeze({
      version: PROVIDER_SETUP_VERSION,
      activeProvider: document.activeProvider,
      providers: Object.freeze(providers),
      presets: Object.freeze(catalog.map((preset) => Object.freeze({
        id: preset.id,
        label: preset.label,
        ...(preset.defaultModel === undefined ? {} : { defaultModel: preset.defaultModel }),
        ...(preset.apiKeyEnv === undefined ? {} : { apiKeyEnv: preset.apiKeyEnv }),
        apiKeyRequired: preset.apiKeyRequired,
        local: preset.local,
        configured: document.providers.some((entry) => entry.id === preset.id),
      }))),
      environmentNames,
    });
  }

  async function addProvider(input) {
    if (!isPlainObject(input)) fail('invalid-options', 'the provider request must be an object');
    for (const key of Object.keys(input)) {
      if (!ENTRY_KEYS.has(key)) fail('invalid-options', 'the provider request has an unknown field');
    }
    ensureCatalog();
    const id = ownData(input, 'id', 'invalid-options', 'provider id');
    if (typeof id !== 'string' || !PROVIDER_ID.test(id) || !index[id]) {
      fail('unknown-provider', 'the provider is not in the catalog');
    }
    const preset = index[id];
    const modelRaw = ownData(input, 'model', 'invalid-options', 'provider model');
    const model = validateModel(modelRaw === undefined || modelRaw === '' ? preset.defaultModel : modelRaw);
    const envRaw = ownData(input, 'apiKeyEnv', 'invalid-options', 'provider credential variable');
    const apiKeyEnv = envRaw === undefined ? preset.apiKeyEnv : validateEnvironmentName(envRaw);
    if (preset.apiKeyRequired && apiKeyEnv === undefined) {
      fail('missing-environment-name', 'this provider needs a credential environment variable');
    }
    const labelRaw = ownData(input, 'label', 'invalid-options', 'provider label');
    const label = labelRaw === undefined ? preset.label : validateLabel(labelRaw);
    const entry = Object.freeze({
      id,
      label,
      model,
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      ...providerBinding(preset),
    });
    const existing = document.providers.findIndex((candidate) => candidate.id === id);
    const providers = existing === -1
      ? [...document.providers, entry]
      : document.providers.map((candidate, position) => position === existing ? entry : candidate);
    if (providers.length > MAX_PROVIDERS) fail('too-many-providers', 'the provider list is full');
    document = Object.freeze({
      version: PROVIDER_SETUP_VERSION,
      activeProvider: document.activeProvider === null ? id : document.activeProvider,
      providers: Object.freeze(providers),
    });
    return Object.freeze({ id });
  }

  async function selectProvider(id) {
    configured(id);
    document = Object.freeze({ ...document, activeProvider: id });
    return Object.freeze({ id });
  }

  async function removeProvider(id) {
    configured(id);
    try {
      await secretStorage.delete(secretKeyForProvider(id));
    } catch {
      fail('secret-store-unavailable', 'the secret store could not be updated');
    }
    const providers = document.providers.filter((entry) => entry.id !== id);
    document = Object.freeze({
      version: PROVIDER_SETUP_VERSION,
      activeProvider: document.activeProvider === id ? null : document.activeProvider,
      providers: Object.freeze(providers),
    });
    return Object.freeze({ id });
  }

  async function addProviderWithSecret(input, secret) {
    const previous = document;
    const value = secret === undefined || secret === '' ? undefined : validateSecret(secret);
    const result = await addProvider(input);
    if (value !== undefined) {
      try {
        await setSecret(result.id, value);
      } catch (error) {
        document = previous;
        throw error;
      }
    }
    return result;
  }

  async function setSecret(id, value) {
    configured(id);
    const secret = validateSecret(value);
    try {
      await secretStorage.store(secretKeyForProvider(id), secret);
    } catch {
      fail('secret-store-unavailable', 'the secret store could not be updated');
    }
    return Object.freeze({ id, hasSecret: true });
  }

  async function clearSecret(id) {
    configured(id);
    try {
      await secretStorage.delete(secretKeyForProvider(id));
    } catch {
      fail('secret-store-unavailable', 'the secret store could not be updated');
    }
    return Object.freeze({ id, hasSecret: false });
  }

  async function resolveApiKey(id) {
    configured(id);
    return secretOf(id);
  }

  async function load(raw) {
    document = normalizeDocument(raw, index);
    return cloneDocument();
  }

  async function setCatalog(raw) {
    const nextCatalog = normalizeCatalog(raw);
    const nextIndex = catalogIndex(nextCatalog);
    for (const entry of document.providers) {
      const next = nextIndex[entry.id];
      if (!next) fail('invalid-catalog', 'the catalog no longer contains a configured provider');
      const current = index[entry.id];
      if (next.transport !== current.transport || next.auth !== current.auth ||
          next.baseUrl !== current.baseUrl || next.baseUrlEnv !== current.baseUrlEnv) {
        fail('invalid-catalog', 'the catalog changed a configured provider endpoint or auth mode');
      }
    }
    catalog = nextCatalog;
    index = nextIndex;
    return Object.freeze({ presets: catalog.length });
  }

  function toProviderSettings() {
    const providers = Object.create(null);
    for (const entry of document.providers) {
      const preset = index[entry.id];
      providers[preset.id] = Object.freeze({
        id: preset.id,
        label: entry.label,
        transport: preset.transport,
        ...(preset.baseUrl === undefined ? {} : { baseUrl: preset.baseUrl }),
        ...(preset.baseUrlEnv === undefined ? {} : { baseUrlEnv: preset.baseUrlEnv }),
        model: entry.model,
        auth: preset.auth,
        ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
        apiKeyRequired: preset.apiKeyRequired,
        capabilities: preset.capabilities,
        local: preset.local,
      });
    }
    return Object.freeze({ providers: Object.freeze(providers) });
  }

  return Object.freeze({
    view,
    addProvider,
    addProviderWithSecret,
    selectProvider,
    removeProvider,
    setSecret,
    clearSecret,
    resolveApiKey,
    load,
    setCatalog,
    document: cloneDocument,
    toProviderSettings,
    describe: () => Object.freeze({
      version: PROVIDER_SETUP_VERSION,
      presets: catalog.length,
      providers: document.providers.map((entry) => entry.id),
      activeProvider: document.activeProvider,
    }),
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderProviderSetupHtml(view, options = {}) {
  if (!isPlainObject(view) || !Array.isArray(view.providers) || !Array.isArray(view.presets)) {
    fail('invalid-view', 'the provider setup view is invalid');
  }
  if (!isPlainObject(options)) fail('invalid-view', 'the render options are invalid');
  const nonce = ownData(options, 'nonce', 'invalid-view', 'render nonce') === undefined
    ? crypto.randomBytes(16).toString('base64url')
    : ownData(options, 'nonce', 'invalid-view', 'render nonce');
  if (typeof nonce !== 'string' || !SAFE_NONCE.test(nonce)) fail('invalid-view', 'the render nonce is invalid');
  const presetOptions = view.presets.map((preset) => {
    const suffix = preset.defaultModel === undefined ? '' : ' (' + preset.defaultModel + ')';
    return '<option value="' + escapeHtml(preset.id) + '">' + escapeHtml(preset.label + suffix) + '</option>';
  }).join('');
  const environmentOptions = view.environmentNames.map((name) =>
    '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>').join('');
  const rows = view.providers.map((entry) => {
    const source = CREDENTIAL_SOURCES.has(entry.credentialSource) ? entry.credentialSource : 'none';
    return [
      '<tr class="provider-row' + (entry.active ? ' active' : '') + '" data-provider-id="' + escapeHtml(entry.id) + '">',
      '<td>' + escapeHtml(entry.label) + '</td>',
      '<td><code>' + escapeHtml(entry.id) + '</code></td>',
      '<td>' + escapeHtml(entry.model) + '</td>',
      '<td>' + escapeHtml(source) + '</td>',
      '<td>',
      '<button type="button" data-action="select" data-provider-id="' + escapeHtml(entry.id) + '">Use</button>',
      '<button type="button" data-action="remove" data-provider-id="' + escapeHtml(entry.id) + '">Remove</button>',
      '<button type="button" data-action="clear-secret" data-provider-id="' + escapeHtml(entry.id) + '">Forget key</button>',
      '</td>',
      '<td><label>API key <input type="password" autocomplete="off" data-field="secret" data-provider-id="' +
        escapeHtml(entry.id) + '"></label>',
      '<button type="button" data-action="save-secret" data-provider-id="' + escapeHtml(entry.id) + '">Save key</button></td>',
      '</tr>',
    ].join('');
  }).join('\n');
  const csp = "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "';";
  const script = [
    "(function () {",
    "  const api = acquireVsCodeApi();",
    "  function value(name, id) {",
    "    const selector = id",
    "      ? '[data-field=\"' + name + '\"][data-provider-id=\"' + id + '\"]'",
    "      : '[data-field=\"' + name + '\"]';",
    "    const node = document.querySelector(selector);",
    "    return node ? node.value : '';",
    "  }",
    "  document.addEventListener('click', function (event) {",
    "    const button = event.target.closest('[data-action]');",
    "    if (!button) return;",
    "    const action = button.getAttribute('data-action');",
    "    const id = button.getAttribute('data-provider-id') || '';",
    "    if (action === 'add') {",
    "      const apiKeyEnv = value('apiKeyEnv');",
    "      const message = { type: 'add', id: value('preset'), model: value('model'), secret: value('secret') };",
    "      if (apiKeyEnv) message.apiKeyEnv = apiKeyEnv;",
    "      api.postMessage(message);",
    "      return;",
    "    }",
    "    if (action === 'select' || action === 'remove' || action === 'clear-secret') {",
    "      api.postMessage({ type: action, id: id });",
    "      return;",
    "    }",
    "    if (action === 'save-secret') {",
    "      api.postMessage({ type: 'save-secret', id: id, value: value('secret', id) });",
    "    }",
    "  });",
    "}());",
  ].join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<title>Vibe Providers</title>',
    '<style nonce="' + nonce + '">',
    'body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); margin: 0; }',
    'header { padding: 14px 18px 8px; border-bottom: 1px solid var(--vscode-panel-border); }',
    'header h1 { font-size: 16px; margin: 0 0 6px; }',
    'main { padding: 14px 18px 24px; }',
    'form { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-bottom: 16px; }',
    'label { display: flex; flex-direction: column; gap: 4px; color: var(--vscode-descriptionForeground); }',
    'table { width: 100%; border-collapse: collapse; }',
    'th, td { text-align: left; padding: 6px; border-bottom: 1px solid var(--vscode-panel-border); }',
    'tr.active td:first-child { font-weight: 600; }',
    'button { margin-right: 4px; }',
    '</style>',
    '</head>',
    '<body>',
    '<header><h1>Vibe Providers</h1>',
    '<p>' + view.providers.length + ' configured of ' + view.presets.length + ' available providers.</p></header>',
    '<main>',
    '<form>',
    '<label>Provider<select data-field="preset">' + presetOptions + '</select></label>',
    '<label>Model<input data-field="model" autocomplete="off"></label>',
    '<label>Environment variable<select data-field="apiKeyEnv"><option value="">none</option>' + environmentOptions + '</select></label>',
    '<label>API key<input type="password" autocomplete="off" data-field="secret"></label>',
    '<button type="button" data-action="add">Add provider</button>',
    '</form>',
    '<table>',
    '<thead><tr><th>Provider</th><th>Id</th><th>Model</th><th>Credential</th><th>Actions</th><th>Secret</th></tr></thead>',
    '<tbody>' + rows + '</tbody>',
    '</table>',
    '</main>',
    '<script nonce="' + nonce + '">',
    script,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

function createProviderSetupController(options = {}) {
  if (!isPlainObject(options)) fail('invalid-options', 'the controller options must be an object');
  const vscode = ownData(options, 'vscode', 'invalid-options', 'vscode');
  if (!vscode || typeof vscode !== 'object') fail('invalid-options', 'vscode is required');
  const secretStorage = ownData(options, 'secretStorage', 'invalid-options', 'secret storage');
  const environmentNames = normalizeEnvironmentNames(
    ownData(options, 'environmentNames', 'invalid-options', 'environment names'),
  );
  const extensionUri = ownData(options, 'extensionUri', 'invalid-options', 'extension URI');
  const saveDocument = ownData(options, 'saveDocument', 'invalid-options', 'save document');
  if (saveDocument !== undefined && typeof saveDocument !== 'function') {
    fail('invalid-options', 'save document must be a function');
  }
  const initialDocument = ownData(options, 'document', 'invalid-options', 'saved setup');
  const initialPresets = ownData(options, 'presets', 'invalid-options', 'presets');
  let panel = null;
  let presets = initialPresets === undefined ? null : initialPresets;
  let pendingDocument = initialDocument;
  let model = null;

  function ensureModel() {
    if (model || presets === null) return model;
    model = createProviderSetupModel({
      secretStorage,
      environmentNames,
      presets,
      ...(pendingDocument === undefined ? {} : { document: pendingDocument }),
    });
    pendingDocument = undefined;
    return model;
  }

  async function persist() {
    if (saveDocument && model) await saveDocument(model.document());
  }

  async function currentView() {
    const active = ensureModel();
    return active ? active.view() : null;
  }

  async function refresh() {
    if (!panel) return;
    const view = await currentView();
    if (view) panel.webview.html = renderProviderSetupHtml(view);
  }

  async function setCatalog(next) {
    if (!Array.isArray(next) || next.length === 0) fail('invalid-catalog', 'the provider catalog is empty');
    const active = ensureModel();
    if (active) {
      await active.setCatalog(next);
      presets = next;
    } else {
      model = createProviderSetupModel({
        secretStorage,
        environmentNames,
        presets: next,
        ...(pendingDocument === undefined ? {} : { document: pendingDocument }),
      });
      presets = next;
      pendingDocument = undefined;
    }
    await persist();
    await refresh();
    const view = await currentView();
    return Object.freeze({ configured: view !== null, presets: view ? view.presets.length : 0 });
  }

  async function open() {
    if (!ensureModel()) {
      vscode.window.showWarningMessage('Vibe Providers: the provider catalog is not connected.');
      return Object.freeze({ opened: false, reason: 'no-catalog' });
    }
    if (panel) {
      panel.reveal();
      await refresh();
      return Object.freeze({ opened: true, refreshed: true });
    }
    panel = vscode.window.createWebviewPanel('vibecodium.providers', 'Vibe Providers', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: extensionUri ? [extensionUri] : [],
    });
    panel.webview.onDidReceiveMessage(async (message) => {
      try {
        await handleMessage(message);
      } catch {
        vscode.window.showWarningMessage('Vibe Providers: the request could not be completed.');
      }
    });
    panel.onDidDispose(() => { panel = null; });
    await refresh();
    return Object.freeze({ opened: true });
  }

  async function apply(type, id) {
    const active = ensureModel();
    if (!active) return Object.freeze({ handled: true, ok: false, code: 'no-catalog' });
    if (type === 'select') await active.selectProvider(id);
    else if (type === 'remove') await active.removeProvider(id);
    else await active.clearSecret(id);
    await persist();
    await refresh();
    return Object.freeze({ handled: true, ok: true, kind: type, id });
  }

  async function addPersisted(input, secret) {
    const active = ensureModel();
    const previous = active.document();
    const result = await active.addProvider(input);
    try {
      await persist();
    } catch (error) {
      await active.load(previous);
      throw error;
    }
    if (secret !== undefined && secret !== '') {
      try {
        await active.setSecret(result.id, secret);
      } catch (error) {
        await active.load(previous);
        await persist().catch(() => {});
        throw error;
      }
    }
    return result;
  }

  async function handleMessage(message) {
    if (!isPlainObject(message)) return Object.freeze({ handled: false, reason: 'invalid-message' });
    const active = ensureModel();
    if (!active) return Object.freeze({ handled: true, ok: false, code: 'no-catalog' });
    try {
      const type = ownData(message, 'type', 'invalid-message', 'message type');
      if (type === 'refresh') {
        await refresh();
        return Object.freeze({ handled: true, ok: true });
      }
      if (type === 'add') {
        const id = ownData(message, 'id', 'invalid-message', 'provider id');
        const result = await addPersisted({
          id,
          model: ownData(message, 'model', 'invalid-message', 'provider model'),
          apiKeyEnv: ownData(message, 'apiKeyEnv', 'invalid-message', 'provider credential variable'),
        }, ownData(message, 'secret', 'invalid-message', 'provider secret'));
        await refresh();
        return Object.freeze({ handled: true, ok: true, kind: 'add', id: result.id });
      }
      if (type === 'select' || type === 'remove' || type === 'clear-secret') {
        return await apply(type, ownData(message, 'id', 'invalid-message', 'provider id'));
      }
      if (type === 'save-secret') {
        const id = ownData(message, 'id', 'invalid-message', 'provider id');
        const value = ownData(message, 'value', 'invalid-message', 'provider secret');
        const result = await active.setSecret(id, value);
        await refresh();
        return Object.freeze({ handled: true, ok: true, kind: 'save-secret', id: result.id, hasSecret: result.hasSecret });
      }
      return Object.freeze({ handled: false, reason: 'invalid-message' });
    } catch (error) {
      if (error instanceof ProviderSetupError) {
        await refresh().catch(() => {});
        return Object.freeze({ handled: true, ok: false, code: error.code });
      }
      throw error;
    }
  }

  function dispose() {
    if (panel) panel.dispose();
    panel = null;
  }

  return Object.freeze({
    setCatalog,
    open,
    refresh,
    handleMessage,
    view: currentView,
    html: () => panel ? panel.webview.html : null,
    document: () => model ? model.document() : null,
    dispose,
  });
}

module.exports = {
  PROVIDER_SETUP_VERSION,
  MAX_PROVIDERS,
  MAX_ENV_NAMES,
  MAX_SECRET_CHARS,
  ProviderSetupError,
  createProviderSetupModel,
  createProviderSetupController,
  renderProviderSetupHtml,
  secretKeyForProvider,
};
