import assert from 'node:assert/strict';
import test from 'node:test';

import { createMorphDirectPolicy } from '../../src/stable/gateway/morph-direct.mjs';
import {
  MORPH_DEFAULT_MODEL,
  MORPH_HOSTED_MODELS,
  MORPH_MODELS_SOURCE,
  MORPH_MODELS_VERSION,
  MORPH_TIER_MODELS,
  MorphModelsError,
  describeMorphModels,
  morphHostedModel,
  morphHostedModelMap,
} from '../../src/stable/gateway/morph-models.mjs';
import { PROVIDER_PRESETS, validateProviderModel } from '../../src/stable/gateway/provider-presets.mjs';
import { DIFFICULTY_TIERS, TASK_CLASSES } from '../../src/stable/gateway/provider-router.mjs';

const ROW_KEYS = [
  'id', 'label', 'contextTokens',
  'inputNanoUsdPerMillionTokens', 'outputNanoUsdPerMillionTokens',
  'cachedInputNanoUsdPerMillionTokens', 'gated',
];

const CHAT_IDS = [
  'morph-glm53-744b', 'morph-glm52-744b', 'morph-glm53flash',
  'morph-dsv41flash', 'morph-dsv41flash-1017', 'morph-dsv4flash', 'morph-dsv4flash-0731',
  'morph-kimik3', 'morph-kimik31', 'morph-kimik3-fast',
  'morph-dsv41flash-abliterated', 'morph-kimik3-abliterated',
];

function rowById(id) {
  const row = MORPH_HOSTED_MODELS.find((entry) => entry.id === id);
  assert.ok(row !== undefined, 'missing row ' + id);
  return row;
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MorphModelsError, 'expected a MorphModelsError, got ' + error);
    return error.code;
  }
  assert.fail('expected a MorphModelsError');
}

function optionsWithAccessor() {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'embeddingModel', {
    enumerable: true,
    get() {
      reads += 1;
      return 'embed-model';
    },
  });
  return { options, reads: () => reads };
}

test('the hosted model rows are frozen, complete and shaped as documented', () => {
  assert.equal(MORPH_MODELS_VERSION, 1);
  assert.ok(Object.isFrozen(MORPH_MODELS_SOURCE));
  assert.deepEqual({ ...MORPH_MODELS_SOURCE }, {
    url: 'https://www.morphllm.com/api/models/json?prices=list',
    readAt: '2026-11-28',
  });
  assert.ok(Object.isFrozen(MORPH_HOSTED_MODELS));
  assert.deepEqual(MORPH_HOSTED_MODELS.map((row) => row.id), CHAT_IDS);
  const ids = new Set();
  for (const row of MORPH_HOSTED_MODELS) {
    assert.ok(Object.isFrozen(row));
    assert.deepEqual(Object.keys(row).sort(), [...ROW_KEYS].sort());
    assert.equal(typeof row.label, 'string');
    assert.ok(row.label.length > 0);
    assert.equal(row.contextTokens, 1048576);
    for (const key of [
      'inputNanoUsdPerMillionTokens',
      'outputNanoUsdPerMillionTokens',
      'cachedInputNanoUsdPerMillionTokens',
    ]) {
      assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0, key + ' is not a non-negative safe integer');
    }
    assert.equal(typeof row.gated, 'boolean');
    assert.ok(!ids.has(row.id), 'duplicate row id');
    ids.add(row.id);
    validateProviderModel(row.id);
  }
});

test('only the two approval-gated abliterated rows are marked gated', () => {
  assert.deepEqual(
    MORPH_HOSTED_MODELS.filter((row) => row.gated).map((row) => row.id),
    ['morph-dsv41flash-abliterated', 'morph-kimik3-abliterated'],
  );
});

