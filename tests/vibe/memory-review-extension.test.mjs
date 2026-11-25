import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../../src/stable/context-engine/memory-store.mjs';

const require = createRequire(import.meta.url);
const extensionPath = path.resolve('src/stable/extensions/vibecodium-ai/src/extension.cjs');

function loadExtension() {
  const originalLoad = Module._load;
  const commands = Object.create(null);
  const panels = [];
  const fake = {
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
      createWebviewPanel(id, title) {
        const panel = {
          id,
          title,
          webview: {
            html: '',
            handler: null,
            onDidReceiveMessage(handler) {
              this.handler = handler;
              return { dispose() {} };
            },
          },
          onDidDispose() { return { dispose() {} }; },
          reveal() {},
          dispose() {},
        };
        panels.push(panel);
        return panel;
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
    return { api, commands, panels };
  } finally {
    Module._load = originalLoad;
  }
}

async function makeStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibe-memory-extension-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new MemoryStore({ root, projectId: 'fixture-app' }) };
}

test('the built-in extension activates and registers graph and memory commands', async (t) => {
  const { store } = await makeStore(t);
  await store.remember({ scope: 'project', key: 'editor.tabs', value: 4, origin: 'agent' });

  const loaded = loadExtension();
  const context = { subscriptions: [], extensionUri: { fsPath: 'extension' } };
  const api = loaded.api.activate(context);
  assert.deepEqual(Object.keys(loaded.commands).sort(), [
    'vibecodium.graph.open',
    'vibecodium.graph.setData',
    'vibecodium.memory.open',
    'vibecodium.memory.setStore',
    'vibecodium.providers.open',
  ]);
  assert.equal(context.subscriptions.length, 5);

  await loaded.commands['vibecodium.memory.open']();
  assert.equal(loaded.panels.length, 0);

  await loaded.commands['vibecodium.memory.setStore'](store);
  await loaded.commands['vibecodium.memory.open']();
  assert.equal(loaded.panels.length, 1);
  assert.match(loaded.panels[0].webview.html, /editor\.tabs/);
  assert.match(loaded.panels[0].webview.html, /data-action="approve"/);
  assert.equal(typeof api.getMemoryView, 'function');
  assert.equal(typeof api.getMemoryPanelHtml, 'function');
  assert.equal(typeof api.handleMemoryMessage, 'function');
  assert.equal(typeof api.disposeMemory, 'function');
  assert.equal(api.getMemoryView().total, 1);
  assert.match(api.getMemoryPanelHtml(), /editor\.tabs/);

  const page = await store.review({ scope: 'project' });
  const item = page.items[0];
  await loaded.panels[0].webview.handler({ type: 'action', action: 'approve', id: item.id, revision: item.revision });
  const recalled = await store.recall({ scope: 'project', key: 'editor.tabs' });
  assert.equal(recalled.total, 1);
  assert.equal(typeof api.openMemory, 'function');
});

test('the extension manifest exposes the memory review command and entry point', () => {
  const manifest = require('../../src/stable/extensions/vibecodium-ai/package.json');
  assert.equal(manifest.main, './src/extension.cjs');
  assert.ok(manifest.contributes.commands.some((command) => command.command === 'vibecodium.memory.open'));
  assert.ok(manifest.activationEvents.includes('onCommand:vibecodium.memory.open'));
  assert.ok(manifest.activationEvents.includes('onCommand:vibecodium.memory.setStore'));
});
