'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vscode = require('vscode');

const PRESETS_MODULE = path.join(__dirname, '..', '..', '..', 'gateway', 'provider-presets.mjs');
const SECRET = 'test-only-provider-panel-secret-0001';

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('vibecodium.vibecodium-ai');
  assert.ok(extension, 'the vibecodium-ai extension is loaded');
  const api = await extension.activate();
  for (const name of [
    'openProviders',
    'getProviderSetupView',
    'getProviderSetupHtml',
    'handleProviderSetupMessage',
    'disposeProviders',
  ]) {
    assert.equal(typeof api[name], 'function', 'the extension exposes ' + name);
  }
  for (const name of ['resolveApiKey', 'resolveProviderApiKey', 'setCatalog', 'setProviderCatalog']) {
    assert.equal(Object.prototype.hasOwnProperty.call(api, name), false, 'the extension does not expose ' + name);
  }

  const { listProviderPresets } = await import(pathToFileURL(PRESETS_MODULE).href);
  const catalog = listProviderPresets();
  assert.ok(catalog.length >= 10, 'the B1 catalog is available');
  const opened = await api.openProviders();
  assert.equal(opened.opened, true);
  const initial = await api.getProviderSetupView();
  assert.equal(initial.presets.length, catalog.length);
  assert.equal(initial.activeProvider, null);
  assert.ok(initial.environmentNames.includes('PATH'), 'the environment-variable picker is populated with names');

  const added = await api.handleProviderSetupMessage({
    type: 'add',
    id: 'morph',
    model: 'panel-model',
    apiKeyEnv: 'MORPH_API_KEY',
  });
  assert.equal(added.handled, true);
  assert.equal(added.ok, true);
  let view = await api.getProviderSetupView();
  assert.equal(view.activeProvider, 'morph');
  assert.equal(view.providers.length, 1);
  assert.equal(view.providers[0].credentialSource, 'environment');

  const saved = await api.handleProviderSetupMessage({ type: 'save-secret', id: 'morph', value: SECRET });
  assert.equal(saved.ok, true);
  assert.equal(saved.hasSecret, true);
  view = await api.getProviderSetupView();
  assert.equal(view.providers[0].hasSecret, true);
  assert.equal(view.providers[0].credentialSource, 'secret-storage');
  assert.ok(!JSON.stringify(view).includes(SECRET), 'the view never carries the secret');
  assert.ok(!api.getProviderSetupHtml().includes(SECRET), 'the panel HTML never carries the secret');
  assert.equal(view.providers[0].hasSecret, true, 'the host persists the stored secret');

  const second = await api.handleProviderSetupMessage({
    type: 'add',
    id: 'openrouter',
    model: 'panel-model-b',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  });
  assert.equal(second.ok, true);
  const selected = await api.handleProviderSetupMessage({ type: 'select', id: 'openrouter' });
  assert.equal(selected.ok, true);
  view = await api.getProviderSetupView();
  assert.equal(view.activeProvider, 'openrouter');
  assert.equal(view.providers.length, 2);
  assert.ok(!JSON.stringify(view).includes(SECRET));

  api.disposeProviders();
  const reopened = await api.openProviders();
  assert.equal(reopened.opened, true);
  const persisted = await api.getProviderSetupView();
  assert.equal(persisted.activeProvider, 'openrouter');
  assert.equal(persisted.providers.length, 2);
  assert.equal(persisted.providers.find((entry) => entry.id === 'morph').hasSecret, true);
  assert.ok(!JSON.stringify(persisted).includes(SECRET));
  assert.ok(!api.getProviderSetupHtml().includes(SECRET));
  api.disposeProviders();
  console.log('PROVIDER_SETUP_IDE_OK');
};
