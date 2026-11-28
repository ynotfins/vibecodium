// M3 local provider host.
//
// The narrow bridge between the first-run wizard's validated start plan and the B1 request client:
// it starts the delivered `llama-server` supervisor, reads the controller's API key through the one
// accessor that exposes it, and hands a ready `llama-cpp` client (or an `ollama` client for a
// selected daemon) to the host process. The key lives only in the client's closure: no snapshot,
// error or serialized controller carries it, and the caller never sees it.
//
// It never downloads, installs, signs or probes anything; the wizard supplies the verified runtime
// and weights, and the supervisor owns the process boundary. Node built-ins only.

import { createLlamaServer } from './llama-server.mjs';
import { MAX_API_KEY_CHARS, MIN_API_KEY_CHARS } from './llama-server.mjs';
import { createProviderClient } from '../gateway/provider-client.mjs';
import { validateProviderBaseUrl, validateProviderModel } from '../gateway/provider-presets.mjs';
import { classifyAIEndpoint } from '../security/ai-endpoint-policy.mjs';

export const LOCAL_PROVIDER_VERSION = 1;
// The supervisor's own bounds on the key it generates or accepts.
export { MAX_API_KEY_CHARS, MIN_API_KEY_CHARS };

const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const SAFE_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const OPTION_KEYS = Object.freeze(new Set(['wizard', 'policy']));
// The first-run wizard's blocked start reasons. Anything else is reported as `unavailable`, so a
// hostile or malformed reason cannot reach a log, a UI or an error unchanged.
const BLOCKED_REASONS = Object.freeze(new Set([
  'not-ready',
  'runtime-not-bundled',
  'runtime-install-failed',
  'disposed',
  'no-embedding-model',
]));

export class LocalProviderError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LocalProviderError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function fail(code, message, extra) {
  throw new LocalProviderError(code, message, extra);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  let prototype;
  try {
    if (Array.isArray(value)) return false;
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

// Reads one own data property without invoking an accessor or walking a polluted prototype.
function readField(object, name) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, name);
  } catch {
    return undefined;
  }
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function readWizardMethod(wizard, name) {
  if (!isPlainObject(wizard)) fail('invalid-options', 'wizard must be a plain object');
  const method = readField(wizard, name);
  if (typeof method !== 'function') fail('invalid-options', 'wizard must expose ' + name + '()');
  return method;
}

function callWizard(wizard, method, name) {
  let result;
  try {
    result = method.call(wizard);
  } catch {
    fail('handoff-failed', 'the first-run wizard could not provide ' + name);
  }
  return result;
}

// Copies the caller's policy into a frozen bag whose array options are themselves copied and frozen.
// A shallow freeze would keep `allowHosts`/`allowEndpoints` by reference, so a later `push` could widen
// egress after construction. Only own data properties are read: an accessor is rejected, never invoked.
function snapshotPolicy(policy) {
  if (policy === undefined) return Object.freeze(Object.create(null));
  if (!isPlainObject(policy)) fail('invalid-options', 'policy must be a plain object');
  let keys;
  try {
    keys = Object.keys(policy);
  } catch {
    fail('invalid-options', 'policy cannot be read');
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(policy, key);
    } catch {
      fail('invalid-options', 'policy cannot be read');
    }
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('invalid-options', 'policy must hold data properties only');
    }
    const raw = descriptor.value;
    let isArray;
    try {
      isArray = Array.isArray(raw);
    } catch {
      fail('invalid-options', 'policy cannot be read');
    }
    if (!isArray) {
      snapshot[key] = raw;
      continue;
    }
    let lengthDescriptor;
    try {
      lengthDescriptor = Object.getOwnPropertyDescriptor(raw, 'length');
    } catch {
      fail('invalid-options', 'policy cannot be read');
    }
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor) ||
        typeof lengthDescriptor.value !== 'number') {
      fail('invalid-options', 'policy arrays must have a plain length');
    }
    const list = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      let itemDescriptor;
      try {
        itemDescriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      } catch {
        fail('invalid-options', 'policy cannot be read');
      }
      if (itemDescriptor === undefined || !('value' in itemDescriptor)) {
        fail('invalid-options', 'policy arrays must hold data entries only');
      }
      list.push(itemDescriptor.value);
    }
    snapshot[key] = Object.freeze(list);
  }
  return Object.freeze(snapshot);
}

