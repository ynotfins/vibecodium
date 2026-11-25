// M2 B2 ordered provider fallback.
//
// This layer composes the B1 request clients. It fails over only when the current provider has a
// transient problem: a timeout, a network error, HTTP 408/429/5xx, or a chat answer with neither
// text nor a tool call. Request validation, authentication, endpoint-policy denial and caller
// cancellation are returned unchanged and never cause another provider to be contacted.

import { ProviderClientError } from './provider-client.mjs';
import {
  MAX_LABEL_CHARS,
  MAX_MODEL_CHARS,
  MODEL_NAME,
  PROVIDER_ID,
} from './provider-presets.mjs';

export const PROVIDER_FALLBACK_VERSION = 1;
export const MAX_PROVIDERS = 8;

const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const RETRYABLE_STATUS = new Set([408, 429]);
const ENTRY_KEYS = new Set(['id', 'label', 'model', 'client']);
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET',
  'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_REQ_RETRY', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_ABORT',
]);

export class ProviderFallbackError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ProviderFallbackError';
    this.code = code;
    if (extra.attempts !== undefined) this.attempts = extra.attempts;
  }
}

function fail(code, message, extra) {
  throw new ProviderFallbackError(code, message, extra);
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

function validateLabel(value, id) {
  if (value === undefined) return id;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LABEL_CHARS ||
      CONTROL_OR_BIDI.test(value)) {
    fail('invalid-provider', 'provider ' + id + ' has an invalid label');
  }
  return value;
}

function validateModel(value, id) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MODEL_CHARS ||
      CONTROL_OR_BIDI.test(value) || !MODEL_NAME.test(value)) {
    fail('invalid-provider', 'provider ' + id + ' has an invalid model');
  }
  return value;
}

function validateEntry(raw, seen) {
  if (!isPlainObject(raw)) fail('invalid-provider', 'fallback providers must be plain objects');
  let keys;
  try {
    keys = Object.keys(raw);
  } catch {
    fail('invalid-provider', 'fallback provider fields cannot be read');
  }
  for (const key of keys) {
    if (!ENTRY_KEYS.has(key)) fail('invalid-provider', 'unknown fallback provider field: ' + key);
  }
  const id = ownData(raw, 'id', 'invalid-provider', 'provider id');
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) {
    fail('invalid-provider', 'fallback provider ids must be lowercase identifiers');
  }
  if (seen.has(id)) fail('duplicate-provider', 'fallback provider ' + id + ' is listed twice');
  seen.add(id);
  const client = ownData(raw, 'client', 'invalid-provider', 'provider client');
  if (client === null || typeof client !== 'object') {
    fail('invalid-provider', 'provider ' + id + ' needs a client object');
  }
  const chat = ownData(client, 'chat', 'invalid-provider', 'provider chat method');
  if (typeof chat !== 'function') fail('invalid-provider', 'provider ' + id + ' needs a chat method');
  const embeddings = ownData(client, 'embeddings', 'invalid-provider', 'provider embeddings method');
  if (embeddings !== undefined && typeof embeddings !== 'function') {
    fail('invalid-provider', 'provider ' + id + ' has an invalid embeddings method');
  }
  return Object.freeze({
    id,
    label: validateLabel(ownData(raw, 'label', 'invalid-provider', 'provider label'), id),
    model: validateModel(ownData(raw, 'model', 'invalid-provider', 'provider model'), id),
    client,
    chat,
    embeddings,
  });
}

