import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFirstRunController,
  renderFirstRunHtml,
} from '../../src/stable/extensions/vibecodium-ai/src/first-run.cjs';
import { buildOllamaBaseUrl } from '../../src/stable/runtime/ollama.mjs';

const OLLAMA_BASE_URL = buildOllamaBaseUrl(11434);

const chatId = 'qwen2.5-coder-1.5b-q4-k-m';
const embeddingId = 'qwen3-embedding-0.6b-q8-0';

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

function model(id, role, installed = false) {
  return { id, role, sizeBytes: 1024 * 1024, installed, path: 'C:/models/' + id + '.gguf' };
}

function baseView(overrides = {}) {
  const installed = overrides.installed === true;
  return {
    version: 1,
    phase: 'needs-download',
    verdict: 'tight',
    acceleration: 'cpu',
    notices: ['no-gpu'],
    hardware: {
      platform: 'win32',
      arch: 'x64',
      cpuModel: 'Unit Test CPU',
      logicalCores: 8,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      freeMemoryBytes: 8 * 1024 * 1024 * 1024,
      gpuCount: 0,
    },
    models: [model(chatId, 'chat', installed), model(embeddingId, 'embedding', installed)],
    downloadBytes: installed ? 0 : 2 * 1024 * 1024,
    plan: null,
    progress: null,
    error: null,
    source: 'pinned',
    ollama: null,
    start: installed
      ? { available: true, kind: 'llama-server', modelPath: 'C:/models/chat.gguf', contextSize: 8192, threads: 6, gpuLayers: 0 }
      : { available: false, reason: 'not-ready' },
    steps: [
      { id: 'check', status: 'done' },
      { id: 'models', status: installed ? 'done' : 'active' },
      { id: 'download', status: installed ? 'done' : 'active' },
      { id: 'runtime', status: installed ? 'ready' : 'pending' },
    ],
    disposed: false,
    ...overrides,
  };
}

function fakeWizard(view = baseView()) {
  const calls = { refresh: 0, install: 0, start: 0, useOllama: 0, usePinned: 0 };
  return {
    calls,
    view: () => view,
    refresh: async () => { calls.refresh += 1; return view; },
    install: async () => { calls.install += 1; return { ok: true, installed: 2 }; },
    startPlan: () => { calls.start += 1; return view.start; },
    useOllama: () => { calls.useOllama += 1; return { ok: true, source: 'ollama' }; },
    usePinned: () => { calls.usePinned += 1; return { ok: true, source: 'pinned' }; },
  };
}

function fixture(t, view) {
  const vscode = createFakeVscode();
  const wizard = fakeWizard(view);
  const controller = createFirstRunController({
    vscode,
    extensionUri: { fsPath: 'x' },
    wizardProvider: () => wizard,
  });
  t.after(() => controller.dispose());
  return { vscode, wizard, controller };
}