test('the rows carry the labels and prices from the live model feed', () => {
  assert.equal(rowById('morph-glm53-744b').label, 'GLM-5.3');
  assert.equal(rowById('morph-glm52-744b').label, 'GLM-5.2');
  assert.equal(rowById('morph-dsv41flash-abliterated').label, 'DeepSeek V4.1 Flash Abliterated');
  assert.deepEqual(
    {
      input: rowById('morph-kimik31').inputNanoUsdPerMillionTokens,
      output: rowById('morph-kimik31').outputNanoUsdPerMillionTokens,
      cached: rowById('morph-kimik31').cachedInputNanoUsdPerMillionTokens,
    },
    { input: 2500000000, output: 14000000000, cached: 290000000 },
  );
  assert.deepEqual(
    {
      input: rowById('morph-dsv41flash').inputNanoUsdPerMillionTokens,
      output: rowById('morph-dsv41flash').outputNanoUsdPerMillionTokens,
      cached: rowById('morph-dsv41flash').cachedInputNanoUsdPerMillionTokens,
    },
    { input: 120000000, output: 800000000, cached: 8000000 },
  );
  assert.deepEqual(
    {
      input: rowById('morph-dsv4flash').inputNanoUsdPerMillionTokens,
      output: rowById('morph-dsv4flash').outputNanoUsdPerMillionTokens,
      cached: rowById('morph-dsv4flash').cachedInputNanoUsdPerMillionTokens,
    },
    { input: 141953125, output: 399625000, cached: 35937500 },
  );
  assert.equal(rowById('morph-glm53-744b').outputNanoUsdPerMillionTokens, 5280000000);
  assert.equal(rowById('morph-glm53flash').inputNanoUsdPerMillionTokens, 180000000);
  assert.equal(rowById('morph-kimik3-fast').outputNanoUsdPerMillionTokens, 22500000000);
  assert.equal(rowById('morph-dsv41flash-abliterated').cachedInputNanoUsdPerMillionTokens, 30000000);
  assert.equal(rowById('morph-kimik3-abliterated').outputNanoUsdPerMillionTokens, 28000000000);
});

// The whole table as read from the feed on 2026-11-28. The spot checks above show the shape; this
// table pins every label and every price, so a single-digit typo in any row cannot pass.
const FEED_ROWS = [
  ['morph-glm53-744b', 'GLM-5.3', 1680000000, 5280000000, 312000000],
  ['morph-glm52-744b', 'GLM-5.2', 1680000000, 5280000000, 312000000],
  ['morph-glm53flash', 'GLM-5.3-Flash', 180000000, 600000000, 36000000],
  ['morph-dsv41flash', 'DeepSeek V4.1 Flash', 120000000, 800000000, 8000000],
  ['morph-dsv41flash-1017', 'DeepSeek V4.1 Flash 1017', 120000000, 800000000, 8000000],
  ['morph-dsv4flash', 'DeepSeek V4 Flash 0731', 141953125, 399625000, 35937500],
  ['morph-dsv4flash-0731', 'DeepSeek V4 Flash 0731', 141953125, 399625000, 35937500],
  ['morph-kimik3', 'Kimi K3', 2500000000, 14000000000, 290000000],
  ['morph-kimik31', 'Kimi K3.1 Pro', 2500000000, 14000000000, 290000000],
  ['morph-kimik3-fast', 'Kimi K3 Fast', 6000000000, 22500000000, 600000000],
  ['morph-dsv41flash-abliterated', 'DeepSeek V4.1 Flash Abliterated', 300000000, 1200000000, 30000000],
  ['morph-kimik3-abliterated', 'Kimi K3.1 Pro Abliterated', 5000000000, 28000000000, 580000000],
];

test('every row label and price matches the live feed exactly, in order', () => {
  assert.deepEqual(
    MORPH_HOSTED_MODELS.map((row) => [
      row.id,
      row.label,
      row.inputNanoUsdPerMillionTokens,
      row.outputNanoUsdPerMillionTokens,
      row.cachedInputNanoUsdPerMillionTokens,
    ]),
    FEED_ROWS,
  );
});

test('apply models, the decision model and the floating aliases are not chat rows', () => {
  for (const id of ['morph-v3-fast', 'morph-v3-large', 'reflex', 'kimi-latest', 'deepseek-flash-latest']) {
    assert.equal(morphHostedModel(id), undefined, id + ' must not be selectable');
    assert.ok(!MORPH_HOSTED_MODELS.some((row) => row.id === id));
  }
});

