import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_MODES,
  CAPABILITIES,
  ENV_NAME,
  MAX_PRESETS,
  PROVIDER_ID,
  PROVIDER_PRESETS,
  ProviderPresetError,
  TRANSPORTS,
  getProviderPreset,
  listProviderPresets,
  validateProviderBaseUrl,
  validateProviderModel,
} from '../../src/stable/gateway/provider-presets.mjs';

const LOOPBACK = ['127', '0', '0', '1'].join('.');

const B1_IDS = [
  'omniroute', 'morph', 'kie', 'deepinfra', 'abliteration',
  'openrouter', 'requesty', 'openai-compatible', 'llama-cpp', 'ollama',
];

test('the catalog is frozen and covers every B1 provider', () => {
  assert.ok(Object.isFrozen(PROVIDER_PRESETS));
  assert.ok(PROVIDER_PRESETS.length <= MAX_PRESETS);
  assert.deepEqual(PROVIDER_PRESETS.map((preset) => preset.id), B1_IDS);
  const ids = new Set();
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(Object.isFrozen(preset));
    assert.ok(Object.isFrozen(preset.capabilities));
    assert.match(preset.id, PROVIDER_ID);
    assert.ok(!ids.has(preset.id), 'duplicate preset id');
    ids.add(preset.id);
    assert.ok(preset.label.length > 0);
    assert.ok(TRANSPORTS.includes(preset.transport));
    assert.ok(AUTH_MODES.includes(preset.auth));
    assert.ok(preset.capabilities.includes('chat'));
    for (const capability of preset.capabilities) assert.ok(CAPABILITIES.includes(capability));
    if (preset.baseUrl !== undefined) validateProviderBaseUrl(preset.baseUrl);
    else assert.match(preset.baseUrlEnv, ENV_NAME);
    if (preset.apiKeyEnv !== undefined) assert.match(preset.apiKeyEnv, ENV_NAME);
    if (preset.defaultModel !== undefined) validateProviderModel(preset.defaultModel);
  }
});

