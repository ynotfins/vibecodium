import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createProviderClient } from '../../src/stable/gateway/provider-client.mjs';
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  listProviderPresets,
} from '../../src/stable/gateway/provider-presets.mjs';

const require = createRequire(import.meta.url);
const {
  MAX_ENV_NAMES,
  MAX_PROVIDERS,
  ProviderSetupError,
  createProviderSetupController,
  createProviderSetupModel,
  secretKeyForProvider,
} = require('../../src/stable/extensions/vibecodium-ai/src/provider-setup.cjs');

const FAKE_SECRET = 'test-only-credential-value-not-a-real-key';
const ENVIRONMENT_NAMES = ['PATH', 'MORPH_API_KEY', 'OPENROUTER_API_KEY'];

function memorySecretStorage() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
}

function createModelWithPresets(presets) {
  const secretStorage = memorySecretStorage();
  const model = createProviderSetupModel({
    secretStorage,
    environmentNames: ENVIRONMENT_NAMES,
    presets,
  });
  return { model, secretStorage };
}

function createModel() {
  return createModelWithPresets(listProviderPresets());
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ProviderSetupError, 'the error is a ProviderSetupError');
    assert.equal(error.code, code);
    return true;
  });
}

test('lists the B1 catalog and environment-variable names only', async () => {
  const { model } = createModel();
  const view = await model.view();
  assert.equal(view.version, 1);
  assert.equal(view.presets.length, PROVIDER_PRESETS.length);
  assert.deepEqual(view.environmentNames, ['MORPH_API_KEY', 'OPENROUTER_API_KEY', 'PATH']);
  assert.equal(view.activeProvider, null);
  assert.deepEqual(view.providers, []);
  assert.ok(!JSON.stringify(view).includes(FAKE_SECRET));
});

test('adds a provider, switches it, and round-trips through the B1 settings validator', async () => {
  const { model } = createModel();
  await model.addProvider({ id: 'morph', model: 'test-model-a', apiKeyEnv: 'MORPH_API_KEY' });
  const first = await model.view();
  assert.equal(first.activeProvider, 'morph');
  assert.deepEqual(first.providers.map((entry) => entry.id), ['morph']);
  assert.equal(first.providers[0].label, getProviderPreset('morph').label);
  assert.equal(first.providers[0].credentialSource, 'environment');
  assert.equal(first.providers[0].hasSecret, false);
  assert.equal(first.providers[0].model, 'test-model-a');

  await model.addProvider({ id: 'openrouter', model: 'test-model-b', apiKeyEnv: 'OPENROUTER_API_KEY' });
  assert.equal((await model.view()).activeProvider, 'morph');
  await model.selectProvider('openrouter');
  assert.equal((await model.view()).activeProvider, 'openrouter');

  const settings = model.toProviderSettings();
  assert.equal(listProviderPresets(settings).length, PROVIDER_PRESETS.length);
  assert.equal(getProviderPreset('morph', settings).defaultModel, 'test-model-a');
  assert.deepEqual(model.document().providers[0], {
    id: 'morph',
    label: getProviderPreset('morph').label,
    model: 'test-model-a',
    apiKeyEnv: 'MORPH_API_KEY',
    transport: getProviderPreset('morph').transport,
    auth: getProviderPreset('morph').auth,
    baseUrl: getProviderPreset('morph').baseUrl,
  });
});