function readOptions(options) {
  if (!isPlainObject(options)) fail('invalid-options', 'options must be an object');
  let keys;
  try {
    keys = Object.keys(options);
  } catch {
    fail('invalid-options', 'options cannot be read');
  }
  for (const key of keys) {
    if (!OPTION_KEYS.has(key)) fail('invalid-options', 'unknown option: ' + key);
  }
  return Object.freeze({
    wizard: readField(options, 'wizard'),
    policy: snapshotPolicy(readField(options, 'policy')),
  });
}

function boundedReason(value) {
  return typeof value === 'string' && BLOCKED_REASONS.has(value) ? value : 'unavailable';
}

function boundedCode(error) {
  const code = error !== null && typeof error === 'object' ? readField(error, 'code') : undefined;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'start-failed';
}

// The daemon hand-off must stay on loopback: the wizard's Ollama discovery is fixed at
// http://127.0.0.1:11434, so a plan naming any other host is hostile or misconfigured and fails closed.
// `classifyAIEndpoint` already rejects unparsable URLs, credentials, control characters and punycode.
// `new URL()` normalises `0:0:0:0:0:0:0:1` to `[::1]` and an IPv4-mapped address to its hex form, so the
// literal checks here only need the normalised spellings.
function isLoopbackHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (bare === '::1') return true;
  const parts = bare.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
}

// The supervisor's `auth()` result is the only key path. Anything else - a missing accessor, a key
// outside the supervisor's own 32..128 character range, a control or bidi character, an accessor
// property - fails closed without echoing the value.
export function resolveRuntimeApiKey(auth) {
  if (!isPlainObject(auth)) fail('missing-api-key', 'the local runtime did not expose an API key');
  const apiKey = readField(auth, 'apiKey');
  if (typeof apiKey !== 'string' || apiKey.length < MIN_API_KEY_CHARS || apiKey.length > MAX_API_KEY_CHARS ||
      CONTROL_OR_BIDI.test(apiKey)) {
    fail('missing-api-key', 'the local runtime API key is not usable');
  }
  return apiKey;
}

