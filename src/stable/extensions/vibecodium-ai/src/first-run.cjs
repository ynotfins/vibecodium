'use strict';

// First-run setup panel. It renders the headless wizard view and forwards a small, bounded message
// vocabulary from the webview: check, download and start. It never spawns a process itself, never
// reads a model file and never receives a secret.

const crypto = require('node:crypto');
const { types } = require('node:util');

const FIRST_RUN_PANEL_VERSION = 1;
const MAX_MESSAGE_BYTES = 64 * 1024;
const SAFE_NONCE = /^[A-Za-z0-9+/]+={0,2}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;
const PHASES = ['idle', 'probing', 'needs-download', 'downloading', 'ready', 'insufficient', 'failed'];
const STEP_STATES = ['done', 'active', 'blocked', 'failed', 'pending', 'ready'];
const OLLAMA_REASONS = new Map([
  ['unreachable', 'No Ollama daemon answered on the loopback port.'],
  ['timeout', 'The Ollama check timed out.'],
  ['http-error', 'Ollama answered with an unexpected status.'],
  ['invalid-response', 'Ollama answered with an invalid model list.'],
  ['policy-denied', 'The endpoint policy denied the local Ollama check.'],
  ['discovery-failed', 'The Ollama check could not be completed.'],
  ['invalid-result', 'The Ollama check returned an invalid result.'],
]);

class FirstRunPanelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FirstRunPanelError';
  }
}

function fail(message) {
  throw new FirstRunPanelError(message);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Built from character codes so the nonce-source token cannot be mangled by an editor or a
// display pipeline that rewrites the literal sequence.
function cspContent(nonce) {
  const open = String.fromCharCode(39) + "nonce-";
  const close = String.fromCharCode(39);
  return "default-src 'none'; style-src " + open + nonce + close +
    "; script-src " + open + nonce + close + "; base-uri 'none'; form-action 'none'";
}

function text(value, fallback) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !UNSAFE_TEXT.test(value)
    ? value
    : fallback;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : amount < 10 ? 1 : 0;
  return amount.toFixed(digits) + ' ' + units[unit];
}

function phaseLabel(phase) {
  if (phase === 'probing') return 'Checking this machine';
  if (phase === 'needs-download') return 'Models needed';
  if (phase === 'downloading') return 'Downloading models';
  if (phase === 'ready') return 'Ready';
  if (phase === 'insufficient') return 'Not enough memory';
  if (phase === 'failed') return 'Check failed';
  return 'Not started';
}

function safeStatus(value) {
  return STEP_STATES.includes(value) ? value : 'pending';
}

const STEP_LABELS = new Map([
  ['check', 'Hardware check'],
  ['models', 'Pinned models'],
  ['download', 'Model download'],
  ['runtime', 'Local runtime'],
]);

function renderSteps(steps) {
  if (!Array.isArray(steps)) return '';
  return steps.map(function (step) {
    if (!step || typeof step !== 'object') return '';
    const id = text(step.id, 'step');
    const status = safeStatus(step.status);
    const label = STEP_LABELS.has(id) ? STEP_LABELS.get(id) : id;
    return '<li class="step step-' + escapeHtml(status) + '" data-step="' + escapeHtml(id) + '">' +
      '<span class="badge">' + escapeHtml(status) + '</span> ' +
      escapeHtml(label) + '</li>';
  }).join('\n');
}

function renderModels(models) {
  if (!Array.isArray(models) || models.length === 0) return '<p class="muted">No pinned model is loaded yet.</p>';
  const rows = models.map(function (model) {
    if (!model || typeof model !== 'object') return '';
    const id = text(model.id, '-');
    const role = text(model.role, 'model');
    const state = model.installed === true ? 'Installed' : 'Needs download';
    return '<tr data-model="' + escapeHtml(id) + '">' +
      '<td><strong>' + escapeHtml(id) + '</strong><br><span class="muted">' + escapeHtml(role) + '</span></td>' +
      '<td>' + escapeHtml(formatBytes(model.sizeBytes)) + '</td>' +
      '<td>' + escapeHtml(state) + '</td></tr>';
  }).join('\n');
  return '<table>\n<thead><tr><th>Model</th><th>Size</th><th>State</th></tr></thead>\n<tbody>\n' +
    rows + '\n</tbody>\n</table>';
}