test('keeps the credential in secret storage and creates a B1 client with it', async () => {
  const { model, secretStorage } = createModel();
  await model.addProvider({ id: 'morph', model: 'test-model-a' });
  await model.setSecret('morph', FAKE_SECRET);
  assert.equal(secretStorage.values.get(secretKeyForProvider('morph')), FAKE_SECRET);

  const view = await model.view();
  assert.equal(view.providers[0].hasSecret, true);
  assert.equal(view.providers[0].credentialSource, 'secret-storage');
  assert.ok(!JSON.stringify(view).includes(FAKE_SECRET));
  assert.ok(!JSON.stringify(model.document()).includes(FAKE_SECRET));
  assert.ok(!JSON.stringify(model.toProviderSettings()).includes(FAKE_SECRET));
  assert.equal(await model.resolveApiKey('morph'), FAKE_SECRET);

  const settings = model.toProviderSettings();
  let authorization;
  const fetchImpl = async (url, init) => {
    authorization = init.headers.authorization;
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const host = new URL(getProviderPreset('morph').baseUrl).hostname;
  const client = createProviderClient('morph', {
    settings,
    apiKey: await model.resolveApiKey('morph'),
    fetch: fetchImpl,
    policy: { allowHosts: [host] },
  });
  assert.ok(!JSON.stringify(client.describe()).includes(FAKE_SECRET));
  const answer = await client.chat({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(answer.text, 'ok');
  assert.equal(authorization, 'Bearer ' + FAKE_SECRET);
});

test('removing a provider clears its secret and the active selection', async () => {
  const { model, secretStorage } = createModel();
  await model.addProvider({ id: 'morph', model: 'test-model-a' });
  await model.setSecret('morph', FAKE_SECRET);
  await model.removeProvider('morph');
  assert.equal(secretStorage.values.size, 0);
  const view = await model.view();
  assert.deepEqual(view.providers, []);
  assert.equal(view.activeProvider, null);
  await rejectsCode(model.resolveApiKey('morph'), 'unknown-provider');
});

test('malformed input fails closed without invoking accessors', async () => {
  const { model, secretStorage } = createModel();
  await rejectsCode(model.addProvider({ id: 'missing-provider', model: 'x' }), 'unknown-provider');
  await rejectsCode(model.addProvider({ id: 'morph', model: 'bad model' }), 'invalid-provider');
  await rejectsCode(model.addProvider({ id: 'morph', model: 'test-model-a', apiKeyEnv: 'lower_case' }), 'invalid-environment-name');
  await rejectsCode(model.selectProvider('morph'), 'unknown-provider');
  await model.addProvider({ id: 'morph', model: 'test-model-a' });
  await rejectsCode(model.setSecret('morph', ''), 'invalid-secret');
  await rejectsCode(model.setSecret('morph', 'x'.repeat(4097)), 'invalid-secret');
  await rejectsCode(model.setSecret('openrouter', FAKE_SECRET), 'unknown-provider');
  assert.equal(secretStorage.values.size, 0);

  let getterCalled = 0;
  const document = {};
  Object.defineProperty(document, 'providers', { enumerable: true, get() { getterCalled += 1; return []; } });
  await rejectsCode(model.load(document), 'invalid-document');
  assert.equal(getterCalled, 0);

  await rejectsCode(model.load({
    version: 1,
    activeProvider: 'morph',
    providers: [
      { id: 'morph', model: 'test-model-a' },
      { id: 'morph', model: 'test-model-b' },
    ],
  }), 'invalid-document');

  const tooMany = { version: 1, activeProvider: null, providers: [] };
  for (let index = 0; index <= MAX_PROVIDERS; index += 1) {
    tooMany.providers.push({ id: 'morph', model: 'test-model-' + index });
  }
  await rejectsCode(model.load(tooMany), 'invalid-document');

  await rejectsCode(model.setCatalog(listProviderPresets().slice(0, 0)), 'invalid-catalog');
  const basePreset = listProviderPresets()[0];
  const tooManyPresets = Array.from({ length: 65 }, (_, index) => ({
    ...basePreset,
    id: 'p' + index,
    label: 'Preset ' + index,
  }));
  await rejectsCode(model.setCatalog(tooManyPresets), 'invalid-catalog');

  let presetGetterCalled = 0;
  const accessorPreset = { ...basePreset };
  Object.defineProperty(accessorPreset, 'label', {
    enumerable: true,
    get() { presetGetterCalled += 1; return 'must-not-run'; },
  });
  await rejectsCode(model.setCatalog([accessorPreset]), 'invalid-catalog');
  assert.equal(presetGetterCalled, 0);

  const tooManyEnvironmentNames = Array.from({ length: MAX_ENV_NAMES + 1 }, (_, index) => 'E' + index);
  await rejectsCode(Promise.resolve().then(() => createProviderSetupModel({
    secretStorage: secretStorage,
    environmentNames: tooManyEnvironmentNames,
    presets: listProviderPresets(),
  })), 'invalid-environment');
});

test('a secret-store failure is reported without the stored value', async () => {
  const model = createProviderSetupModel({
    environmentNames: ENVIRONMENT_NAMES,
    presets: listProviderPresets(),
    secretStorage: {
      async get() { throw new Error('store unavailable ' + FAKE_SECRET); },
      async store() {},
      async delete() {},
    },
  });
  await model.addProvider({ id: 'morph', model: 'test-model-a' });
  const error = await model.view().catch((reason) => reason);
  assert.ok(error instanceof ProviderSetupError);
  assert.equal(error.code, 'secret-store-unavailable');
  assert.ok(!String(error.message).includes(FAKE_SECRET));
});

test('accepts a prototype-backed secret store and rejects accessor-backed ones', async () => {
  class SecretStorage {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.get(key); }
    async store(key, value) { this.values.set(key, value); }
    async delete(key) { this.values.delete(key); }
  }
  const storage = new SecretStorage();
  const model = createProviderSetupModel({
    secretStorage: storage,
    environmentNames: ENVIRONMENT_NAMES,
    presets: listProviderPresets(),
  });
  await model.addProvider({ id: 'morph', model: 'test-model-a' });
  await model.setSecret('morph', FAKE_SECRET);
  assert.equal(storage.values.get(secretKeyForProvider('morph')), FAKE_SECRET);
  assert.equal((await model.view()).providers[0].credentialSource, 'secret-storage');

  let getterCalled = 0;
  const accessorStore = {
    async store() {},
    async delete() {},
  };
  Object.defineProperty(accessorStore, 'get', {
    enumerable: true,
    get() { getterCalled += 1; return async () => undefined; },
  });
  await rejectsCode(Promise.resolve().then(() => createProviderSetupModel({
    secretStorage: accessorStore,
    environmentNames: ENVIRONMENT_NAMES,
    presets: listProviderPresets(),
  })), 'invalid-options');
  assert.equal(getterCalled, 0);
});

test('rejects a catalog that drops a configured provider and keeps the old catalog', async () => {
  const { model } = createModel();
  await model.addProvider({ id: 'morph', model: 'test-model-a' });
  await rejectsCode(model.setCatalog(listProviderPresets().filter((preset) => preset.id !== 'morph')), 'invalid-catalog');
  assert.equal((await model.view()).providers[0].id, 'morph');
  assert.equal(model.describe().presets, PROVIDER_PRESETS.length);
});

test('rejects a catalog that changes a configured provider endpoint or auth mode', async () => {
  const { model } = createModel();
  await model.addProvider({ id: 'morph', model: 'test-model-a' });
  await model.addProvider({ id: 'omniroute', model: 'test-model-b' });
  const presetCount = model.describe().presets;
  const replace = (predicate, patch) => listProviderPresets().map((preset) =>
    predicate(preset) ? { ...preset, ...patch } : preset);

  const originalMorph = getProviderPreset('morph');
  const originalOmni = getProviderPreset('omniroute');
  await rejectsCode(model.setCatalog(replace((preset) => preset.id === 'morph', {
    transport: 'openai-responses',
  })), 'invalid-catalog');
  await rejectsCode(model.setCatalog(replace((preset) => preset.id === 'morph', {
    auth: originalMorph.auth === 'bearer' ? 'none' : 'bearer',
  })), 'invalid-catalog');
  await rejectsCode(model.setCatalog(replace((preset) => preset.id === 'morph', {
    baseUrl: 'https://example.invalid/v1',
  })), 'invalid-catalog');
  await rejectsCode(model.setCatalog(replace((preset) => preset.id === 'omniroute', {
    baseUrlEnv: 'OTHER_BASE_URL',
  })), 'invalid-catalog');
  assert.equal(model.describe().presets, presetCount);
  assert.equal((await model.view()).providers.length, 2);

  await model.setCatalog(listProviderPresets());
  assert.equal(model.describe().presets, presetCount);
  const view = await model.view();
  assert.deepEqual(view.providers.map((entry) => entry.id).sort(), ['morph', 'omniroute']);
  const settings = model.toProviderSettings();
  assert.equal(getProviderPreset('morph', settings).baseUrl, originalMorph.baseUrl);
  assert.equal(getProviderPreset('omniroute', settings).baseUrlEnv, originalOmni.baseUrlEnv);
});

test('rejects a saved provider when the catalog retargets its endpoint or auth', async () => {
  const { model } = createModel();
  await model.addProvider({ id: 'morph', model: 'test-model-a' });
  await model.addProvider({ id: 'omniroute', model: 'test-model-b' });
  const saved = model.document();

  const { model: restored } = createModel();
  await restored.load(saved);
  assert.deepEqual(restored.document(), saved);

  const original = getProviderPreset('morph');
  const patches = [
    { transport: 'openai-responses' },
    { auth: original.auth === 'bearer' ? 'none' : 'bearer' },
    { baseUrl: 'https://evil.example/v1' },
  ];
  for (const patch of patches) {
    const presets = listProviderPresets().map((preset) =>
      preset.id === 'morph' ? { ...preset, ...patch } : preset);
    const { model: changed, secretStorage } = createModelWithPresets(presets);
    await rejectsCode(changed.load(saved), 'invalid-document');
    assert.equal(secretStorage.values.size, 0);
  }

  const changedOmni = listProviderPresets().map((preset) =>
    preset.id === 'omniroute' ? { ...preset, baseUrlEnv: 'OTHER_BASE_URL' } : preset);
  const { model: omniModel } = createModelWithPresets(changedOmni);
  await rejectsCode(omniModel.load(saved), 'invalid-document');
});

test('an add that cannot be persisted leaves no provider and no stored secret', async () => {
  const secretStorage = memorySecretStorage();
  let attempts = 0;
  const controller = createProviderSetupController({
    vscode: {
      ViewColumn: { Active: 1 },
      window: { showWarningMessage() {} },
    },
    secretStorage,
    environmentNames: ENVIRONMENT_NAMES,
    presets: listProviderPresets(),
    saveDocument: async () => {
      attempts += 1;
      throw new Error('cannot save');
    },
  });
  await assert.rejects(controller.handleMessage({
    type: 'add',
    id: 'morph',
    model: 'test-model-a',
    secret: FAKE_SECRET,
  }));
  assert.equal(attempts, 1);
  const view = await controller.view();
  assert.deepEqual(view.providers, []);
  assert.equal(view.activeProvider, null);
  assert.deepEqual([...secretStorage.values.keys()], []);
  for (const name of ['resolveApiKey', 'setSecret', 'setProviderCatalog']) {
    assert.equal(Object.prototype.hasOwnProperty.call(controller, name), false, 'controller does not expose ' + name);
  }
  controller.dispose();
});

test('a secret-store failure after the document is persisted rolls the provider back', async () => {
  const secretStorage = {
    values: new Map(),
    async get(key) { return this.values.get(key); },
    async store() { throw new Error('store unavailable'); },
    async delete() {},
  };
  const writes = [];
  const controller = createProviderSetupController({
    vscode: {
      ViewColumn: { Active: 1 },
      window: { showWarningMessage() {} },
    },
    secretStorage,
    environmentNames: ENVIRONMENT_NAMES,
    presets: listProviderPresets(),
    saveDocument: async (document) => { writes.push(document); },
  });
  const result = await controller.handleMessage({
    type: 'add',
    id: 'morph',
    model: 'test-model-a',
    secret: FAKE_SECRET,
  });
  assert.equal(result.handled, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'secret-store-unavailable');
  assert.equal(writes.length, 2, 'the add persists, then the rollback persists again');
  assert.equal(writes.at(-1).providers.length, 0);
  const view = await controller.view();
  assert.deepEqual(view.providers, []);
  assert.equal(view.activeProvider, null);
  assert.deepEqual([...secretStorage.values.keys()], []);
  controller.dispose();
});

test('an add with an invalid secret or a failing secret store leaves the document unchanged', async () => {
  const { model } = createModel();
  await rejectsCode(model.addProviderWithSecret({ id: 'morph', model: 'test-model-a' }, '\n'), 'invalid-secret');
  assert.deepEqual((await model.view()).providers, []);
  assert.equal((await model.view()).activeProvider, null);

  const failing = createProviderSetupModel({
    environmentNames: ENVIRONMENT_NAMES,
    presets: listProviderPresets(),
    secretStorage: {
      async get() { return undefined; },
      async store() { throw new Error('store unavailable'); },
      async delete() {},
    },
  });
  await rejectsCode(failing.addProviderWithSecret({ id: 'morph', model: 'test-model-a' }, FAKE_SECRET), 'secret-store-unavailable');
  const view = await failing.view();
  assert.deepEqual(view.providers, []);
  assert.equal(view.activeProvider, null);
});