test('the provider details match the verified contracts', () => {
  const byId = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
  assert.equal(byId.get('kie').transport, 'openai-responses');
  assert.equal(byId.get('kie').baseUrl, 'https://api.kie.ai/codex/v1');
  assert.equal(byId.get('kie').defaultModel, 'gpt-6-1-sol');
  assert.deepEqual(byId.get('kie').capabilities, ['chat', 'stream', 'tools']);
  // Morph retired its embedding and rerank models: https://api.morphllm.com/v1/embeddings answers
  // 404 model_not_found for morph-embedding-v4 and morph-rerank-v4 (verified live 2026-11-28).
  assert.deepEqual(byId.get('morph').capabilities, ['chat', 'stream', 'tools']);
  assert.equal(byId.get('abliteration').baseUrl, 'https://api.abliteration.ai/v1');
  assert.equal(byId.get('abliteration').defaultModel, 'abliterated-model-large-v2');
  assert.equal(byId.get('openrouter').baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(byId.get('deepinfra').baseUrl, 'https://api.deepinfra.com/v1/openai');
  assert.equal(byId.get('requesty').baseUrl, 'https://router.requesty.ai/v1');
  assert.equal(byId.get('llama-cpp').auth, 'bearer');
  assert.equal(byId.get('llama-cpp').apiKeyRequired, false);
  assert.equal(byId.get('llama-cpp').local, true);
  assert.equal(byId.get('ollama').auth, 'none');
  assert.equal(byId.get('ollama').local, true);
  assert.equal(byId.get('omniroute').baseUrlEnv, 'OMNIROUTE_BASE_URL');
  assert.equal(byId.get('omniroute').apiKeyRequired, false);
});

test('a provider can be added and a built-in overridden from settings JSON alone', () => {
  const settings = JSON.parse(JSON.stringify({
    providers: {
      'my-lab': {
        label: 'My Lab',
        transport: 'openai-chat',
        baseUrl: 'http://' + LOOPBACK + ':9999/v1',
        model: 'lab-model',
        auth: 'none',
        capabilities: ['chat', 'stream', 'tools'],
      },
      openrouter: {
        baseUrl: 'http://' + LOOPBACK + ':9998/v1',
        model: 'override-model',
        apiKeyEnv: 'OPENROUTER_TEST_KEY',
        capabilities: ['chat', 'stream', 'tools', 'embeddings'],
      },
    },
  }));
  const presets = listProviderPresets(settings);
  assert.ok(Object.isFrozen(presets));
  const custom = getProviderPreset('my-lab', settings);
  assert.equal(custom.label, 'My Lab');
  assert.equal(custom.baseUrl, 'http://' + LOOPBACK + ':9999/v1');
  assert.equal(custom.model, undefined);
  assert.equal(custom.local, false);
  const overridden = getProviderPreset('openrouter', settings);
  assert.equal(overridden.baseUrl, 'http://' + LOOPBACK + ':9998/v1');
  assert.equal(overridden.apiKeyEnv, 'OPENROUTER_TEST_KEY');
  assert.equal(getProviderPreset('openrouter').baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(listProviderPresets().length, B1_IDS.length);
  assert.equal(presets.length, B1_IDS.length + 1);
});

test('null-prototype settings are accepted and read once', () => {
  const settings = Object.create(null);
  settings.providers = Object.create(null);
  settings.providers.localone = {
    label: 'Local One',
    transport: 'openai-chat',
    baseUrl: 'http://' + LOOPBACK + ':1234/v1',
    model: 'm',
    auth: 'none',
    capabilities: ['chat'],
  };
  const preset = getProviderPreset('localone', settings);
  assert.equal(preset.baseUrl, 'http://' + LOOPBACK + ':1234/v1');
});

test('settings validation fails closed', () => {
  const base = {
    label: 'X',
    transport: 'openai-chat',
    baseUrl: 'http://' + LOOPBACK + ':1234/v1',
    model: 'm',
    auth: 'none',
    capabilities: ['chat'],
  };
  const cases = [
    { providers: [] },
    { providers: { Bad: base } },
    { providers: { 'bad id': base } },
    { providers: { x: { ...base, unknown: true } } },
    { providers: { x: { ...base, transport: 'grpc' } } },
    { providers: { x: { ...base, auth: 'basic' } } },
    { providers: { x: { ...base, capabilities: [] } } },
    { providers: { x: { ...base, capabilities: ['tools'] } } },
    { providers: { x: { ...base, capabilities: ['chat', 'chat'] } } },
    { providers: { x: { ...base, capabilities: ['chat', 'vision'] } } },
    { providers: { x: { ...base, baseUrl: 'ftp://example.com/v1' } } },
    { providers: { x: { ...base, baseUrl: 'https://user:pass@example.com/v1' } } },
    { providers: { x: { ...base, baseUrl: 'https://example.com/v1?x=1' } } },
    { providers: { x: { ...base, baseUrl: 'https://example.com\\v1' } } },
    { providers: { x: { ...base, baseUrl: undefined } } },
    { providers: { x: { ...base, model: 'bad\nmodel' } } },
    { providers: { x: { ...base, model: 'a'.repeat(201) } } },
    { providers: { x: { ...base, label: '' } } },
    { providers: { x: { ...base, label: 'bad\nlabel' } } },
    { providers: { x: { ...base, apiKeyEnv: 'bad-name' } } },
    { providers: { x: { ...base, auth: 'bearer', apiKeyRequired: true } } },
    { providers: { x: { ...base, label: undefined } } },
  ];
  for (const settings of cases) {
    assert.throws(() => listProviderPresets(settings), ProviderPresetError);
  }
  const polluted = JSON.parse('{"providers":{"__proto__":{"label":"x"}}}');
  assert.throws(() => listProviderPresets(polluted), ProviderPresetError);
  const accessor = {};
  Object.defineProperty(accessor, 'providers', { enumerable: true, get: () => ({}) });
  assert.throws(() => listProviderPresets(accessor), ProviderPresetError);
  assert.throws(() => getProviderPreset('missing'), ProviderPresetError);
  assert.throws(() => getProviderPreset('../x'), ProviderPresetError);
});

test('base URL and model validators reject unsafe values', () => {
  for (const url of [
    '', 'ftp://x/v1', 'https://u:p@x/v1', 'https://x/v1?q=1', 'https://x/v1#f',
    'https://x/%2e%2e/v1', 'https://x/v1\\n', 'javascript:alert(1)',
  ]) {
    assert.throws(() => validateProviderBaseUrl(url), ProviderPresetError);
  }
  assert.equal(validateProviderBaseUrl('https://example.com/v1/'), 'https://example.com/v1');
  assert.equal(validateProviderBaseUrl('http://' + LOOPBACK + ':11434/v1'), 'http://' + LOOPBACK + ':11434/v1');
  for (const model of ['', 'a b', 'bad\nmodel', 'a'.repeat(201), 'x;y']) {
    assert.throws(() => validateProviderModel(model), ProviderPresetError);
  }
  assert.equal(validateProviderModel('gpt-6-1-sol'), 'gpt-6-1-sol');
  assert.equal(validateProviderModel('vendor/model:v2'), 'vendor/model:v2');
});
