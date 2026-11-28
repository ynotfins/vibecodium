// M2 B6: the Morph-hosted Fast Model rows for the direct provider.
//
// This module records the chat rows Morph publishes on its machine-readable model feed, so the
// direct second option can name a real hosted model with its documented context window and list
// price instead of an invented or floating id. It classifies the rows into the B3 difficulty tiers
// and refuses the approval-gated abliterated rows and the floating `*-latest` aliases for
// automatic selection.
//
// It is deliberately data-only: it creates no client, reads no environment variable, holds no
// credential and performs no network I/O.

import { MAX_MODEL_CHARS, MODEL_NAME } from './provider-presets.mjs';
import { DIFFICULTY_TIERS, TASK_CLASSES } from './provider-router.mjs';

export const MORPH_MODELS_VERSION = 1;

// The live source that every row, price and context window below was read from. The feed serves
// the same catalog the Fast Models documentation table shows; `?prices=list` is Morph's list price
// rather than the OpenRouter per-channel price.
export const MORPH_MODELS_SOURCE = Object.freeze({
  url: 'https://www.morphllm.com/api/models/json?prices=list',
  readAt: '2026-11-28',
});

// Every chat row recorded here advertises the same 1M-token context window.
const FAST_MODEL_CONTEXT_TOKENS = 1048576;

export class MorphModelsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MorphModelsError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MorphModelsError(code, message);
}

// Prices are held as integer nanodollars per million tokens, so the feed's fractional per-token
// costs (DeepSeek V4 Flash lists 0.000000141953125 USD) stay exact and no float arithmetic is
// needed anywhere a caller shows or compares them.
function row(id, label, inputNanoUsdPerMillionTokens, outputNanoUsdPerMillionTokens,
  cachedInputNanoUsdPerMillionTokens, gated = false) {
  return Object.freeze({
    id,
    label,
    contextTokens: FAST_MODEL_CONTEXT_TOKENS,
    inputNanoUsdPerMillionTokens,
    outputNanoUsdPerMillionTokens,
    cachedInputNanoUsdPerMillionTokens,
    gated,
  });
}

// The twelve chat rows of the feed in feed order, except that the two approval-gated rows are
// listed last so the ungated set reads as one block. Every label is the feed's own `name` without
// its `Morph: ` prefix. The apply models (`morph-v3-fast`, `morph-v3-large`), the decision model
// (`reflex`) and the floating `kimi-latest` / `deepseek-flash-latest` aliases are intentionally
// absent: none of them is a pinnable chat model.
export const MORPH_HOSTED_MODELS = Object.freeze([
  row('morph-glm53-744b', 'GLM-5.3', 1680000000, 5280000000, 312000000),
  row('morph-glm52-744b', 'GLM-5.2', 1680000000, 5280000000, 312000000),
  row('morph-glm53flash', 'GLM-5.3-Flash', 180000000, 600000000, 36000000),
  row('morph-dsv41flash', 'DeepSeek V4.1 Flash', 120000000, 800000000, 8000000),
  row('morph-dsv41flash-1017', 'DeepSeek V4.1 Flash 1017', 120000000, 800000000, 8000000),
  row('morph-dsv4flash', 'DeepSeek V4 Flash 0731', 141953125, 399625000, 35937500),
  row('morph-dsv4flash-0731', 'DeepSeek V4 Flash 0731', 141953125, 399625000, 35937500),
  row('morph-kimik3', 'Kimi K3', 2500000000, 14000000000, 290000000),
  row('morph-kimik31', 'Kimi K3.1 Pro', 2500000000, 14000000000, 290000000),
  row('morph-kimik3-fast', 'Kimi K3 Fast', 6000000000, 22500000000, 600000000),
  row('morph-dsv41flash-abliterated', 'DeepSeek V4.1 Flash Abliterated', 300000000, 1200000000, 30000000, true),
  row('morph-kimik3-abliterated', 'Kimi K3.1 Pro Abliterated', 5000000000, 28000000000, 580000000, true),
]);

// The B3 tier a task class maps to. `embed` has no tier on purpose: the feed lists no Morph-hosted
// embedding model, so the caller must name one explicitly.
const CLASS_TIER = Object.freeze({
  plan: 'powerful',
  'code-edit': 'powerful',
  'quick-edit': 'cheap',
  review: 'standard',
  summarize: 'cheap',
});

// One row per difficulty tier: the budget flash row, the mid-band flash row and the 744B GLM
// flagship. All three are ungated and pinned to an exact id, so a request never follows a `-latest`
// alias. `powerful` is the same row the build loop already uses for its `strong` and `review`
// classes (`vibe/goal/models.json`) and is materially cheaper than Kimi K3.1 Pro at the same 1M
// context, so the two stay consistent.
export const MORPH_TIER_MODELS = Object.freeze({
  cheap: 'morph-dsv41flash',
  standard: 'morph-glm53flash',
  powerful: 'morph-glm53-744b',
});

export const MORPH_DEFAULT_MODEL = MORPH_TIER_MODELS.cheap;

const ROWS_BY_ID = new Map(MORPH_HOSTED_MODELS.map((entry) => [entry.id, entry]));

