import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProviderSetup } from '../../src/stable/gateway/provider-setup.mjs';
import { createMemorySecretStore } from '../../src/stable/gateway/secret-store.mjs';
import {
  createProviderSetupController,
  renderProviderSetupHtml,
} from '../../src/stable/extensions/vibecodium-ai/src/provider-setup.cjs';

const SECRET = 'sk-panel-4c1d8e-do-not-leak';
const HTML_SECRET = '<b>not-html</b>';

function createFakeVscode() {
  const state = { panels: [], warnings: [], info: [] };
  return {
    state,
    ViewColumn: { Active: 1 },
    window: {
      createWebviewPanel(id, title, column, options) {
        const panel = {
          id,
          title,
          column,
          options,
          webview: {
            html: '',
            handler: null,
            onDidReceiveMessage(handler) {
              this.handler = handler;
              return { dispose() {} };
            },
          },
          onDidDispose(handler) {
            this.disposeHandler = handler;
            return { dispose() {} };
          },
          reveal() { this.revealed = true; },
          dispose() {
            this.disposed = true;
            if (this.disposeHandler) this.disposeHandler();
          },
        };
        state.panels.push(panel);
        return panel;
      },
      showInformationMessage(message) { state.info.push(message); },
      showWarningMessage(message) { state.warnings.push(message); },
    },
  };
}

function fixture(t, env = {}) {
  const tempRoot = os.tmpdir();
  const root = mkdtempSync(path.join(tempRoot, 'vibe-provider-panel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const setup = createProviderSetup({
    settingsPath: path.join(root, 'vibecodium', 'providers.json'),
    secretStore: createMemorySecretStore(),
    env,
  });
  const vscode = createFakeVscode();
  const controller = createProviderSetupController({
    vscode,
    extensionUri: { fsPath: 'x' },
    setupProvider: () => setup,
  });
  return { root, setup, vscode, controller };
}

function customProvider(overrides = {}) {
  return {
    id: 'my-lab',
    label: 'My Lab',
    transport: 'openai-chat',
    baseUrl: 'https://lab.example/v1',
    model: 'lab-model',
    auth: 'bearer',
    apiKeyEnv: 'MY_LAB_API_KEY',
    capabilities: ['chat', 'stream'],
    ...overrides,
  };
}

test('the panel renders the provider list, the env-var picker and the add form', async (t) => {
  const { vscode, controller } = fixture(t, { MY_LAB_API_KEY: SECRET });
  assert.equal(controller.view().providers.some((entry) => entry.id === 'omniroute'), true);

  const opened = controller.open();
  assert.equal(opened.opened, true);
  assert.equal(vscode.state.panels.length, 1);
  const html = controller.html();
  assert.match(html, /Vibecodium Providers/);
  assert.match(html, /Add provider/);
  assert.match(html, /data-provider-row="omniroute"/);
  assert.match(html, /<option value="MY_LAB_API_KEY">/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script nonce="/);
  assert.equal(html.includes(SECRET), false);
  assert.equal(html.includes('onclick'), false);
});

test('the panel adds a provider, imports a key and switches the active provider', async (t) => {
  const { vscode, controller } = fixture(t, { MY_LAB_API_KEY: SECRET });
  controller.open();

  const added = await controller.handleMessage({ type: 'addProvider', provider: customProvider() });
  assert.equal(added.handled, true);
  assert.equal(added.kind, 'addProvider');
  assert.equal(controller.view().providers.find((entry) => entry.id === 'my-lab').configured, true);
  assert.match(controller.html(), /data-provider-row="my-lab"/);

  const imported = await controller.handleMessage({
    type: 'importSecret',
    provider: 'my-lab',
    envName: 'MY_LAB_API_KEY',
  });
  assert.equal(imported.kind, 'importSecret');
  assert.equal(controller.view().providers.find((entry) => entry.id === 'my-lab').secretStored, true);
  assert.equal(controller.html().includes(SECRET), false);

  const selected = await controller.handleMessage({ type: 'selectProvider', provider: 'my-lab' });
  assert.equal(selected.kind, 'selectProvider');
  assert.equal(controller.view().activeProvider, 'my-lab');
  assert.match(controller.html(), /data-action="select" data-provider="my-lab" disabled>Active/);
  assert.equal(controller.html().includes(SECRET), false);
  assert.equal(vscode.state.warnings.length, 0);
});

test('the panel never echoes a secret and reports failures with a safe message', async (t) => {
  const { controller } = fixture(t, {});
  controller.open();
  await controller.handleMessage({ type: 'addProvider', provider: customProvider() });

  const stored = await controller.handleMessage({ type: 'setSecret', provider: 'my-lab', secret: HTML_SECRET });
  assert.equal(stored.kind, 'setSecret');
  assert.equal(controller.html().includes(HTML_SECRET), false);
  assert.equal(JSON.stringify(controller.view()).includes(HTML_SECRET), false);

  const rejected = await controller.handleMessage({ type: 'setSecret', provider: 'my-lab', secret: 'line\nbreak' });
  assert.equal(rejected.handled, true);
  assert.equal(rejected.kind, 'error');
  assert.equal(rejected.code, 'invalid-secret');
  assert.equal(controller.html().includes('line\nbreak'), false);
  assert.equal(controller.view().status.error.includes('line'), false);

  const unknown = await controller.handleMessage({ type: 'selectProvider', provider: 'nope' });
  assert.equal(unknown.kind, 'error');
  assert.equal(unknown.code, 'unknown-provider');
  assert.match(controller.html(), /unknown provider/);

  const cleared = await controller.handleMessage({ type: 'clearSecret', provider: 'my-lab' });
  assert.equal(cleared.kind, 'clearSecret');
  assert.equal(controller.view().providers.find((entry) => entry.id === 'my-lab').secretStored, false);

  const removed = await controller.handleMessage({ type: 'removeProvider', provider: 'my-lab' });
  assert.equal(removed.kind, 'removeProvider');
  assert.equal(controller.view().providers.some((entry) => entry.id === 'my-lab'), false);
});

test('the panel rejects malformed, oversized and unknown messages', async (t) => {
  const { controller } = fixture(t, {});
  controller.open();
  assert.deepEqual(await controller.handleMessage(null), { handled: false, reason: 'invalid-message' });
  assert.deepEqual(await controller.handleMessage({ type: 'nope' }), { handled: false, reason: 'unknown-message' });
  assert.deepEqual(
    await controller.handleMessage({ type: 'refresh', pad: 'x'.repeat(70_000) }),
    { handled: false, reason: 'message-too-large' },
  );
  assert.equal((await controller.handleMessage({ type: 'refresh' })).kind, 'refresh');
});

test('the panel reports a missing setup service and a missing view safely', async (t) => {
  const vscode = createFakeVscode();
  const controller = createProviderSetupController({
    vscode,
    extensionUri: { fsPath: 'x' },
    setupProvider: () => null,
  });
  const opened = controller.open();
  assert.equal(opened.opened, false);
  assert.equal(opened.reason, 'no-setup');
  assert.equal(controller.view(), null);
  assert.equal(vscode.state.info.length, 1);
  assert.match(renderProviderSetupHtml(null), /not available/);
  assert.doesNotThrow(() => controller.dispose());
});

test('disposing the panel clears its state', async (t) => {
  const { controller } = fixture(t, {});
  controller.open();
  assert.equal(typeof controller.html(), 'string');
  controller.dispose();
  assert.equal(controller.html(), null);
  assert.equal(controller.open().opened, true);
});