function renderNotices(notices) {
  if (!Array.isArray(notices) || notices.length === 0) return '';
  return '<h2>Notes</h2>\n<ul class="notices">\n' + notices.map(function (notice) {
    return '<li><code>' + escapeHtml(text(notice, '-')) + '</code></li>';
  }).join('\n') + '\n</ul>';
}

function renderProgress(progress) {
  if (!progress || typeof progress !== 'object') return '';
  const total = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : 0;
  const received = Number.isFinite(progress.received)
    ? Math.max(0, Math.min(total, progress.received))
    : 0;
  return '<p>Downloading <strong>' + escapeHtml(text(progress.modelId, 'model')) + '</strong>: ' +
    escapeHtml(formatBytes(received)) + ' of ' + escapeHtml(formatBytes(total)) + '</p>\n' +
    '<progress max="' + escapeHtml(total) + '" value="' + escapeHtml(received) + '"></progress>';
}

function renderOllama(ollama, source) {
  let body;
  if (!ollama || typeof ollama !== 'object') {
    body = '<p class="muted">Ollama has not been checked yet.</p>';
  } else if (ollama.available !== true) {
    const reason = text(ollama.reason, 'unknown');
    const line = OLLAMA_REASONS.get(reason) || 'Ollama is not available.';
    body = '<p class="muted">' + escapeHtml(line) + ' <code>' + escapeHtml(reason) + '</code></p>';
  } else if (typeof ollama.chatModel !== 'string' || ollama.chatModel.length === 0) {
    body = '<p class="muted">Ollama is running but has no local chat model installed.</p>';
  } else {
    const chat = text(ollama.chatModel, '-');
    const embedding = text(ollama.embeddingModel, null);
    const count = Number.isSafeInteger(ollama.modelCount) && ollama.modelCount >= 0 ? ollama.modelCount : 0;
    body = '<p>Ollama is running on <code>' + escapeHtml(text(ollama.baseUrl, '-')) + '</code> with ' +
      escapeHtml(String(count)) + ' model' + (count === 1 ? '' : 's') + '.<br>' +
      'Chat model: <code>' + escapeHtml(chat) + '</code>' +
      (embedding === null ? '' : '<br>Embedding model: <code>' + escapeHtml(embedding) + '</code>') +
      (source === 'ollama' ? ' <strong>(in use)</strong>' : '') + '</p>';
  }
  return '<h2>Existing local models</h2>\n' + body;
}

function renderStart(start) {
  if (!start || typeof start !== 'object' || start.available !== true) {
    const reason = start && start.reason === 'runtime-not-bundled'
      ? 'The llama.cpp binary is not bundled yet.'
      : 'Finish the setup steps before starting the local runtime.';
    return '<p class="muted">' + escapeHtml(reason) + '</p>';
  }
  if (start.kind === 'ollama') {
    return '<p>Ollama at <code>' + escapeHtml(text(start.baseUrl, '-')) + '</code><br>' +
      'Chat model: <code>' + escapeHtml(text(start.model, '-')) + '</code>' +
      (typeof start.embeddingModel === 'string'
        ? '<br>Embedding model: <code>' + escapeHtml(text(start.embeddingModel, '-')) + '</code>'
        : '') + '</p>';
  }
  return '<p>Chat model: <code>' + escapeHtml(text(start.modelPath, '-')) + '</code><br>' +
    'Context ' + escapeHtml(String(start.contextSize)) + ' tokens, ' +
    escapeHtml(String(start.threads)) + ' threads, ' +
    escapeHtml(String(start.gpuLayers)) + ' GPU layers.</p>';
}

