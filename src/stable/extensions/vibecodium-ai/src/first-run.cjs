'use strict';

// First-run setup panel. It renders the headless wizard view and forwards a small, bounded message
// vocabulary from the webview: check, download, start and Ollama detection. It never spawns a
// process itself, never reads a model file and never receives a secret.

const crypto = require('node:crypto');
const { types } = require('node:util');

const FIRST_RUN_PANEL_VERSION = 1;
const MAX_MESSAGE_BYTES = 64 * 1024;
const SAFE_NONCE = /^[A-Za-z0-9+/]+={0,2}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;
const PHASES = ['idle', 'probing', 'needs-download', 'downloading', 'ready', 'insufficient', 'failed'];
const STEP_STATES = ['done', 'active', 'blocked', 'failed', 'pending', 'ready'];

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

// Reads one own data field of a summary so a hostile wizard provider cannot run an accessor or a
// Proxy trap through the renderer.
function summaryField(value, key, fallback) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return fallback;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) return fallback;
    return descriptor.value;
  } catch {
    return fallback;
  }
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

function formatMilliseconds(value) {
  if (!Number.isInteger(value) || value < 0) return null;
  return value % 1000 === 0 ? String(value / 1000) + ' s' : String(value) + ' ms';
}

// The restart policy is display-only: the supervisor owns the behaviour. A missing, malformed or
// accessor-backed policy is omitted rather than throwing, so the panel stays renderable.
const RESTART_FIELDS = Object.freeze(['maxRestarts', 'baseDelayMs', 'maxDelayMs', 'stableMs']);

function isRestartShape(value) {
  if (!value || typeof value !== 'object') return false;
  try {
    if (types.isProxy(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(value);
    if (keys.length !== RESTART_FIELDS.length) return false;
    return keys.every(function (key) { return RESTART_FIELDS.includes(key); });
  } catch {
    return false;
  }
}

function renderRestart(restart) {
  if (!isRestartShape(restart)) return '';
  const maxRestarts = summaryField(restart, 'maxRestarts', null);
  const baseDelayMs = summaryField(restart, 'baseDelayMs', null);
  const maxDelayMs = summaryField(restart, 'maxDelayMs', null);
  const stableMs = summaryField(restart, 'stableMs', null);
  if (!Number.isInteger(maxRestarts) || maxRestarts < 1 || maxRestarts > 10) return '';
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 50 || baseDelayMs > 300000) return '';
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < 50 || maxDelayMs > 300000) return '';
  if (maxDelayMs < baseDelayMs) return '';
  if (!Number.isInteger(stableMs) || stableMs < 0 ||
    (stableMs !== 0 && (stableMs < 1000 || stableMs > 600000))) return '';
  const base = formatMilliseconds(baseDelayMs);
  const cap = formatMilliseconds(maxDelayMs);
  const stable = formatMilliseconds(stableMs);
  if (base === null || cap === null || stable === null) return '';
  const attempts = String(maxRestarts) + (maxRestarts === 1 ? ' time' : ' times');
  const reset = stableMs === 0
    ? 'a stable run never resets the count'
    : 'a run stable for ' + stable + ' resets the count';
  return '<p class="muted">Restarts automatically up to ' + escapeHtml(attempts) +
    ' with back-off from ' + escapeHtml(base) + ' to ' + escapeHtml(cap) + '; ' +
    escapeHtml(reset) + '.</p>';
}