test('the tier map names an ungated row for every difficulty tier', () => {
  assert.ok(Object.isFrozen(MORPH_TIER_MODELS));
  assert.deepEqual(Object.keys(MORPH_TIER_MODELS).sort(), [...DIFFICULTY_TIERS].sort());
  assert.deepEqual({ ...MORPH_TIER_MODELS }, {
    cheap: 'morph-dsv41flash',
    standard: 'morph-glm53flash',
    powerful: 'morph-glm53-744b',
  });
  for (const tier of DIFFICULTY_TIERS) {
    const row = rowById(MORPH_TIER_MODELS[tier]);
    assert.equal(row.gated, false);
    validateProviderModel(MORPH_TIER_MODELS[tier]);
  }
  assert.equal(MORPH_DEFAULT_MODEL, MORPH_TIER_MODELS.cheap);
});

test('the morph preset carries the documented default model', () => {
  const morph = PROVIDER_PRESETS.find((preset) => preset.id === 'morph');
  assert.ok(morph !== undefined);
  assert.equal(morph.defaultModel, MORPH_DEFAULT_MODEL);
  validateProviderModel(morph.defaultModel);
});

test('morphHostedModel returns only ungated chat rows', () => {
  const row = morphHostedModel('morph-glm53-744b');
  assert.equal(row, rowById('morph-glm53-744b'));
  assert.ok(Object.isFrozen(row));
  assert.equal(morphHostedModel('morph-dsv41flash-abliterated'), undefined);
  assert.equal(morphHostedModel('morph-kimik3-abliterated'), undefined);
  assert.equal(morphHostedModel('not-a-model'), undefined);
  assert.equal(morphHostedModel(''), undefined);
  assert.equal(morphHostedModel(undefined), undefined);
  assert.equal(morphHostedModel(7), undefined);
});

test('the model map fills all six task classes for the direct policy', () => {
  const map = morphHostedModelMap({ embeddingModel: 'bge-m3' });
  assert.ok(Object.isFrozen(map));
  assert.deepEqual(Object.keys(map), [...TASK_CLASSES]);
  assert.deepEqual({ ...map }, {
    plan: 'morph-glm53-744b',
    'code-edit': 'morph-glm53-744b',
    'quick-edit': 'morph-dsv41flash',
    review: 'morph-glm53flash',
    summarize: 'morph-dsv41flash',
    embed: 'bge-m3',
  });

  const policy = createMorphDirectPolicy({
    omnirouteModels: {
      plan: 'omni-plan', 'code-edit': 'omni-coder', 'quick-edit': 'omni-quick',
      review: 'omni-review', summarize: 'omni-summary', embed: 'omni-embed',
    },
    morphModels: map,
    outputCaps: {
      plan: 4096, 'code-edit': 4096, 'quick-edit': 512,
      review: 2048, summarize: 1024, embed: 0,
    },
  });
  assert.equal(policy.plan[1].model, 'morph-glm53-744b');
  assert.equal(policy.review[1].model, 'morph-glm53flash');
  assert.equal(policy.summarize[1].model, 'morph-dsv41flash');
  assert.equal(policy.embed[1].model, 'bge-m3');
});

test('a tier override must name another ungated hosted row', () => {
  const map = morphHostedModelMap({
    embeddingModel: 'bge-m3',
    tierModels: { powerful: 'morph-kimik31', cheap: 'morph-dsv4flash' },
  });
  assert.equal(map.plan, 'morph-kimik31');
  assert.equal(map['code-edit'], 'morph-kimik31');
  assert.equal(map.summarize, 'morph-dsv4flash');
  assert.equal(map.review, 'morph-glm53flash');

  for (const bad of [
    'morph-dsv41flash-abliterated',
    'morph-kimik3-abliterated',
    'kimi-latest',
    'morph-v3-fast',
    'reflex',
    'not-a-model',
    '',
    'morph dsv41flash',
  ]) {
    assert.equal(
      codeOf(() => morphHostedModelMap({ embeddingModel: 'bge-m3', tierModels: { cheap: bad } })),
      'invalid-tier-model',
      'tier override accepted ' + bad,
    );
  }
  assert.equal(
    codeOf(() => morphHostedModelMap({ embeddingModel: 'bge-m3', tierModels: { enormous: 'morph-kimik31' } })),
    'invalid-tier-model',
  );
  assert.equal(
    codeOf(() => morphHostedModelMap({ embeddingModel: 'bge-m3', tierModels: { cheap: 7 } })),
    'invalid-tier-model',
  );
});

