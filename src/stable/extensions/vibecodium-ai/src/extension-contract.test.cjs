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

test('activate registers the graph and memory panel commands without touching the workbench', () => {
  const loaded = loadWithFakeVscode();
  const context = { subscriptions: [], extensionUri: { fsPath: 'x' } };
  const api = loaded.activate(context);
  assert.deepEqual(Object.keys(loaded.commands).sort(), [
    'vibecodium.graph.open',
    'vibecodium.graph.setData',
    'vibecodium.memory.open',
    'vibecodium.memory.setStore',
  ]);
  assert.equal(context.subscriptions.length, 4);
  assert.equal(typeof api.open, 'function');
  assert.equal(typeof api.openMemory, 'function');
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