function renderStart(start, runtime) {
  if (!start || typeof start !== 'object' || start.available !== true) {
    const configured = runtime !== null && runtime !== undefined &&
      typeof runtime === 'object' && !types.isProxy(runtime) &&
      summaryField(runtime, 'configured', false) === true;
    const reason = start && start.reason === 'runtime-not-bundled'
      ? configured
        ? 'The pinned llama.cpp runtime will be downloaded and verified when you start.'
        : 'The llama.cpp binary is not bundled yet.'
      : start && start.reason === 'runtime-install-failed'
        ? 'The pinned llama.cpp runtime could not be installed.'
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
    escapeHtml(String(start.gpuLayers)) + ' GPU layers.</p>' +
    renderRestart(summaryField(start, 'restart', null));
}

// The pinned runtime install has its own bounded progress; a hostile wizard cannot make the renderer
// walk an accessor or show an unbounded value.
function renderRuntimeProgress(runtime) {
  if (!runtime || typeof runtime !== 'object' || types.isProxy(runtime)) return '';
  const progress = summaryField(runtime, 'progress', null);
  if (!progress || typeof progress !== 'object' || types.isProxy(progress)) return '';
  const total = summaryField(progress, 'total', 0);
  const raw = summaryField(progress, 'received', 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  const received = Number.isFinite(raw) ? Math.max(0, Math.min(total, raw)) : 0;
  return '<p>Downloading the local runtime: ' + escapeHtml(formatBytes(received)) + ' of ' +
    escapeHtml(formatBytes(total)) + ' <progress max="' + escapeHtml(total) + '" value="' +
    escapeHtml(received) + '"></progress></p>';
}

function renderOllama(ollama, source) {
  if (!ollama || typeof ollama !== 'object' || types.isProxy(ollama)) {
    return '<p class="muted">Ollama has not been checked yet.</p>';
  }
  if (summaryField(ollama, 'available', false) === true) {
    const baseUrl = text(summaryField(ollama, 'baseUrl', null), '-');
    const chat = text(summaryField(ollama, 'chatModel', null), null);
    const embedding = text(summaryField(ollama, 'embeddingModel', null), null);
    const rawCount = summaryField(ollama, 'modelCount', 0);
    const count = Number.isInteger(rawCount) && rawCount >= 0 ? String(rawCount) : '0';
    const models = chat === null
      ? '<p class="muted">The daemon has no local chat model.</p>'
      : '<p>Chat model: <code>' + escapeHtml(chat) + '</code>' +
        (embedding === null ? '' : ' &middot; embedding model: <code>' + escapeHtml(embedding) + '</code>') +
        '</p>\n<p class="muted">' +
        (source === 'ollama'
          ? '<strong>In use</strong> for the local runtime.'
          : 'Reported for provider setup; use <strong>Use Ollama</strong> to serve from it.') +
        '</p>';
    return '<p>Found a local Ollama daemon at <code>' + escapeHtml(baseUrl) + '</code> with ' +
      escapeHtml(count) + ' model(s).</p>\n' + models;
  }
  return '<p class="muted">No local Ollama daemon was found (' +
    escapeHtml(text(summaryField(ollama, 'reason', null), 'unavailable')) + ').</p>';
}

// The embedding plan is display-only. A missing plan renders nothing (older views), and every value
// goes through the bounded text helper and the HTML escaper, so a hostile wizard cannot inject markup.
function embeddingFlags(args) {
  if (types.isProxy(args) || !Array.isArray(args)) return [];
  let length;
  try {
    length = args.length;
  } catch {
    return [];
  }
  if (!Number.isInteger(length) || length < 0) return [];
  const out = [];
  const limit = Math.min(length, 16);
  for (let index = 0; index < limit; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(args, String(index));
    } catch {
      continue;
    }
    if (!descriptor || !('value' in descriptor)) continue;
    const arg = text(descriptor.value, null);
    if (arg !== null) out.push(arg);
  }
  return out;
}

function renderEmbedding(embedding) {
  if (!embedding || typeof embedding !== 'object' || types.isProxy(embedding)) {
    return '<p class="muted">Finish the setup steps before planning the embedding server.</p>';
  }
  if (summaryField(embedding, 'available', false) !== true) {
    const reason = summaryField(embedding, 'reason', null);
    const message = reason === 'runtime-not-bundled'
      ? 'The pinned llama.cpp runtime is not installed yet.'
      : reason === 'no-embedding-model'
        ? 'The selected Ollama daemon has no embedding model.'
        : reason === 'disposed'
          ? 'The setup wizard is closed; open it again to plan the embedding server.'
          : 'Finish the setup steps before planning the embedding server.';
    return '<p class="muted">' + escapeHtml(message) + '</p>';
  }
  if (summaryField(embedding, 'kind', null) === 'ollama') {
    return '<p>Embedding model: <code>' +
      escapeHtml(text(summaryField(embedding, 'model', null), '-')) +
      '</code> from the Ollama daemon at <code>' +
      escapeHtml(text(summaryField(embedding, 'baseUrl', null), '-')) + '</code>.</p>';
  }
  const flags = embeddingFlags(summaryField(embedding, 'commandArgs', null));
  return '<p>Embedding server: <code>' +
    escapeHtml(text(summaryField(embedding, 'executablePath', null), '-')) +
    '</code> with model <code>' +
    escapeHtml(text(summaryField(embedding, 'modelPath', null), '-')) + '</code></p>' +
    (flags.length === 0
      ? ''
      : '<p class="muted">Flags: <code>' + escapeHtml(flags.join(' ')) + '</code></p>');
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
  const runtime = view.runtime && typeof view.runtime === 'object' ? view.runtime : null;
  const source = view.source === 'ollama' ? 'ollama' : 'pinned';
  const canUseDaemon = summaryField(view.ollama, 'available', false) === true &&
    summaryField(view.ollama, 'providerOptions', null) !== null;
  const installDisabled = phase === 'downloading' || phase === 'ready' || phase === 'insufficient' ||
    !(Number.isFinite(view.downloadBytes) && view.downloadBytes > 0);
  // A configured sidecar lets the start action install the runtime itself, so the button stays
  // usable while the plan still says `runtime-not-bundled`.
  const startDisabled = start.available !== true &&
    !(summaryField(runtime, 'configured', false) === true && phase === 'ready');
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
    renderRuntimeProgress(runtime) +
    '<h2>Models</h2>\n' + renderModels(view.models) +
    renderNotices(view.notices) +
    '<h2>Local runtime</h2>\n' + renderStart(start, runtime) +
    '<h2>Embedding server</h2>\n' + renderEmbedding(view.embedding) +
    '<h2>Ollama</h2>\n' + renderOllama(view.ollama, source) +
    '<div class="actions">\n' +
    '<button type="button" data-action="refresh">Check again</button>\n' +
    '<button type="button" data-action="install"' + (installDisabled ? ' disabled' : '') + '>Download models</button>\n' +
    '<button type="button" data-action="start"' + (startDisabled ? ' disabled' : '') + '>Start local runtime</button>\n' +
    '<button type="button" data-action="ollama">Check for Ollama</button>\n' +
    '<button type="button" data-action="use-ollama"' +
    (canUseDaemon && source !== 'ollama' ? '' : ' disabled') + '>Use Ollama</button>\n' +
    (source === 'ollama'
      ? '<button type="button" data-action="use-pinned">Use pinned models</button>\n'
      : '') +
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
  if (!error || typeof error !== 'object' || types.isProxy(error)) return fallback;
  let code;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (!descriptor || !('value' in descriptor)) return fallback;
    code = descriptor.value;
  } catch {
    return fallback;
  }
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : fallback;
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
      typeof value.startPlan !== 'function' ||
      typeof value.checkOllama !== 'function') {
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

  async function runOllamaCheck(announce) {
    let summary = null;
    try {
      summary = await wizard().checkOllama();
      if (announce) {
        status = summaryField(summary, 'available', false) === true
          ? { message: 'A local Ollama daemon answered.', error: null }
          : { message: 'No local Ollama daemon answered.', error: null };
      }
    } catch (error) {
      status = { message: null, error: publicError(error) };
    }
    render();
    return summary;
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
      if (type === 'ollama') {
        const summary = await runOllamaCheck(true);
        return { handled: true, kind: 'ollama', ok: summaryField(summary, 'available', false) === true };
      }
      if (type === 'start') {
        const active = wizard();
        // The wizard's start action installs the pinned runtime when it is missing; an older or
        // injected wizard without it keeps the read-only plan behaviour.
        const plan = typeof active.start === 'function' ? await active.start() : active.startPlan();
        if (plan && plan.available === true) {
          status = {
            message: plan.kind === 'ollama'
              ? 'The local runtime will use the Ollama daemon.'
              : 'The local runtime is ready to start.',
            error: null,
          };
        } else if (plan && plan.reason === 'runtime-not-bundled') {
          status = { message: null, error: 'The llama.cpp binary is not bundled yet.' };
        } else if (plan && plan.reason === 'runtime-install-failed') {
          status = { message: null, error: 'The pinned llama.cpp runtime could not be installed.' };
        } else if (plan && plan.reason === 'busy') {
          status = { message: null, error: 'A download is already running.' };
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
        } else if (result && result.reason === 'not-checked') {
          status = { message: null, error: 'Check for Ollama before selecting the daemon.' };
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
    await runOllamaCheck(false);
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
