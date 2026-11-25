// M2 B6 first acceptance: the direct second-option route policy.
//
// This module builds the validated B3 policy that puts OmniRoute first and the direct provider
// second for every task class. It is deliberately data-only: it creates no client, reads no
// environment variable, holds no credential and performs no network I/O. The caller supplies
// already-created B1 clients to the B3 router under the ids `omniroute` and `morph`.

import { TASK_CLASSES } from './provider-router.mjs';
import { MAX_OUTPUT_TOKENS } from './provider-client.mjs';
import { MAX_MODEL_CHARS, MODEL_NAME } from './provider-presets.mjs';

export const MORPH_DIRECT_VERSION = 1;
export const MORPH_DIRECT_PROVIDER_ORDER = Object.freeze(['omniroute', 'morph']);

const OPTION_KEYS = new Set(['omnirouteModels', 'morphModels', 'outputCaps']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;

export class MorphDirectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MorphDirectError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MorphDirectError(code, message);
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

function ownData(object, key, label) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    fail('invalid-options', label + ' cannot be read');
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) fail('invalid-accessor', label + ' must be a data property');
  return descriptor.value;
}

function keysOf(value, label) {
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-options', label + ' cannot be enumerated');
  }
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) fail('invalid-options', label + ' has duplicate keys');
    seen.add(key);
  }
  return keys;
}

function readOptions(value) {
  if (!isPlainObject(value)) fail('invalid-options', 'options must be a plain object');
  const keys = keysOf(value, 'options');
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) fail('invalid-options', 'options has a reserved key');
    if (!OPTION_KEYS.has(key)) fail('invalid-options', 'unknown option');
  }
  for (const key of OPTION_KEYS) {
    if (!keys.includes(key)) fail('invalid-options', 'missing option: ' + key);
  }
  return {
    omnirouteModels: ownData(value, 'omnirouteModels', 'omniroute model map'),
    morphModels: ownData(value, 'morphModels', 'morph model map'),
    outputCaps: ownData(value, 'outputCaps', 'output cap map'),
  };
}

function readClassMap(value, label, validate) {
  if (!isPlainObject(value)) fail('invalid-options', label + ' must be a plain object');
  const keys = keysOf(value, label);
  const out = Object.create(null);
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) fail('invalid-options', label + ' has a reserved key');
    if (!TASK_CLASSES.includes(key)) fail('invalid-class', label + ' has an unknown task class');
    out[key] = validate(ownData(value, key, label + ' ' + key), key);
  }
  for (const taskClass of TASK_CLASSES) {
    if (!Object.prototype.hasOwnProperty.call(out, taskClass)) {
      fail('invalid-class', label + ' is missing task class ' + taskClass);
    }
  }
  return out;
}

function validateModel(value, taskClass) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MODEL_CHARS ||
      CONTROL_OR_BIDI.test(value) || !MODEL_NAME.test(value)) {
    fail('invalid-model', 'model for ' + taskClass + ' is invalid');
  }
  return value;
}

function validateCap(value, taskClass) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_OUTPUT_TOKENS) {
    fail('invalid-cap', 'output cap for ' + taskClass + ' is invalid');
  }
  if (taskClass === 'embed' && value !== 0) {
    fail('invalid-cap', 'embedding output cap must be zero');
  }
  if (taskClass !== 'embed' && value === 0) {
    fail('invalid-cap', 'chat output cap must be positive');
  }
  return value;
}

// Builds the complete B3 policy. Every class gets exactly the two direct routes, in order, with
// the caller's explicit model and output cap for each. Passing a partial map is an error rather
// than a silent default, so a missing or misspelled class cannot drop a provider.
export function createMorphDirectPolicy(options) {
  const config = readOptions(options);
  const omnirouteModels = readClassMap(config.omnirouteModels, 'omniroute model map', validateModel);
  const morphModels = readClassMap(config.morphModels, 'morph model map', validateModel);
  const outputCaps = readClassMap(config.outputCaps, 'output cap map', validateCap);

  const policy = {};
  for (const taskClass of TASK_CLASSES) {
    policy[taskClass] = Object.freeze([
      Object.freeze({
        provider: 'omniroute',
        model: omnirouteModels[taskClass],
        maxOutputTokens: outputCaps[taskClass],
      }),
      Object.freeze({
        provider: 'morph',
        model: morphModels[taskClass],
        maxOutputTokens: outputCaps[taskClass],
      }),
    ]);
  }
  return Object.freeze(policy);
}

export function describeMorphDirect() {
  return Object.freeze({
    version: MORPH_DIRECT_VERSION,
    providerOrder: MORPH_DIRECT_PROVIDER_ORDER,
    taskClasses: TASK_CLASSES,
  });
}