function renderFirstRunHtml(view, status) {
  const state = status && typeof status === 'object' ? status : {};
  if (!view || typeof view !== 'object') {
    const fallbackNonce = crypto.randomBytes(18).toString('base64');
    if (!SAFE_NONCE.test(fallbackNonce)) fail('could not create a panel nonce');
    return '<!doctype html>\n<html><head>\n<meta charset="utf-8">\n' +
      '<meta http-equiv="Content-Security-Policy" content="' + cspContent(fallbackNonce) + '">\n' +
      '</head><body><p>First-run setup is not available.</p></body></html>';
  }
  const nonce = crypto.randomBytes(18).toString('base64');
  if (!SAFE_NONCE.test(nonce)) fail('could not create a panel nonce');
  const phase = PHASES.includes(view.phase) ? view.phase : 'idle';
  const statusBlock = state.message
    ? '<p class="status" role="status">' + escapeHtml(text(state.message, 'Updated.')) + '</p>'
    : '';
  const errorBlock = state.error
    ? '<p class="error" role="alert">' + escapeHtml(text(state.error, 'The action failed.')) + '</p>'
    : '';
  const viewError = view.error && typeof view.error === 'object'
    ? '<p class="error" role="alert">' + escapeHtml(text(view.error.message, 'The first-run check failed.')) + '</p>'
    : '';
  const start = view.start && typeof view.start === 'object' ? view.start : { available: false };
  const source = view.source === 'ollama' ? 'ollama' : 'pinned';
  const ollamaReady = Boolean(view.ollama) && view.ollama.available === true &&
    typeof view.ollama.chatModel === 'string' && view.ollama.chatModel.length > 0;
  const installDisabled = phase === 'downloading' || phase === 'ready' || phase === 'insufficient' ||
    !(Number.isFinite(view.downloadBytes) && view.downloadBytes > 0);
  const startDisabled = start.available !== true;
  const verdict = text(view.verdict, 'unknown');
  const acceleration = text(view.acceleration, 'unknown');
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta http-equiv="Content-Security-Policy" content="' + cspContent(nonce) + '">\n' +
    '<title>Vibecodium Setup</title>\n<style nonce="' + nonce + '">' +
    'body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)}' +
    'h1{margin:0 0 .25em}.muted{opacity:.7}.status{color:var(--vscode-testing-iconPassed)}' +
    '.error{color:var(--vscode-errorForeground)}table{border-collapse:collapse;width:100%;margin:12px 0}' +
    'td,th{border-bottom:1px solid var(--vscode-panel-border);padding:6px;text-align:left;vertical-align:top}' +
    'ol.steps{list-style:none;padding:0}li.step{margin:4px 0}.badge{display:inline-block;min-width:5em;' +
    'padding:1px 6px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:.85em}' +
    '.step-done .badge{background:var(--vscode-testing-iconPassed);color:#fff}' +
    '.step-failed .badge,.step-blocked .badge{background:var(--vscode-errorForeground);color:#fff}' +
    '.actions{display:flex;gap:8px;margin:12px 0}button{padding:4px 12px}' +
    'progress{width:100%;max-width:32em}code{font-family:var(--vscode-editor-font-family)}' +
    '</style>\n</head>\n<body>\n<h1>Vibecodium Setup</h1>\n' +
    '<p><strong>' + escapeHtml(phaseLabel(phase)) + '</strong>' +
    (view.verdict ? ' &middot; ' + escapeHtml(verdict) + ' (' + escapeHtml(acceleration) + ')' : '') + '</p>\n' +
    statusBlock + errorBlock + viewError +
    '<ol class="steps">\n' + renderSteps(view.steps) + '\n</ol>\n' +
    renderProgress(view.progress) +
    '<h2>Models</h2>\n' + renderModels(view.models) +
    renderNotices(view.notices) +
    renderOllama(view.ollama, source) +
    '<h2>Local runtime</h2>\n' + renderStart(start) +
    '<div class="actions">\n' +
    '<button type="button" data-action="refresh">Check again</button>\n' +
    '<button type="button" data-action="install"' + (installDisabled ? ' disabled' : '') + '>Download models</button>\n' +
    '<button type="button" data-action="use-ollama"' + (ollamaReady && source !== 'ollama' ? '' : ' disabled') +
    '>Use Ollama</button>\n' +
    (source === 'ollama'
      ? '<button type="button" data-action="use-pinned">Use pinned models</button>\n'
      : '') +
    '<button type="button" data-action="start"' + (startDisabled ? ' disabled' : '') + '>Start local runtime</button>\n' +
    '</div>\n<script nonce="' + nonce + '">\n' +
    '(function () {\n' +
    '  const api = acquireVsCodeApi();\n' +
    '  document.body.addEventListener("click", function (event) {\n' +
    '    const button = event.target.closest("button[data-action]");\n' +
    '    if (!button || button.disabled) return;\n' +
    '    api.postMessage({ type: button.getAttribute("data-action") });\n' +
    '  });\n' +
    '}());\n' +
    '</script>\n</body>\n</html>\n';
}

