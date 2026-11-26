import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFirstRunController,
  renderFirstRunHtml,
} from '../../src/stable/extensions/vibecodium-ai/src/first-run.cjs';
import {
  MAX_RESTARTS,
  MAX_RESTART_DELAY_MS,
  MAX_RESTART_STABLE_MS,
  MIN_RESTARTS,
  MIN_RESTART_DELAY_MS,
  MIN_RESTART_STABLE_MS,
} from '../../src/stable/runtime/llama-server.mjs';

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
    start: installed
      ? { available: true, modelPath: 'C:/models/chat.gguf', contextSize: 8192, threads: 6, gpuLayers: 0 }
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

function ollamaResult(overrides = {}) {
  return {
    checked: true,
    available: true,
    reason: null,
    baseUrl: 'http://127.0.0.1:11434/v1',
    chatModel: 'qwen2.5-coder:7b',
    embeddingModel: 'nomic-embed-text:latest',
    modelCount: 2,
    notices: [],
    providerOptions: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' },
    ...overrides,
  };
}

function fakeWizard(view = baseView()) {
  const calls = { refresh: 0, install: 0, start: 0, ollama: 0, useOllama: 0, usePinned: 0 };
  const state = { ollama: ollamaResult() };
  return {
    calls,
    state,
    view: () => Object.assign({}, view, { ollama: state.ollama }),
    refresh: async () => { calls.refresh += 1; return view; },
    install: async () => { calls.install += 1; return { ok: true, installed: 2 }; },
    startPlan: () => { calls.start += 1; return view.start; },
    checkOllama: async () => { calls.ollama += 1; return state.ollama; },
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
  assert.equal(/O..ama/.test(fallback), false);
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

test('the local runtime section shows the bounded restart policy and omits a malformed one', () => {
  const start = {
    available: true,
    modelPath: 'C:/models/chat.gguf',
    contextSize: 8192,
    threads: 6,
    gpuLayers: 0,
    restart: { maxRestarts: 3, baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000 },
  };
  function render(restart) {
    return renderFirstRunHtml(baseView({
      installed: true,
      phase: 'ready',
      start: Object.assign({}, start, { restart }),
    }));
  }
  const html = render(start.restart);
  assert.match(html, /Restarts automatically up to 3 times/);
  assert.match(html, /back-off from 1 s to 30 s/);
  assert.match(html, /a run stable for 60 s resets the count/);
  assert.match(render(Object.assign({}, start.restart, { stableMs: 0 })), /a stable run never resets the count/);
  assert.match(render(Object.assign({}, start.restart, { maxRestarts: 1 })), /up to 1 time with/);
  assert.match(render(Object.assign({}, start.restart, { baseDelayMs: 1500 })), /from 1500 ms/);

  for (const restart of [
    undefined,
    null,
    { maxRestarts: '3', baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000 },
    { maxRestarts: 0, baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000 },
    { maxRestarts: 3 },
    {},
    Object.assign({}, start.restart, { extra: 1 }),
    { constructor: 1, maxRestarts: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
    // Values outside the supervisor's validated ranges are not a usable policy, so the line must be
    // omitted just like a malformed one rather than rendered as a misleading restart budget.
    { maxRestarts: 11, baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000 },
    { maxRestarts: 3, baseDelayMs: 1, maxDelayMs: 30000, stableMs: 60000 },
    { maxRestarts: 3, baseDelayMs: 5000, maxDelayMs: 1000, stableMs: 60000 },
    { maxRestarts: 3, baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 600001 },
  ]) {
    assert.equal(/Restarts automatically/.test(render(restart)), false,
      'an impossible policy must not render a restart line: ' + JSON.stringify(restart));
  }

  let accessorCalls = 0;
  const accessorStart = Object.assign({}, start);
  Object.defineProperty(accessorStart, 'restart', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return start.restart;
    },
  });
  const accessorHtml = renderFirstRunHtml(baseView({ installed: true, phase: 'ready', start: accessorStart }));
  assert.equal(/Restarts automatically/.test(accessorHtml), false);
  assert.equal(accessorCalls, 0);

  const revoked = Proxy.revocable(start.restart, {});
  revoked.revoke();
  assert.equal(/Restarts automatically/.test(render(revoked.proxy)), false);
});

test('the panel restart bounds stay aligned with the supervisor validator', () => {
  const policy = { maxRestarts: 3, baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000 };
  function renderRestartPolicy(overrides) {
    return renderFirstRunHtml(baseView({
      installed: true,
      phase: 'ready',
      start: {
        available: true,
        modelPath: 'C:/models/chat.gguf',
        contextSize: 8192,
        threads: 6,
        gpuLayers: 0,
        restart: Object.assign({}, policy, overrides),
      },
    }));
  }
  function omitted(overrides) {
    return /Restarts automatically/.test(renderRestartPolicy(overrides)) === false;
  }
  assert.equal(omitted({ maxRestarts: MIN_RESTARTS - 1 }), true);
  assert.equal(omitted({ maxRestarts: MAX_RESTARTS + 1 }), true);
  assert.match(renderRestartPolicy({ maxRestarts: MIN_RESTARTS }), /Restarts automatically/);
  assert.match(renderRestartPolicy({ maxRestarts: MAX_RESTARTS }), /Restarts automatically/);
  assert.equal(omitted({ baseDelayMs: MIN_RESTART_DELAY_MS - 1 }), true);
  assert.equal(omitted({ baseDelayMs: MAX_RESTART_DELAY_MS + 1 }), true);
  assert.equal(omitted({ baseDelayMs: MAX_RESTART_DELAY_MS, maxDelayMs: MAX_RESTART_DELAY_MS }), false);
  assert.equal(omitted({ baseDelayMs: 5000, maxDelayMs: 1000 }), true);
  assert.equal(omitted({ stableMs: MIN_RESTART_STABLE_MS - 1 }), true);
  assert.equal(omitted({ stableMs: MAX_RESTART_STABLE_MS + 1 }), true);
  assert.match(renderRestartPolicy({ stableMs: MIN_RESTART_STABLE_MS }), /resets the count/);
  assert.match(renderRestartPolicy({ stableMs: MAX_RESTART_STABLE_MS }), /resets the count/);
  assert.match(renderRestartPolicy({ stableMs: 0 }), /never resets/);
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

test('the panel renders the Ollama states and escapes every value', async (t) => {
  const { controller, wizard } = fixture(t);
  await controller.open();
  assert.equal(wizard.calls.ollama, 1);
  const html = controller.html();
  assert.match(html, /data-action="ollama">Check for Ollama/);
  assert.match(html, /Found a local Ollama daemon at/);
  assert.match(html, /qwen2\.5-coder:7b/);
  assert.match(html, /nomic-embed-text:latest/);
  assert.match(html, /provider setup/);
  assert.match(html, /127\.0\.0\.1:11434\/v1/);

  assert.match(renderFirstRunHtml(baseView()), /Ollama has not been checked yet/);
  assert.match(renderFirstRunHtml(baseView({
    ollama: ollamaResult({ available: false, reason: 'unreachable', baseUrl: null, chatModel: null, providerOptions: null }),
  })), /No local Ollama daemon was found \(unreachable\)/);
  assert.match(renderFirstRunHtml(baseView({
    ollama: ollamaResult({ available: true, chatModel: null, providerOptions: null, reason: 'no-chat-model' }),
  })), /no local chat model/);

  const hostile = renderFirstRunHtml(baseView({
    ollama: ollamaResult({
      baseUrl: '"><img src=x onerror=alert(1)>',
      chatModel: '<script>alert(2)</script>',
      embeddingModel: '<b>embed</b>',
    }),
  }));
  assert.equal(hostile.includes('<img src=x'), false);
  assert.equal(hostile.includes('<script>alert(2)</script>'), false);
  assert.equal(hostile.includes('<b>embed</b>'), false);
  assert.match(hostile, /&lt;img src=x/);
  assert.match(hostile, /&lt;b&gt;embed&lt;\/b&gt;/);
});

test('the panel drives one Ollama check and reports the outcome', async (t) => {
  const { controller, wizard } = fixture(t);
  await controller.open();
  assert.equal(wizard.calls.ollama, 1);

  const found = await controller.handleMessage({ type: 'ollama' });
  assert.deepEqual(found, { handled: true, kind: 'ollama', ok: true });
  assert.equal(wizard.calls.ollama, 2);
  assert.deepEqual(controller.view().status, { message: 'A local Ollama daemon answered.', error: null });

  wizard.state.ollama = ollamaResult({ available: false, reason: 'timeout', baseUrl: null, chatModel: null, providerOptions: null });
  const missing = await controller.handleMessage({ type: 'ollama' });
  assert.deepEqual(missing, { handled: true, kind: 'ollama', ok: false });
  assert.deepEqual(controller.view().status, { message: 'No local Ollama daemon answered.', error: null });
  assert.match(controller.html(), /No local Ollama daemon was found \(timeout\)/);
});

test('a wizard without Ollama detection is rejected safely', async (t) => {
  const vscode = createFakeVscode();
  const wizard = fakeWizard();
  delete wizard.checkOllama;
  const controller = createFirstRunController({
    vscode,
    extensionUri: { fsPath: 'x' },
    wizardProvider: () => wizard,
  });
  t.after(() => controller.dispose());
  assert.deepEqual(await controller.open(), { opened: false, reason: 'no-wizard' });
  assert.equal(vscode.state.info.length, 1);
  assert.match(vscode.state.info[0], /not connected yet/);
});

test('open() runs the automatic Ollama check after the first refresh', async (t) => {
  const order = [];
  const vscode = createFakeVscode();
  const wizard = {
    view: () => baseView({ ollama: ollamaResult() }),
    refresh: async () => { order.push('refresh'); return baseView(); },
    install: async () => ({ ok: true, installed: 0 }),
    startPlan: () => ({ available: false, reason: 'not-ready' }),
    checkOllama: async () => { order.push('ollama'); return ollamaResult(); },
  };
  const controller = createFirstRunController({
    vscode,
    extensionUri: { fsPath: 'x' },
    wizardProvider: () => wizard,
  });
  t.after(() => controller.dispose());
  await controller.open();
  assert.deepEqual(order, ['refresh', 'ollama']);
});

test('the panel rejects a multi-key Ollama message without checking', async (t) => {
  const { controller, wizard } = fixture(t);
  await controller.open();
  const before = wizard.calls.ollama;
  const result = await controller.handleMessage({ type: 'ollama', extra: true });
  assert.deepEqual(result, { handled: false, reason: 'invalid-message' });
  assert.equal(wizard.calls.ollama, before);
});

test('the panel escapes a hostile Ollama reason', async (t) => {
  const { controller, wizard } = fixture(t);
  wizard.state.ollama = ollamaResult({
    available: false,
    reason: '"><img src=x onerror=alert(1)>',
    baseUrl: null,
    chatModel: null,
    embeddingModel: null,
    providerOptions: null,
    notices: ['ollama-unreachable'],
  });
  await controller.open();
  const html = controller.html();
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

test('a thrown Ollama check is reported without leaking its text', async (t) => {
  const { controller, wizard } = fixture(t);
  await controller.open();
  wizard.state.ollama = null;
  wizard.checkOllama = async () => {
    const error = new Error('secret http://[IP_ADDRESS]:11434/v1');
    error.code = 'check-failed';
    throw error;
  };
  const result = await controller.handleMessage({ type: 'ollama' });
  assert.deepEqual(result, { handled: true, kind: 'ollama', ok: false });
  const html = controller.html();
  assert.equal(html.includes('secret'), false);
  assert.equal(html.includes('11434'), false);
  assert.match(html, /check-failed/);
  assert.deepEqual(controller.view().status, { message: null, error: 'check-failed' });
});

test('a hostile summary or thrown error cannot run a trap or getter', async (t) => {
  const vscode = createFakeVscode();
  let trapped = false;
  const seen = [];
  const summary = new Proxy(ollamaResult(), {
    // Promise resolution reads `then`; every other read is what the renderer must avoid.
    get(target, key) {
      if (key === 'then') return undefined;
      trapped = true;
      seen.push(String(key));
      throw new Error('get trap');
    },
    getOwnPropertyDescriptor() { trapped = true; throw new Error('gopd trap'); },
  });
  const wizard = Object.assign(fakeWizard(), {
    view: () => baseView({ ollama: summary }),
    checkOllama: async () => summary,
  });
  const controller = createFirstRunController({
    vscode,
    extensionUri: { fsPath: 'x' },
    wizardProvider: () => wizard,
  });
  t.after(() => controller.dispose());
  await controller.open();
  assert.deepEqual(seen, []);
  assert.equal(trapped, false);
  assert.match(controller.html(), /not been checked yet/);

  let invoked = false;
  const hostile = {};
  Object.defineProperty(hostile, 'code', {
    enumerable: true,
    get() { invoked = true; return 'bad-code'; },
  });
  wizard.checkOllama = async () => { throw hostile; };
  const result = await controller.handleMessage({ type: 'ollama' });
  assert.deepEqual(result, { handled: true, kind: 'ollama', ok: false });
  assert.equal(invoked, false);
  assert.match(controller.html(), /The setup action failed\./);

  wizard.checkOllama = async () => { throw new Proxy({ code: 'bad-code' }, { get() { trapped = true; return undefined; } }); };
  await controller.handleMessage({ type: 'ollama' });
  assert.equal(trapped, false);

  seen.length = 0;
  wizard.checkOllama = async () => summary;
  const proxied = await controller.handleMessage({ type: 'ollama' });
  assert.deepEqual(proxied, { handled: true, kind: 'ollama', ok: false });
  assert.deepEqual(seen, []);
});
test('an accessor-backed summary is never invoked while rendering', async (t) => {
  const vscode = createFakeVscode();
  let invoked = false;
  const summary = ollamaResult();
  Object.defineProperty(summary, 'available', {
    enumerable: true,
    get() { invoked = true; return true; },
  });
  const wizard = Object.assign(fakeWizard(), {
    view: () => baseView({ ollama: summary }),
    checkOllama: async () => summary,
  });
  const controller = createFirstRunController({
    vscode,
    extensionUri: { fsPath: 'x' },
    wizardProvider: () => wizard,
  });
  t.after(() => controller.dispose());
  await controller.open();
  assert.equal(invoked, false);
  assert.match(controller.html(), /No local .* daemon was found \(unavailable\)/);
});

test('the panel offers Use Ollama and renders the daemon start plan', async (t) => {
  const baseUrl = ollamaResult().baseUrl;
  const view = baseView({
    phase: 'ready',
    source: 'ollama',
    downloadBytes: 0,
    start: {
      available: true,
      kind: 'ollama',
      baseUrl,
      model: 'qwen2.5-coder:7b',
      embeddingModel: 'nomic-embed-text:latest',
    },
  });
  const { controller, wizard } = fixture(t, view);
  await controller.open();
  const html = controller.html();
  assert.match(html, /data-action="use-ollama" disabled>Use Ollama/);
  assert.match(html, /data-action="use-pinned">Use pinned models/);
  assert.match(html, /Ollama at <code>/);
  assert.match(html, /In use/);
  assert.match(html, /Embedding model/);

  const pinned = await controller.handleMessage({ type: 'use-pinned' });
  assert.equal(pinned.kind, 'use-pinned');
  assert.equal(pinned.ok, true);
  assert.equal(wizard.calls.usePinned, 1);
  assert.match(controller.html(), /pinned llama\.cpp models/);
});

test('the panel enables Use Ollama only when the daemon has provider options', async (t) => {
  const { controller, wizard } = fixture(t);
  await controller.open();
  assert.match(controller.html(), /data-action="use-ollama">Use Ollama/);
  const used = await controller.handleMessage({ type: 'use-ollama' });
  assert.equal(used.kind, 'use-ollama');
  assert.equal(used.ok, true);
  assert.equal(wizard.calls.useOllama, 1);
  assert.match(controller.html(), /existing [A-Za-z]+ models/);

  const disabled = renderFirstRunHtml(baseView({
    ollama: ollamaResult({ providerOptions: null, chatModel: null, reason: 'no-chat-model' }),
  }));
  assert.match(disabled, /data-action="use-ollama" disabled>Use Ollama/);

  const missing = fixture(t, baseView());
  delete missing.wizard.useOllama;
  await missing.controller.open();
  assert.deepEqual(
    await missing.controller.handleMessage({ type: 'use-ollama' }),
    { handled: false, reason: 'unknown-message' },
  );
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

test('the panel guards the daemon controls and escapes a hostile daemon plan', async (t) => {
  const hostile = renderFirstRunHtml(baseView({
    phase: 'ready',
    source: 'ollama',
    downloadBytes: 0,
    start: {
      available: true,
      kind: 'ollama',
      baseUrl: '"><img src=x onerror=alert(1)>',
      model: '<script>alert(2)</script>',
      embeddingModel: '<b>embed</b>',
    },
  }));
  assert.equal(hostile.includes('<img src=x'), false);
  assert.equal(hostile.includes('<script>alert(2)</script>'), false);
  assert.equal(hostile.includes('<b>embed</b>'), false);
  assert.match(hostile, /&lt;img src=x/);
  assert.match(hostile, /&lt;b&gt;embed&lt;\/b&gt;/);

  const pinnedMarkup = renderFirstRunHtml(baseView());
  assert.equal(pinnedMarkup.includes('data-action="use-pinned"'), false);

  const missing = fixture(t, baseView({ source: 'ollama' }));
  delete missing.wizard.usePinned;
  await missing.controller.open();
  assert.deepEqual(
    await missing.controller.handleMessage({ type: 'use-pinned' }),
    { handled: false, reason: 'unknown-message' },
  );
});

test('the panel reports the daemon start status and each selection refusal', async (t) => {
  const view = baseView({
    phase: 'ready',
    source: 'ollama',
    downloadBytes: 0,
    start: {
      available: true,
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5-coder:7b',
      embeddingModel: 'nomic-embed-text:latest',
    },
  });
  const { controller, wizard } = fixture(t, view);
  await controller.open();
  const started = await controller.handleMessage({ type: 'start' });
  assert.equal(started.ok, true);
  assert.deepEqual(controller.view().status, {
    message: 'The local runtime will use the Ollama daemon.',
    error: null,
  });

  const refusals = [
    [{ ok: false, reason: 'not-checked' }, 'Check for Ollama before selecting the daemon.'],
    [{ ok: false, reason: 'ollama-unavailable' }, 'No local Ollama chat model is available.'],
    [{ ok: false, reason: 'busy' }, 'A download is already running.'],
  ];
  for (const [result, message] of refusals) {
    wizard.useOllama = () => result;
    const outcome = await controller.handleMessage({ type: 'use-ollama' });
    assert.equal(outcome.ok, false);
    assert.deepEqual(controller.view().status, { message: null, error: message });
  }
});
