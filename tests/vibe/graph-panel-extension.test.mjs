import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const extensionPath = path.resolve('src/stable/extensions/vibecodium-ai/src/extension.cjs');

function loadExtension() {
  const originalLoad = Module._load;
  const commands = new Map();
  let opened = 0;
  const fake = {
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
          webview: { html: '', onDidReceiveMessage() { return { dispose() {} }; } },
          onDidDispose() { return { dispose() {} }; },
          reveal() {},
          dispose() {},
        };
      },
      async showTextDocument() {},
      showWarningMessage() {},
      showInformationMessage() {},
    },
    workspace: { async openTextDocument() { return {}; } },
  };
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return fake;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[extensionPath];
    const api = require(extensionPath);
    return { api, commands, opened: () => opened };
  } finally {
    Module._load = originalLoad;
  }
}

test('the built-in extension activates and registers the graph commands', () => {
  const loaded = loadExtension();
  const context = { subscriptions: [], extensionUri: { fsPath: 'extension' } };
  const api = loaded.api.activate(context);
  assert.deepEqual([...loaded.commands.keys()].sort(), [
    'vibecodium.graph.open',
    'vibecodium.graph.setData',
    'vibecodium.memory.open',
    'vibecodium.memory.setStore',
    'vibecodium.providers.open',
    'vibecodium.providers.setSetup',
  ]);
  assert.equal(context.subscriptions.length, 6);
  assert.equal(typeof api.open, 'function');
  api.setGraph({ projects: [{ id: 'api' }], nodes: [], edges: [] });
  assert.equal(loaded.opened(), 0);
  assert.doesNotThrow(() => loaded.commands.get('vibecodium.graph.open')());
  assert.equal(loaded.opened(), 1);
});

test('the extension manifest exposes the graph command and entry point', () => {
  const manifest = require('../../src/stable/extensions/vibecodium-ai/package.json');
  assert.equal(manifest.main, './src/extension.cjs');
  assert.ok(manifest.contributes.commands.some((command) => command.command === 'vibecodium.graph.open'));
  assert.ok(manifest.activationEvents.includes('onCommand:vibecodium.graph.open'));
  assert.ok(manifest.activationEvents.includes('onCommand:vibecodium.graph.setData'));
});

test('the extension exposes rendered panel state and the shared node activation path', async () => {
  const loaded = loadExtension();
  const context = { subscriptions: [], extensionUri: { fsPath: 'extension' } };
  const api = loaded.api.activate(context);
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
});