test('the embedding model is required and is never a gated row', () => {
  assert.equal(codeOf(() => morphHostedModelMap({})), 'missing-embedding-model');
  assert.equal(codeOf(() => morphHostedModelMap()), 'invalid-options');
  assert.equal(codeOf(() => morphHostedModelMap({ embeddingModel: undefined })), 'missing-embedding-model');
  assert.equal(
    codeOf(() => morphHostedModelMap({ embeddingModel: 'morph-dsv41flash-abliterated' })),
    'gated-model-unavailable',
  );
  for (const bad of ['', '   ', 'bge m3', 'x'.repeat(201), 7, null, 'bge\u0000m3', '\u202ebge']) {
    assert.equal(
      codeOf(() => morphHostedModelMap({ embeddingModel: bad })),
      'invalid-embedding-model',
      'embedding model accepted ' + String(bad),
    );
  }
});

test('options are read as plain own data properties only', () => {
  const accessor = optionsWithAccessor();
  assert.equal(codeOf(() => morphHostedModelMap(accessor.options)), 'invalid-options');
  assert.equal(accessor.reads(), 0, 'an accessor was invoked');

  const trap = new Proxy({}, {
    ownKeys() {
      throw new Error('do not enumerate');
    },
  });
  assert.equal(codeOf(() => morphHostedModelMap(trap)), 'invalid-options');

  assert.equal(codeOf(() => morphHostedModelMap({ embeddingModel: 'bge-m3', extra: true })), 'invalid-options');
  assert.equal(
    codeOf(() => morphHostedModelMap({ embeddingModel: 'bge-m3', ['__proto__']: 'x' })),
    'invalid-options',
  );
  assert.equal(codeOf(() => morphHostedModelMap([])), 'invalid-options');
  assert.equal(codeOf(() => morphHostedModelMap('bge-m3')), 'invalid-options');

  let tierReads = 0;
  const tierModels = {};
  Object.defineProperty(tierModels, 'cheap', {
    enumerable: true,
    get() {
      tierReads += 1;
      return 'morph-dsv41flash';
    },
  });
  assert.equal(codeOf(() => morphHostedModelMap({ embeddingModel: 'bge-m3', tierModels })), 'invalid-options');
  assert.equal(tierReads, 0, 'a tier accessor was invoked');
});

test('no error message echoes a supplied model id', () => {
  const secretish = 'morph-secret-probe-xyz';
  try {
    morphHostedModelMap({ embeddingModel: 'bge-m3', tierModels: { cheap: secretish } });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.ok(error instanceof MorphModelsError);
    assert.equal(error.code, 'invalid-tier-model');
    assert.ok(!error.message.includes(secretish));
    assert.ok(!String(error.stack).includes(secretish));
  }
  try {
    morphHostedModelMap({ embeddingModel: 'morph-dsv41flash-abliterated' });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.equal(error.code, 'gated-model-unavailable');
    assert.ok(!error.message.includes('abliterated'));
  }
});

test('describe reports the rows and the source without leaking a secret', () => {
  const described = describeMorphModels();
  assert.ok(Object.isFrozen(described));
  assert.ok(Object.isFrozen(described.models));
  assert.equal(described.version, MORPH_MODELS_VERSION);
  assert.deepEqual({ ...described.source }, { ...MORPH_MODELS_SOURCE });
  assert.deepEqual({ ...described.tierModels }, { ...MORPH_TIER_MODELS });
  assert.deepEqual(described.models.map((row) => row.id), CHAT_IDS);
  assert.deepEqual(Object.keys(described).sort(), ['models', 'source', 'tierModels', 'version']);
  const json = JSON.stringify(described);
  assert.ok(!/apiKey|authorization|bearer/i.test(json));
  assert.ok(!json.includes('api.morphllm.com'), 'the describe result must not carry the client endpoint');
  assert.ok(!json.includes('client'));
  assert.equal(JSON.parse(json).models.length, CHAT_IDS.length);
});

test('the frozen rows cannot be mutated', () => {
  assert.throws(() => {
    MORPH_HOSTED_MODELS[0].gated = true;
  }, TypeError);
  assert.throws(() => {
    MORPH_HOSTED_MODELS.push('extra');
  }, TypeError);
  assert.throws(() => {
    MORPH_TIER_MODELS.cheap = 'morph-kimik31';
  }, TypeError);
  assert.throws(() => {
    describeMorphModels().version = 2;
  }, TypeError);
});