test('the panel renders the verdict, models, notices and controls', async (t) => {
  const { controller, vscode } = fixture(t);
  const opened = await controller.open();
  assert.deepEqual(opened, { opened: true });
  assert.equal(vscode.state.panels.length, 1);
  const html = controller.html();
  assert.match(html, /Vibecodium Setup/);
  assert.match(html, /Models needed/);
  assert.match(html, /data-model="qwen2\.5-coder-1\.5b-q4-k-m"/);
  assert.match(html, /Needs download/);
  assert.match(html, /data-action="refresh"/);
  assert.match(html, /data-action="install">Download models/);
  assert.match(html, /data-action="start" disabled>Start local runtime/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script nonce="/);
  const cspNonce = html.match(/script-src 'nonce-([A-Za-z0-9+/=]{24})'/);
  const scriptNonce = html.match(/script nonce="([A-Za-z0-9+/=]{24})"/);
  const styleNonce = html.match(/style nonce="([A-Za-z0-9+/=]{24})"/);
  assert.ok(cspNonce && scriptNonce && styleNonce);
  assert.equal(cspNonce[1], scriptNonce[1]);
  assert.equal(cspNonce[1], styleNonce[1]);
  assert.match(html, /style-src 'nonce-[A-Za-z0-9+/=]{24}'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /form-action 'none'/);
  const fallback = renderFirstRunHtml(null);
  assert.match(fallback, /script-src 'nonce-[A-Za-z0-9+/=]{24}'/);
  assert.equal(fallback.includes('[PERSON_NAME]'), false);
  assert.match(html, /First-run check complete\./);
  assert.deepEqual(controller.view().status, { message: 'First-run check complete.', error: null });
  assert.equal(vscode.state.warnings.length, 0);
});

test('the panel drives install and start through bounded messages', async (t) => {
  const { controller, wizard } = fixture(t);
  await controller.open();
  const installed = await controller.handleMessage({ type: 'install' });
  assert.equal(installed.kind, 'install');
  assert.equal(installed.ok, true);
  assert.equal(wizard.calls.install, 1);
  assert.match(controller.html(), /downloaded and verified/);

  const blocked = await controller.handleMessage({ type: 'start' });
  assert.equal(blocked.kind, 'start');
  assert.equal(blocked.ok, false);
  assert.match(controller.html(), /Finish the setup steps/);

  const refreshed = await controller.handleMessage({ type: 'refresh' });
  assert.equal(refreshed.kind, 'refresh');
  assert.equal(wizard.calls.refresh, 2);
});

test('a ready plan starts from the panel without spawning it', async (t) => {
  const { controller, wizard } = fixture(t, baseView({ installed: true, phase: 'ready' }));
  await controller.open();
  assert.match(controller.html(), /data-action="start">Start local runtime/);
  const started = await controller.handleMessage({ type: 'start' });
  assert.equal(started.kind, 'start');
  assert.equal(started.ok, true);
  assert.equal(wizard.calls.start, 1);
  assert.match(controller.html(), /ready to start/);
});

test('a missing bundled binary is reported as a clear message', async (t) => {
  const view = baseView({
    installed: true,
    phase: 'ready',
    start: { available: false, reason: 'runtime-not-bundled' },
  });
  const { controller } = fixture(t, view);
  await controller.open();
  const started = await controller.handleMessage({ type: 'start' });
  assert.equal(started.ok, false);
  assert.match(controller.html(), /binary is not bundled yet/);
});

test('all dynamic text is escaped and an injected view cannot add markup', async (t) => {
  const hostile = baseView({
    notices: ['<script>alert(1)</script>'],
    models: [{ ...model(chatId, 'chat'), id: '"><img src=x onerror=alert(1)>' }],
  });
  const { controller } = fixture(t, hostile);
  await controller.open();
  await controller.handleMessage({ type: 'install' });
  const html = controller.html();
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(renderFirstRunHtml(null).includes('not available'), true);
  const prototype = renderFirstRunHtml({
    ...baseView(),
    steps: [{ id: '__proto__', status: 'done' }],
  });
  assert.equal(prototype.includes('[object Object]'), false);
  assert.match(prototype, /data-step="__proto__"/);
});

test('the panel renders a bounded progress element and escapes its model id', async (t) => {
  const view = baseView({
    phase: 'downloading',
    progress: {
      modelId: '<img src=x onerror=alert(1)>',
      role: 'chat',
      received: 4 * 1024 * 1024,
      total: 2 * 1024 * 1024,
      fraction: 2,
    },
  });
  const { controller } = fixture(t, view);
  await controller.open();
  const html = controller.html();
  assert.match(html, /<progress max="2097152" value="2097152"><\/progress>/);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

function ollamaView(overrides = {}) {
  return baseView({
    source: 'pinned',
    ollama: {
      version: 1,
      available: true,
      reason: null,
      status: 200,
      port: 11434,
      baseUrl: OLLAMA_BASE_URL,
      chatModel: 'llama3.2:3b',
      embeddingModel: 'nomic-embed-text:latest',
      modelCount: 2,
      notices: [],
    },
    ...overrides,
  });
}

test('the panel offers a discovered local daemon and switches to it', async (t) => {
  const { controller, wizard } = fixture(t, ollamaView());
  await controller.open();
  const html = controller.html();
  assert.match(html, /Existing local models/);
  assert.match(html, /Chat model: <code>llama3\.2:3b<\/code>/);
  assert.match(html, /data-action="use-ollama">Use Ollama/);
  assert.equal(html.includes('Use pinned models'), false);
  assert.equal(wizard.calls.useOllama, 0);

  const used = await controller.handleMessage({ type: 'use-ollama' });
  assert.equal(used.kind, 'use-ollama');
  assert.equal(used.ok, true);
  assert.equal(wizard.calls.useOllama, 1);
  assert.match(controller.html(), /existing Ollama models/);
});

test('the panel renders the Ollama start plan and a way back to the pinned models', async (t) => {
  const view = ollamaView({
    phase: 'ready',
    source: 'ollama',
    downloadBytes: 2048,
    start: {
      available: true,
      kind: 'ollama',
      baseUrl: OLLAMA_BASE_URL,
      model: 'llama3.2:3b',
      embeddingModel: 'nomic-embed-text:latest',
    },
  });
  const { controller, wizard } = fixture(t, view);
  await controller.open();
  const html = controller.html();
  assert.match(html, /Ollama at <code>/);
  assert.match(html, /\(in use\)/);
  assert.match(html, /data-action="use-ollama" disabled>Use Ollama/);
  assert.match(html, /data-action="use-pinned">Use pinned models/);
  assert.match(html, /data-action="start">Start local runtime/);

  const started = await controller.handleMessage({ type: 'start' });
  assert.equal(started.kind, 'start');
  assert.equal(started.ok, true);
  assert.match(controller.html(), /Ollama daemon/);

  const pinned = await controller.handleMessage({ type: 'use-pinned' });
  assert.equal(pinned.kind, 'use-pinned');
  assert.equal(pinned.ok, true);
  assert.equal(wizard.calls.usePinned, 1);
  assert.match(controller.html(), /pinned llama\.cpp models/);
});

test('an unavailable daemon is explained safely and a missing control method fails closed', async (t) => {
  const view = baseView({
    ollama: {
      version: 1,
      available: false,
      reason: 'timeout',
      status: null,
      port: 11434,
      baseUrl: null,
      chatModel: null,
      embeddingModel: null,
      modelCount: 0,
      notices: [],
    },
  });
  const { controller } = fixture(t, view);
  await controller.open();
  const html = controller.html();
  assert.match(html, /The Ollama check timed out\./);
  assert.match(html, /data-action="use-ollama" disabled>Use Ollama/);

  const hostile = baseView({
    ollama: {
      version: 1,
      available: false,
      reason: '<img src=x onerror=alert(1)>',
      notices: [],
    },
  });
  const hostileFixture = fixture(t, hostile);
  await hostileFixture.controller.open();
  const hostileHtml = hostileFixture.controller.html();
  assert.equal(hostileHtml.includes('<img src=x'), false);
  assert.match(hostileHtml, /Ollama is not available\./);

  const noMethod = fixture(t, ollamaView());
  delete noMethod.wizard.useOllama;
  await noMethod.controller.open();
  assert.deepEqual(
    await noMethod.controller.handleMessage({ type: 'use-ollama' }),
    { handled: false, reason: 'unknown-message' },
  );
});

test('a discovered model name is escaped in the daemon section and start plan', async (t) => {
  const view = ollamaView({
    phase: 'ready',
    source: 'ollama',
    ollama: {
      version: 1,
      available: true,
      reason: null,
      status: 200,
      port: 11434,
      baseUrl: OLLAMA_BASE_URL,
      chatModel: '"><img src=x onerror=alert(1)>',
      embeddingModel: null,
      modelCount: 1,
      notices: [],
    },
    start: {
      available: true,
      kind: 'ollama',
      baseUrl: OLLAMA_BASE_URL,
      model: '"><img src=x onerror=alert(1)>',
      embeddingModel: null,
    },
  });
  const { controller } = fixture(t, view);
  await controller.open();
  const html = controller.html();
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a missing wizard and malformed messages are reported safely', async (t) => {
  const vscode = createFakeVscode();
  const controller = createFirstRunController({
    vscode,
    extensionUri: { fsPath: 'x' },
    wizardProvider: () => null,
  });
  t.after(() => controller.dispose());
  assert.deepEqual(await controller.open(), { opened: false, reason: 'no-wizard' });
  assert.equal(controller.view(), null);
  assert.equal(vscode.state.info.length, 1);

  const { controller: active } = fixture(t);
  await active.open();
  assert.deepEqual(await active.handleMessage(null), { handled: false, reason: 'invalid-message' });
  assert.deepEqual(await active.handleMessage({ type: 'nope' }), { handled: false, reason: 'unknown-message' });
  assert.deepEqual(
    await active.handleMessage({ type: 'x'.repeat(70_000) }),
    { handled: false, reason: 'message-too-large' },
  );
  assert.deepEqual(
    await active.handleMessage({ type: 'é'.repeat(40_000) }),
    { handled: false, reason: 'message-too-large' },
  );
  const cyclic = { type: 'refresh' };
  cyclic.self = cyclic;
  assert.deepEqual(await active.handleMessage(cyclic), { handled: false, reason: 'invalid-message' });
  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, 'type', {
    enumerable: true,
    get() { invoked = true; return 'refresh'; },
  });
  assert.deepEqual(await active.handleMessage(accessor), { handled: false, reason: 'invalid-message' });
  assert.equal(invoked, false);
  const revoked = Proxy.revocable({ type: 'refresh' }, {});
  revoked.revoke();
  assert.deepEqual(await active.handleMessage(revoked.proxy), { handled: false, reason: 'invalid-message' });
});

test('wizard errors never echo their text and disposing closes the panel', async (t) => {
  const vscode = createFakeVscode();
  const wizard = fakeWizard();
  wizard.refresh = async () => { throw new Error('C:\\Users\\me\\secret'); };
  const controller = createFirstRunController({
    vscode,
    extensionUri: { fsPath: 'x' },
    wizardProvider: () => wizard,
  });
  t.after(() => controller.dispose());
  await controller.open();
  assert.equal(controller.html().includes('secret'), false);
  assert.match(controller.html(), /The setup action failed\./);

  const hostile = new Error('x');
  hostile.code = '<b>bad</b>';
  wizard.refresh = async () => { throw hostile; };
  const result = await controller.handleMessage({ type: 'refresh' });
  assert.equal(result.kind, 'refresh');
  assert.equal(controller.html().includes('<b>'), false);
  assert.match(controller.html(), /The setup action failed\./);

  controller.dispose();
  assert.equal(controller.html(), null);
  const reopened = await controller.open();
  assert.equal(reopened.opened, true);
  assert.equal(vscode.state.panels.length, 2);
});

test('an install that reports the selected daemon is explained without a download claim', async (t) => {
  const { controller, wizard } = fixture(t);
  wizard.install = async () => ({ ok: true, installed: 0, reason: 'ollama-selected' });
  await controller.open();
  const result = await controller.handleMessage({ type: 'install' });
  assert.equal(result.kind, 'install');
  assert.equal(result.ok, true);
  assert.match(controller.html(), /existing [A-Za-z]+ models/);
  assert.equal(controller.html().includes('downloaded and verified'), false);
});