function publicError(error) {
  const fallback = 'The setup action failed.';
  if (error && typeof error.code === 'string' && SAFE_CODE.test(error.code)) {
    return error.code;
  }
  return fallback;
}

function createFirstRunController(input) {
  if (!input || typeof input !== 'object') fail('controller options must be an object');
  const vscode = input.vscode;
  const wizardProvider = input.wizardProvider;
  const extensionUri = input.extensionUri;
  if (!vscode || typeof vscode !== 'object') fail('vscode is required');
  if (typeof wizardProvider !== 'function') fail('wizardProvider is required');
  let panel = null;
  let status = { message: null, error: null };

  function wizard() {
    const value = wizardProvider();
    if (!value || typeof value !== 'object' ||
      typeof value.view !== 'function' ||
      typeof value.refresh !== 'function' ||
      typeof value.install !== 'function' ||
      typeof value.startPlan !== 'function') {
      fail('the first-run wizard is not available');
    }
    return value;
  }

  function render() {
    if (!panel) return;
    try {
      panel.webview.html = renderFirstRunHtml(wizard().view(), status);
    } catch (error) {
      status = { message: null, error: publicError(error) };
      panel.webview.html = renderFirstRunHtml(null, status);
    }
  }

  async function runRefresh() {
    try {
      await wizard().refresh();
      status = { message: 'First-run check complete.', error: null };
    } catch (error) {
      status = { message: null, error: publicError(error) };
    }
    render();
  }

  async function handle(raw) {
    if (!raw || typeof raw !== 'object') {
      return { handled: false, reason: 'invalid-message' };
    }
    if (types.isProxy(raw)) return { handled: false, reason: 'invalid-message' };
    if (Array.isArray(raw)) return { handled: false, reason: 'invalid-message' };
    let prototype;
    try {
      prototype = Object.getPrototypeOf(raw);
    } catch {
      return { handled: false, reason: 'invalid-message' };
    }
    if (prototype !== Object.prototype && prototype !== null) {
      return { handled: false, reason: 'invalid-message' };
    }
    let names;
    try {
      names = Object.keys(raw);
    } catch {
      return { handled: false, reason: 'invalid-message' };
    }
    if (names.length !== 1 || names[0] !== 'type') {
      return { handled: false, reason: 'invalid-message' };
    }
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(raw, 'type');
    } catch {
      return { handled: false, reason: 'invalid-message' };
    }
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      return { handled: false, reason: 'invalid-message' };
    }
    if (Buffer.byteLength(descriptor.value, 'utf8') > MAX_MESSAGE_BYTES) {
      return { handled: false, reason: 'message-too-large' };
    }
    const type = descriptor.value;
    try {
      if (type === 'refresh') {
        await runRefresh();
        return { handled: true, kind: 'refresh' };
      }
      if (type === 'install') {
        const result = await wizard().install();
        if (result && result.ok === true) {
          status = {
            message: result.reason === 'ollama-selected'
              ? 'The local runtime will use your existing Ollama models.'
              : result.reason === 'already-installed'
                ? 'The pinned models are already installed.'
                : 'The pinned models were downloaded and verified.',
            error: null,
          };
        } else if (result && result.reason === 'insufficient') {
          status = { message: null, error: 'This machine does not have enough memory for the local model.' };
        } else if (result && result.reason === 'busy') {
          status = { message: null, error: 'A download is already running.' };
        } else {
          status = { message: null, error: publicError(result) };
        }
        render();
        return { handled: true, kind: 'install', ok: Boolean(result && result.ok === true) };
      }
      if (type === 'start') {
        const plan = wizard().startPlan();
        if (plan && plan.available === true) {
          status = {
            message: plan.kind === 'ollama'
              ? 'The local runtime will use the Ollama daemon.'
              : 'The local runtime is ready to start.',
            error: null,
          };
        } else if (plan && plan.reason === 'runtime-not-bundled') {
          status = { message: null, error: 'The llama.cpp binary is not bundled yet.' };
        } else {
          status = { message: null, error: 'Finish the setup steps before starting the local runtime.' };
        }
        render();
        return { handled: true, kind: 'start', ok: Boolean(plan && plan.available === true) };
      }
      if (type === 'use-ollama' || type === 'use-pinned') {
        const method = type === 'use-ollama' ? 'useOllama' : 'usePinned';
        const active = wizard();
        if (typeof active[method] !== 'function') {
          return { handled: false, reason: 'unknown-message' };
        }
        const result = active[method]();
        if (result && result.ok === true) {
          status = {
            message: type === 'use-ollama'
              ? 'The local runtime will use your existing Ollama models.'
              : 'The setup will use the pinned llama.cpp models.',
            error: null,
          };
        } else if (result && result.reason === 'ollama-unavailable') {
          status = { message: null, error: 'No local Ollama chat model is available.' };
        } else if (result && result.reason === 'busy') {
          status = { message: null, error: 'A download is already running.' };
        } else {
          status = { message: null, error: publicError(result) };
        }
        render();
        return { handled: true, kind: type, ok: Boolean(result && result.ok === true) };
      }
      return { handled: false, reason: 'unknown-message' };
    } catch (error) {
      status = { message: null, error: publicError(error) };
      render();
      return { handled: true, kind: 'error', code: publicError(error) };
    }
  }

  async function open() {
    try {
      wizard();
    } catch {
      vscode.window.showInformationMessage('Vibe Setup: the first-run wizard is not connected yet.');
      return { opened: false, reason: 'no-wizard' };
    }
    if (panel) {
      render();
      panel.reveal();
      return { opened: false };
    }
    panel = vscode.window.createWebviewPanel('vibecodium.firstRun', 'Vibe Setup', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: extensionUri ? [extensionUri] : [],
    });
    panel.webview.onDidReceiveMessage(function (message) {
      handle(message).catch(function () {
        if (panel) vscode.window.showWarningMessage('Vibe Setup: the action could not be completed.');
      });
    });
    panel.onDidDispose(function () {
      panel = null;
    });
    render();
    await runRefresh();
    return { opened: true };
  }

  function view() {
    let base;
    try {
      base = wizard().view();
    } catch {
      return null;
    }
    return Object.assign({}, base, { status: Object.assign({}, status) });
  }

  function html() {
    return panel ? panel.webview.html : null;
  }

  function dispose() {
    if (panel) panel.dispose();
  }

  return {
    version: FIRST_RUN_PANEL_VERSION,
    open: open,
    view: view,
    html: html,
    handleMessage: handle,
    dispose: dispose,
  };
}

module.exports = {
  FIRST_RUN_PANEL_VERSION: FIRST_RUN_PANEL_VERSION,
  FirstRunPanelError: FirstRunPanelError,
  createFirstRunController: createFirstRunController,
  renderFirstRunHtml: renderFirstRunHtml,
};