export function createLocalProvider(options) {
  const own = readOptions(options);
  const runtimeOptions = readWizardMethod(own.wizard, 'runtimeOptions');
  const startPlan = readWizardMethod(own.wizard, 'startPlan');
  const state = {
    state: 'idle',
    kind: null,
    id: null,
    label: null,
    baseUrl: null,
    model: null,
    port: null,
    pid: null,
    failure: null,
  };
  let server = null;
  let client = null;
  let startPromise = null;
  let stopPromise = null;
  let disposed = false;
  let stopRequested = false;

  function snapshot() {
    return Object.freeze({
      version: LOCAL_PROVIDER_VERSION,
      state: state.state,
      kind: state.kind,
      id: state.id,
      label: state.label,
      baseUrl: state.baseUrl,
      model: state.model,
      port: state.port,
      pid: state.pid,
      failure: state.failure === null ? null : Object.freeze({ ...state.failure }),
    });
  }

  function clearRunning() {
    client = null;
    state.kind = null;
    state.id = null;
    state.label = null;
    state.baseUrl = null;
    state.model = null;
    state.port = null;
    state.pid = null;
  }

  function adoptClient(created) {
    const config = created.config;
    client = created;
    state.kind = config.id === 'ollama' ? 'ollama' : 'llama-server';
    state.id = config.id;
    state.label = config.label;
    state.baseUrl = config.baseUrl;
    state.model = config.model;
  }

  function readHandoff() {
    const hand = callWizard(own.wizard, runtimeOptions, 'a start plan');
    if (!isPlainObject(hand)) fail('invalid-handoff', 'the first-run start plan is not an object');
    if (hand.available !== true) {
      const reason = boundedReason(readField(hand, 'reason'));
      fail('runtime-unavailable', 'the local runtime is not available', { reason });
    }
    return hand;
  }

  function startDaemon(hand) {
    let baseUrl;
    let model;
    try {
      baseUrl = validateProviderBaseUrl(readField(hand, 'baseUrl'));
      model = validateProviderModel(readField(hand, 'model'));
    } catch {
      fail('invalid-handoff', 'the daemon start plan is not usable');
    }
    // A daemon hand-off is loopback-only, whatever the caller's policy says. Without this check a
    // hostile plan plus `allowExternalProviders: true` would point the client at a remote host.
    let classification;
    try {
      classification = classifyAIEndpoint(baseUrl);
    } catch {
      fail('invalid-handoff', 'the daemon start plan is not a loopback endpoint');
    }
    if (classification.ok !== true || classification.category !== 'local-model' ||
        !isLoopbackHost(classification.host)) {
      fail('invalid-handoff', 'the daemon start plan is not a loopback endpoint');
    }
    const created = createProviderClient('ollama', { baseUrl, model, policy: own.policy, env: {} });
    adoptClient(created);
    state.port = null;
    state.pid = null;
    server = null;
    state.state = 'running';
    state.failure = null;
    return snapshot();
  }

  async function startPinned(hand) {
    const handOptions = readField(hand, 'options');
    if (!isPlainObject(handOptions)) fail('invalid-handoff', 'the pinned start plan has no supervisor options');
    const plan = callWizard(own.wizard, startPlan, 'a start plan');
    if (!isPlainObject(plan) || plan.available !== true || readField(plan, 'kind') !== 'llama-server') {
      fail('invalid-plan', 'the first-run plan is not a pinned start plan');
    }
    let model;
    try {
      model = validateProviderModel(readField(plan, 'model'));
    } catch {
      fail('invalid-plan', 'the first-run plan has no usable B1 model name');
    }
    if (server === null) server = createLlamaServer(handOptions);
    const started = await server.start();
    const apiKey = resolveRuntimeApiKey(server.auth());
    const created = createProviderClient('llama-cpp', {
      baseUrl: started.baseUrl,
      model,
      apiKey,
      policy: own.policy,
      env: {},
    });
    adoptClient(created);
    state.port = started.port;
    state.pid = started.pid;
    state.state = 'running';
    state.failure = null;
    return snapshot();
  }

  function start() {
    if (disposed) return Promise.reject(new LocalProviderError('disposed', 'the local provider is disposed'));
    if (state.state === 'running') return Promise.resolve(snapshot());
    if (startPromise !== null) return startPromise;
    if (stopPromise !== null) {
      return stopPromise.then(start);
    }
    stopRequested = false;
    state.state = 'starting';
    state.failure = null;
    const pending = (async () => {
      const hand = readHandoff();
      if (readField(hand, 'kind') === 'ollama') return startDaemon(hand);
      return startPinned(hand);
    })().catch(async (error) => {
      const code = boundedCode(error);
      const reason = error instanceof LocalProviderError ? error.reason : undefined;
      state.failure = Object.freeze(
        typeof reason === 'string' ? { code, reason: boundedReason(reason) } : { code },
      );
      client = null;
      if (server !== null) {
        const failed = server;
        server = null;
        try {
          await failed.stop();
        } catch { /* the supervisor is already stopped or gone */ }
      }
      state.pid = null;
      state.port = null;
      state.kind = null;
      state.id = null;
      state.label = null;
      state.baseUrl = null;
      state.model = null;
      if (stopRequested) {
        state.state = 'stopped';
        state.failure = null;
      } else {
        state.state = 'failed';
      }
      throw error instanceof LocalProviderError
        ? error
        : new LocalProviderError(code, 'the local runtime could not be started');
    }).finally(() => {
      startPromise = null;
    });
    startPromise = pending;
    return pending;
  }

  function stop() {
    if (stopPromise !== null) return stopPromise;
    stopRequested = true;
    stopPromise = (async () => {
      if (startPromise !== null) {
        try {
          await startPromise;
        } catch { /* a requested stop wins over a failed start */ }
      }
      if (server !== null) {
        const target = server;
        // Keep the controller so a later start reuses the same validated runtime and key.
        try {
          await target.stop();
        } catch { /* the supervisor is already stopped or gone */ }
      }
      clearRunning();
      state.state = 'stopped';
      state.failure = null;
      return snapshot();
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function dispose() {
    if (disposed) return stop();
    disposed = true;
    const stopped = await stop();
    server = null;
    return stopped;
  }

  return Object.freeze({
    version: LOCAL_PROVIDER_VERSION,
    start,
    stop,
    dispose,
    status: snapshot,
    describe: snapshot,
    client: () => client,
  });
}