const OPTION_KEYS = new Set(['embeddingModel', 'tierModels']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;

function assertBuiltins() {
  for (const entry of MORPH_HOSTED_MODELS) {
    if (typeof entry.id !== 'string' || !MODEL_NAME.test(entry.id) || entry.id.length === 0 ||
        entry.id.length > MAX_MODEL_CHARS) {
      fail('invalid-row', 'a built-in Morph model id is invalid');
    }
    if (typeof entry.label !== 'string' || entry.label.length === 0) {
      fail('invalid-row', 'a built-in Morph model label is invalid');
    }
    if (entry.contextTokens !== FAST_MODEL_CONTEXT_TOKENS) {
      fail('invalid-row', 'a built-in Morph model context is invalid');
    }
    for (const key of [
      'inputNanoUsdPerMillionTokens',
      'outputNanoUsdPerMillionTokens',
      'cachedInputNanoUsdPerMillionTokens',
    ]) {
      if (!Number.isSafeInteger(entry[key]) || entry[key] < 0) {
        fail('invalid-row', 'a built-in Morph model price is invalid');
      }
    }
  }
  for (const tier of DIFFICULTY_TIERS) {
    const entry = ROWS_BY_ID.get(MORPH_TIER_MODELS[tier]);
    if (entry === undefined || entry.gated) {
      fail('invalid-row', 'the tier map names a model that is not an ungated hosted row');
    }
  }
}

assertBuiltins();

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

// Reads only own data descriptors, so an accessor or an enumeration trap is never invoked.
function ownData(object, key) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    fail('invalid-options', 'options cannot be read');
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) fail('invalid-options', 'options must hold data properties');
  return descriptor.value;
}

function keysOf(value) {
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-options', 'options cannot be enumerated');
  }
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) fail('invalid-options', 'options has duplicate keys');
    seen.add(key);
  }
  return keys;
}

function validModelName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MODEL_CHARS &&
    !CONTROL_OR_BIDI.test(value) && MODEL_NAME.test(value);
}

function readOptions(value) {
  if (!isPlainObject(value)) fail('invalid-options', 'options must be a plain object');
  const keys = keysOf(value);
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) fail('invalid-options', 'options has a reserved key');
    if (!OPTION_KEYS.has(key)) fail('invalid-options', 'unknown option');
  }
  const embeddingModel = ownData(value, 'embeddingModel');
  if (embeddingModel === undefined) {
    fail('missing-embedding-model', 'no Morph Fast Model chat row is an embedding model, so one must be supplied');
  }
  if (!validModelName(embeddingModel)) {
    fail('invalid-embedding-model', 'the embedding model is not a valid model name');
  }
  const embeddingRow = ROWS_BY_ID.get(embeddingModel);
  if (embeddingRow !== undefined && embeddingRow.gated) {
    fail('gated-model-unavailable', 'the selected embedding model needs provider approval and is never selected automatically');
  }
  const tierModels = ownData(value, 'tierModels');
  if (tierModels !== undefined && !isPlainObject(tierModels)) {
    fail('invalid-options', 'tierModels must be a plain object');
  }
  const overrides = Object.create(null);
  if (tierModels !== undefined) {
    for (const tier of keysOf(tierModels)) {
      if (RESERVED_KEYS.has(tier)) fail('invalid-options', 'tierModels has a reserved key');
      if (!DIFFICULTY_TIERS.includes(tier)) {
        fail('invalid-tier-model', 'tierModels has an unknown difficulty tier');
      }
      const model = ownData(tierModels, tier);
      if (!validModelName(model)) {
        fail('invalid-tier-model', 'a tier model must be a Morph-hosted row id');
      }
      const entry = ROWS_BY_ID.get(model);
      if (entry === undefined || entry.gated) {
        fail('invalid-tier-model', 'a tier model must be an ungated Morph-hosted row id');
      }
      overrides[tier] = model;
    }
  }
  return { embeddingModel, overrides };
}

// Returns the frozen row for an ungated hosted chat model, or undefined for anything else: an
// unknown id, an approval-gated row, an apply model, the decision model or a floating alias.
export function morphHostedModel(id) {
  if (typeof id !== 'string') return undefined;
  const entry = ROWS_BY_ID.get(id);
  if (entry === undefined || entry.gated) return undefined;
  return entry;
}

// Builds the `morphModels` map `createMorphDirectPolicy` expects: every chat class gets its tier's
// hosted row, and `embed` gets the caller's explicit embedding model because Morph's Fast Models
// list has no embedding row. `tierModels` may re-point a tier at another ungated hosted row.
export function morphHostedModelMap(options) {
  const { embeddingModel, overrides } = readOptions(options);
  const map = {};
  for (const taskClass of TASK_CLASSES) {
    if (taskClass === 'embed') {
      map[taskClass] = embeddingModel;
      continue;
    }
    map[taskClass] = overrides[CLASS_TIER[taskClass]] ?? MORPH_TIER_MODELS[CLASS_TIER[taskClass]];
  }
  return Object.freeze(map);
}

const DESCRIPTION = Object.freeze({
  version: MORPH_MODELS_VERSION,
  source: MORPH_MODELS_SOURCE,
  tierModels: MORPH_TIER_MODELS,
  models: MORPH_HOSTED_MODELS,
});

export function describeMorphModels() {
  return DESCRIPTION;
}
