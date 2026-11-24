'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function loadWithFakeVscode() {
  const modulePath = path.join(__dirname, 'extension.cjs');
  const originalLoad = Module._load;
  const commands = new Map();
  let opened = 0;
  const vscode = {
    ViewColumn: { Active: 1 },
    Uri: { file: (value) => ({ fsPath: value }) },
    Range: class { constructor(...args) { this.args = args; } },
    commands: {
      registerCommand(name, handler) {
        commands.set(name, handler);
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

test('activate registers the graph panel commands without touching the workbench', () => {
  const loaded = loadWithFakeVscode();
  const context = { subscriptions: [], extensionUri: { fsPath: 'x' } };
  const api = loaded.activate(context);
  assert.deepEqual([...loaded.commands.keys()].sort(), [
    'vibecodium.graph.open',
    'vibecodium.graph.setData',
  ]);
  assert.equal(context.subscriptions.length, 2);
  assert.equal(typeof api.open, 'function');
  api.setGraph({ projects: [{ id: 'api' }], nodes: [], edges: [] });
  assert.equal(loaded.opened(), 0);
});

test('the open command reports a missing graph rather than throwing', () => {
  const loaded = loadWithFakeVscode();
  const context = { subscriptions: [], extensionUri: { fsPath: 'x' } };
  loaded.activate(context);
  assert.doesNotThrow(() => loaded.commands.get('vibecodium.graph.open')());
  assert.equal(loaded.opened(), 0);
});
