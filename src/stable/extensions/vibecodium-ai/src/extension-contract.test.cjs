'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function loadWithFakeVscode() {
  const modulePath = path.join(__dirname, 'extension.cjs');
  const originalLoad = Module._load;
  const commands = Object.create(null);
  let opened = 0;
  const vscode = {
    ViewColumn: { Active: 1 },
    Uri: { file: (value) => ({ fsPath: value }) },
    Range: class { constructor(...args) { this.args = args; } },
    commands: {
      registerCommand(name, handler) {
        commands[name] = handler;
        return { dispose() {} };
      },
    },
    window: {
      createWebviewPanel() {
        opened += 1;
        return {
          webview: {
            html: '',
            onDidReceiveMessage() { return { dispose() {} }; },
          },
          onDidDispose() { return { dispose() {} }; },
          reveal() {},
          dispose() {},
        };
      },
      async showTextDocument() {},
      showWarningMessage() {},
      showInformationMessage() {},
    },
    workspace: {
      async openTextDocument() {
        return {};
      },
    },
  };
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[modulePath];
    const api = require(modulePath);
    return { api, commands, opened: () => opened, activate: api.activate };
  } finally {
    Module._load = originalLoad;
  }
}

const emptyStore = {
  async review({ scope, status, offset, limit }) {
    return { scope, status, total: 0, offset, limit, hasMore: false, items: [] };
  },
  async approve() {},
  async reject() {},
  async forget() {},
};

function fakeContext() {
  const values = new Map();
  const state = new Map();
  return {
    subscriptions: [],
    extensionUri: { fsPath: 'x' },
    secrets: {
      async get(key) { return values.get(key); },
      async store(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
    },
    globalState: {
      get(key) { return state.get(key); },
      async update(key, value) { state.set(key, value); },
    },
  };
}

const LOCAL_PRESET = {
  id: 'llama-cpp',
  label: 'Local llama.cpp',
  transport: 'openai-chat',
  baseUrl: 'http://127.0.0.1:8080/v1',
  auth: 'none',
  apiKeyRequired: false,
  capabilities: ['chat', 'stream', 'tools'],
  local: true,
};

test('activate registers the graph and memory panel commands without touching the workbench', () => {
  const loaded = loadWithFakeVscode();
  const context = { subscriptions: [], extensionUri: { fsPath: 'x' } };
  const api = loaded.activate(context);
  assert.deepEqual(Object.keys(loaded.commands).sort(), [
    'vibecodium.graph.open',
    'vibecodium.graph.setData',
    'vibecodium.memory.open',
    'vibecodium.memory.setStore',
    'vibecodium.providers.open',
  ]);
  assert.equal(context.subscriptions.length, 5);
  assert.equal(typeof api.open, 'function');
  assert.equal(typeof api.openMemory, 'function');
  assert.equal(typeof api.openProviders, 'function');
  for (const name of ['resolveApiKey', 'resolveProviderApiKey', 'setCatalog', 'setProviderCatalog']) {
    assert.equal(Object.prototype.hasOwnProperty.call(api, name), false, 'the extension does not expose ' + name);
  }
  api.setGraph({ projects: [{ id: 'api' }], nodes: [], edges: [] });
  assert.equal(loaded.opened(), 0);
});

test('the open command reports a missing graph rather than throwing', () => {
  const loaded = loadWithFakeVscode();
  const context = { subscriptions: [], extensionUri: { fsPath: 'x' } };
  loaded.activate(context);
  assert.doesNotThrow(() => loaded.commands['vibecodium.graph.open']());
  assert.equal(loaded.opened(), 0);
});

test('the memory review opens after a store is supplied', async () => {
  const loaded = loadWithFakeVscode();
  const context = { subscriptions: [], extensionUri: { fsPath: 'x' } };
  const api = loaded.activate(context);
  assert.equal(api.setStore(null), undefined);
  await loaded.commands['vibecodium.memory.open']();
  assert.equal(loaded.opened(), 0);
  await loaded.commands['vibecodium.memory.setStore'](emptyStore);
  await loaded.commands['vibecodium.memory.open']();
  assert.equal(loaded.opened(), 1);
});

test('the extension exposes panel state and activates a node through the shared click path', async () => {
  const loaded = loadWithFakeVscode();
  const context = { subscriptions: [], extensionUri: { fsPath: 'x' } };
  const api = loaded.activate(context);
  api.setGraph({
    projects: [{ id: 'api' }],
    nodes: [{ id: 'project:api', type: 'project', project: 'api' }],
    edges: [],
  });
  api.open();
  assert.equal(api.getView().level, 'workspace');
  assert.match(api.getPanelHtml(), /data-node-id="project:api"/);
  const result = await api.activateNode('project:api');
  assert.equal(result.kind, 'zoom');
  assert.equal(api.getView().level, 'project');
  assert.doesNotThrow(() => api.dispose());
});

test('the extension exposes memory panel state and handles a review message through the shared path', async () => {
  const loaded = loadWithFakeVscode();
  const context = { subscriptions: [], extensionUri: { fsPath: 'x' } };
  const api = loaded.activate(context);
  await api.setStore(emptyStore);
  const opened = await api.openMemory();
  assert.equal(opened.opened, true);
  const view = api.getMemoryView();
  assert.equal(view.scope, 'project');
  assert.equal(view.status, 'pending');
  assert.match(api.getMemoryPanelHtml(), /Vibe Memory/);
  const missing = await api.handleMemoryMessage({ type: 'action', action: 'approve', id: 'missing', revision: 1 });
  assert.equal(missing.handled, true);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'not-found');
  assert.doesNotThrow(() => api.disposeMemory());
});

test('the provider setup opens after normal activation with the B1 catalog and records a secret without exposing it', async () => {
  const loaded = loadWithFakeVscode();
  const context = fakeContext();
  const api = loaded.activate(context);
  const opened = await loaded.commands['vibecodium.providers.open']();
  assert.equal(opened.opened, true);
  const initial = await api.getProviderSetupView();
  assert.ok(initial.presets.length >= 10, 'normal activation loads the B1 catalog');
  assert.ok(initial.presets.some((preset) => preset.id === LOCAL_PRESET.id));
  const added = await api.handleProviderSetupMessage({ type: 'add', id: 'llama-cpp', model: 'local-model' });
  assert.equal(added.ok, true);
  const secret = 'test-only-panel-secret-not-real';
  const saved = await api.handleProviderSetupMessage({ type: 'save-secret', id: 'llama-cpp', value: secret });
  assert.equal(saved.ok, true);
  assert.equal(saved.hasSecret, true);
  const view = await api.getProviderSetupView();
  assert.equal(view.activeProvider, 'llama-cpp');
  assert.equal(view.providers[0].hasSecret, true);
  assert.ok(!JSON.stringify(view).includes(secret));
  assert.ok(!api.getProviderSetupHtml().includes(secret));
  const html = api.getProviderSetupHtml();
  assert.match(html, /if \(apiKeyEnv\) message\.apiKeyEnv = apiKeyEnv;/);
  assert.doesNotMatch(html, /apiKeyEnv: value\('apiKeyEnv'\)/);
  assert.equal(view.providers[0].hasSecret, true);

  let getterCalled = 0;
  const accessorMessage = { type: 'save-secret', id: 'llama-cpp' };
  Object.defineProperty(accessorMessage, 'value', {
    enumerable: true,
    get() { getterCalled += 1; return 'must-not-run'; },
  });
  const rejected = await api.handleProviderSetupMessage(accessorMessage);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid-message');
  assert.equal(getterCalled, 0);
  assert.doesNotThrow(() => api.disposeProviders());
});