function safeProperty(object, key) {
  if (object === null || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function networkFailure(error) {
  const code = safeProperty(error, 'code');
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  const cause = safeProperty(error, 'cause');
  if (cause === undefined || cause === error) return false;
  const causeCode = safeProperty(cause, 'code');
  return typeof causeCode === 'string' && NETWORK_CODES.has(causeCode);
}

function attemptFor(entry, outcome, error) {
  const attempt = { id: entry.id, label: entry.label, outcome };
  if (error !== undefined) {
    const code = error instanceof ProviderClientError ? error.code : undefined;
    if (typeof code === 'string') attempt.code = code;
    else if (networkFailure(error)) attempt.code = 'network-error';
    const status = safeProperty(error, 'status');
    if (Number.isInteger(status)) attempt.status = status;
  }
  return Object.freeze(attempt);
}

function retryable(error) {
  if (error instanceof ProviderClientError) {
    if (error.code === 'timeout' || error.code === 'network-error') return true;
    if (error.code !== 'http-status' || !Number.isInteger(error.status)) return false;
    return RETRYABLE_STATUS.has(error.status) || (error.status >= 500 && error.status <= 599);
  }
  return networkFailure(error);
}

function emptyAnswer(result) {
  return isPlainObject(result) && typeof result.text === 'string' && result.text.length === 0 &&
    Array.isArray(result.toolCalls) && result.toolCalls.length === 0;
}

function dataCopy(input) {
  const copy = {};
  let keys;
  try {
    keys = Object.keys(input);
  } catch {
    fail('invalid-options', 'request options cannot be read');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('invalid-options', 'request options must contain data properties only');
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

// The caller's model applies to the first provider. A later provider uses its own configured model
// and otherwise falls back to the model its client resolved, never the primary provider's model.
function inputForAttempt(input, entry, index) {
  if (!isPlainObject(input)) return input;
  const hasModel = Object.getOwnPropertyDescriptor(input, 'model') !== undefined;
  if (index === 0 && (hasModel || entry.model === undefined)) return input;
  const copy = dataCopy(input);
  if (entry.model !== undefined) copy.model = entry.model;
  else delete copy.model;
  return copy;
}

function answer(result, entry, index, attempts) {
  return Object.freeze({
    ...result,
    servedBy: Object.freeze({ id: entry.id, label: entry.label, fallback: index > 0 }),
    attempts: Object.freeze(attempts),
  });
}

export function createProviderFallback(rawEntries) {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0 || rawEntries.length > MAX_PROVIDERS) {
    fail('invalid-chain', 'a fallback chain needs between 1 and ' + MAX_PROVIDERS + ' providers');
  }
  let length;
  try {
    length = rawEntries.length;
    for (let index = 0; index < length; index += 1) {
      if (Object.getOwnPropertyDescriptor(rawEntries, String(index)) === undefined) {
        fail('invalid-provider', 'fallback providers cannot be sparse');
      }
    }
  } catch (error) {
    if (error instanceof ProviderFallbackError) throw error;
    fail('invalid-chain', 'fallback providers cannot be read');
  }
  const seen = new Set();
  const entries = [];
  for (let index = 0; index < length; index += 1) {
    entries.push(validateEntry(ownData(rawEntries, String(index), 'invalid-provider', 'fallback provider'), seen));
  }
  const providers = Object.freeze(entries);

  async function run(operation, input) {
    const attempts = [];
    for (let index = 0; index < providers.length; index += 1) {
      const entry = providers[index];
      const method = entry[operation];
      if (typeof method !== 'function') {
        fail('unsupported-operation', 'provider ' + entry.id + ' does not implement ' + operation);
      }
      let result;
      try {
        result = await method.call(entry.client, inputForAttempt(input, entry, index));
      } catch (error) {
        if (!retryable(error)) throw error;
        attempts.push(attemptFor(entry, 'failed', error));
        continue;
      }
      if (operation === 'chat' && emptyAnswer(result)) {
        attempts.push(attemptFor(entry, 'empty'));
        continue;
      }
      attempts.push(attemptFor(entry, 'answered'));
      return answer(result, entry, index, attempts);
    }
    fail('fallback-exhausted', 'every provider in the fallback chain failed', {
      attempts: Object.freeze(attempts),
    });
  }

  return Object.freeze({
    describe: () => Object.freeze({
      version: PROVIDER_FALLBACK_VERSION,
      providers: Object.freeze(providers.map((entry) => Object.freeze({
        id: entry.id,
        label: entry.label,
        ...(entry.model === undefined ? {} : { model: entry.model }),
      }))),
    }),
    chat: (input = {}) => run('chat', input),
    embeddings: (input = {}) => run('embeddings', input),
  });
}
