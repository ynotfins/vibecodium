'use strict';

const crypto = require('node:crypto');

const MEMORY_REVIEW_VERSION = 1;
const MAX_REVIEW_ITEMS = 500;
const DEFAULT_REVIEW_LIMIT = 100;
const MAX_KEY = 200;
const MAX_VALUE = 16_000;
const MAX_PREVIEW = 2_000;
const MAX_SESSION_ID = 200;
const MAX_ID = 128;
const MAX_COUNT = 10_000_000;
const MAX_VALUE_NODES = 50_000;
const MAX_VALUE_CHARS_TOTAL = 64_000;
const MAX_TIMESTAMP = 64;
const MAX_OBJECT_KEY = 1_000;
const SCOPES = new Set(['user', 'project']);
const STATUSES = new Set(['pending', 'approved', 'rejected', 'all']);
const ENTRY_STATUSES = new Set(['pending', 'approved', 'rejected']);
const ORIGINS = new Set(['user', 'agent']);
const SOURCE_TRUST = 'untrusted-memory-content';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

class MemoryReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryReviewError';
  }
}

function fail(message) {
  throw new MemoryReviewError(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, maximum, label, options = {}) {
  if (typeof value !== 'string') fail(label + ' must be a string');
  if (value.length > maximum) fail(label + ' exceeds ' + maximum + ' characters');
  if (CONTROL_CHARS.test(value)) fail(label + ' contains control characters');
  if (options.nonEmpty && value.trim().length === 0) fail(label + ' must not be empty');
  return value;
}

function count(value, label, maximum = MAX_COUNT) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    fail(label + ' must be an integer between 0 and ' + maximum);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value.length > MAX_TIMESTAMP || Number.isNaN(Date.parse(value))) {
    fail('invalid ' + label);
  }
  return value;
}

function cloneJson(value, state = { nodes: 0 }, depth = 1) {
  state.nodes += 1;
  if (state.nodes > MAX_VALUE_NODES) fail('memory value exceeds ' + MAX_VALUE_NODES + ' nodes');
  if (depth > 32) fail('memory value nesting exceeds 32');
  if (typeof value === 'string') {
    if (value.length > MAX_VALUE) fail('memory value exceeds ' + MAX_VALUE + ' characters');
    if (CONTROL_CHARS.test(value)) fail('memory value contains control characters');
    state.chars = (state.chars || 0) + value.length;
    if (state.chars > MAX_VALUE_CHARS_TOTAL) fail('memory value exceeds the aggregate character budget');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('memory value is not a finite JSON number');
    return value;
  }
  if (value === null) return null;
  if (typeof value !== 'object') fail('memory value is not JSON-safe');
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) result.push(cloneJson(item, state, depth + 1));
    return result;
  }
  if (!isPlainObject(value)) fail('memory value is not JSON-safe');
  if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) fail('memory value is not JSON-safe');
  if (Object.getOwnPropertySymbols(value).length > 0) fail('memory value is not JSON-safe');
  const result = {};
  for (const key of Object.keys(value)) {
    text(key, MAX_OBJECT_KEY, 'memory value key');
    result[key] = cloneJson(value[key], state, depth + 1);
  }
  return result;
}

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function previewOf(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw === undefined) return '';
  return raw.length > MAX_PREVIEW ? raw.slice(0, MAX_PREVIEW) + '...' : raw;
}

function validateEntry(entry, pageScope) {
  if (!isPlainObject(entry)) fail('memory entry must be an object');
  const allowed = new Set([
    'id', 'scope', 'key', 'value', 'status', 'revision', 'origin',
    'createdAt', 'updatedAt', 'sessionId', 'sourceTrust',
  ]);
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) fail('memory entry has an unknown field');
  }
  if (typeof entry.id !== 'string' || !SAFE_ID.test(entry.id)) fail('invalid memory entry id');
  if (!SCOPES.has(entry.scope) || entry.scope !== pageScope) fail('memory entry scope does not match the page');
  text(entry.key, MAX_KEY, 'memory entry key', { nonEmpty: true });
  const value = cloneJson(entry.value);
  if (!ENTRY_STATUSES.has(entry.status)) fail('invalid memory entry status');
  if (!Number.isInteger(entry.revision) || entry.revision < 1 || entry.revision > MAX_COUNT) {
    fail('memory entry revision must be a positive integer');
  }
  if (!ORIGINS.has(entry.origin)) fail('invalid memory entry origin');
  timestamp(entry.createdAt, 'memory entry createdAt');
  timestamp(entry.updatedAt, 'memory entry updatedAt');
  if (entry.sessionId !== undefined) {
    text(entry.sessionId, MAX_SESSION_ID, 'memory entry sessionId', { nonEmpty: true });
  }
  if (entry.sourceTrust !== SOURCE_TRUST) fail('memory entry sourceTrust is invalid');
  return {
    id: entry.id,
    scope: entry.scope,
    key: entry.key,
    value,
    status: entry.status,
    revision: entry.revision,
    origin: entry.origin,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    sessionId: entry.sessionId,
    sourceTrust: SOURCE_TRUST,
  };
}

function validatePage(page) {
  if (!isPlainObject(page)) fail('memory review page must be an object');
  const allowed = new Set(['scope', 'status', 'total', 'offset', 'limit', 'hasMore', 'items']);
  for (const key of Object.keys(page)) {
    if (!allowed.has(key)) fail('memory review page has an unknown field');
  }
  if (!SCOPES.has(page.scope)) fail('memory review scope must be "user" or "project"');
  if (!STATUSES.has(page.status)) fail('memory review status is invalid');
  count(page.total, 'memory review total');
  count(page.offset, 'memory review offset');
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_REVIEW_ITEMS) {
    fail('memory review limit must be between 1 and ' + MAX_REVIEW_ITEMS);
  }
  if (typeof page.hasMore !== 'boolean') fail('memory review hasMore must be a boolean');
  if (!Array.isArray(page.items)) fail('memory review items must be an array');
  if (page.items.length > page.limit || page.items.length > MAX_REVIEW_ITEMS) {
    fail('memory review page exceeds the item cap');
  }
  const items = page.items.map((entry) => validateEntry(entry, page.scope));
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.id)) fail('memory review page has duplicate ids');
    ids.add(item.id);
  }
  if (page.offset + items.length > page.total) fail('memory review page exceeds the total');
  if (page.hasMore !== page.offset + items.length < page.total) fail('memory review hasMore is inconsistent');
  return {
    scope: page.scope,
    status: page.status,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    items,
  };
}

class MemoryReviewModel {
  constructor(page, options = {}) {
    if (!isPlainObject(options)) fail('memory review options must be an object');
    this.page = validatePage(page);
    this.selectedId = null;
    if (options.selectedId !== undefined) this.select(options.selectedId);
  }

  select(id) {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) fail('selected memory id is invalid');
    if (!this.page.items.some((item) => item.id === id)) fail('selected memory id is not on this page');
    this.selectedId = id;
    return this.view().selected;
  }

  view() {
    const counts = { pending: 0, approved: 0, rejected: 0 };
    const items = this.page.items.map((item) => {
      counts[item.status] += 1;
      return {
        id: item.id,
        scope: item.scope,
        key: item.key,
        status: item.status,
        revision: item.revision,
        origin: item.origin,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        sessionId: item.sessionId,
        valuePreview: previewOf(item.value),
        valueKind: kindOf(item.value),
        selected: item.id === this.selectedId,
      };
    });
    const selected = items.find((item) => item.selected) || null;
    return {
      version: MEMORY_REVIEW_VERSION,
      scope: this.page.scope,
      status: this.page.status,
      total: this.page.total,
      offset: this.page.offset,
      limit: this.page.limit,
      hasMore: this.page.hasMore,
      counts,
      items,
      selected,
      empty: items.length === 0,
    };
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function createNonce() {
  return crypto.randomBytes(16).toString('base64url');
}

function renderActionButton(action, label, item) {
  return '<button type="button" class="memory-action" data-action="' + escapeHtml(action) +
    '" data-id="' + escapeHtml(item.id) + '" data-revision="' + item.revision + '">' +
    escapeHtml(label) + '</button>';
}

function renderItem(item) {
  const meta = [
    'revision ' + item.revision,
    item.origin,
    'updated ' + item.updatedAt,
  ];
  if (item.sessionId) meta.push('session ' + item.sessionId);
  return [
    '<li class="memory-item' + (item.selected ? ' selected' : '') + '" data-id="' + escapeHtml(item.id) + '">',
    '<div class="memory-head">',
    '<span class="memory-key">' + escapeHtml(item.key) + '</span>',
    '<span class="memory-status status-' + escapeHtml(item.status) + '">' + escapeHtml(item.status) + '</span>',
    '</div>',
    '<pre class="memory-value" aria-label="Memory value">' + escapeHtml(item.valuePreview) + '</pre>',
    '<p class="memory-meta">' + escapeHtml(meta.join(' - ')) + '</p>',
    '<div class="memory-actions">',
    renderActionButton('approve', 'Approve', item),
    renderActionButton('reject', 'Reject', item),
    renderActionButton('forget', 'Forget', item),
    '</div>',
    '</li>',
  ].join('');
}

function filterButton(action, label, pressed, attributes) {
  return '<button type="button" data-action="' + action + '"' + attributes +
    ' aria-pressed="' + (pressed ? 'true' : 'false') + '">' + escapeHtml(label) + '</button>';
}

function validateView(view) {
  if (!isPlainObject(view)) fail('memory review view must be an object');
  if (view.version !== MEMORY_REVIEW_VERSION) fail('memory review view version is invalid');
  if (!SCOPES.has(view.scope)) fail('memory review view scope is invalid');
  if (!STATUSES.has(view.status)) fail('memory review view status is invalid');
  count(view.total, 'memory review view total');
  count(view.offset, 'memory review view offset');
  if (!Number.isInteger(view.limit) || view.limit < 1 || view.limit > MAX_REVIEW_ITEMS) {
    fail('memory review view limit is invalid');
  }
  if (typeof view.hasMore !== 'boolean') fail('memory review view hasMore is invalid');
  if (!isPlainObject(view.counts)) fail('memory review view counts are invalid');
  for (const key of ['pending', 'approved', 'rejected']) count(view.counts[key], 'memory review count ' + key);
  if (!Array.isArray(view.items)) fail('memory review view items are invalid');
  if (view.items.length > MAX_REVIEW_ITEMS || view.items.length > view.limit) {
    fail('memory review view exceeds the item cap');
  }
  const ids = new Set();
  for (const item of view.items) {
    if (!isPlainObject(item)) fail('memory review view item is invalid');
    if (typeof item.id !== 'string' || !SAFE_ID.test(item.id)) fail('memory review view item id is invalid');
    if (ids.has(item.id)) fail('memory review view has duplicate ids');
    ids.add(item.id);
    text(item.key, MAX_KEY, 'memory review view key');
    if (!ENTRY_STATUSES.has(item.status)) fail('memory review view item status is invalid');
    if (!Number.isInteger(item.revision) || item.revision < 1 || item.revision > MAX_COUNT) {
      fail('memory review view item revision is invalid');
    }
    if (!ORIGINS.has(item.origin)) fail('memory review view item origin is invalid');
    timestamp(item.updatedAt, 'memory review view item updatedAt');
    text(item.valuePreview, MAX_PREVIEW + 3, 'memory review view value preview');
    if (item.sessionId !== undefined) {
      text(item.sessionId, MAX_SESSION_ID, 'memory review view item sessionId');
    }
  }
}

function renderMemoryReviewHtml(view, options = {}) {
  validateView(view);
  if (!isPlainObject(options)) fail('memory review render options must be an object');
  const nonce = options.nonce === undefined ? createNonce() : text(options.nonce, 128, 'nonce');
  if (!SAFE_NONCE.test(nonce)) fail('nonce is invalid');
  const notice = options.notice === undefined ? '' : text(options.notice, 300, 'notice');

  const scopeButtons = ['project', 'user'].map((scope) => filterButton(
    'filter',
    scope === 'project' ? 'Project memory' : 'User memory',
    view.scope === scope,
    ' data-scope="' + scope + '"',
  )).join('');
  const statusButtons = ['pending', 'approved', 'rejected', 'all'].map((status) => filterButton(
    'filter',
    status === 'all' ? 'All' : status[0].toUpperCase() + status.slice(1),
    view.status === status,
    ' data-status="' + status + '"',
  )).join('');
  const items = view.items.map(renderItem).join('');
  const empty = view.items.length === 0
    ? '<p class="empty" role="status">No memory facts match this filter.</p>'
    : '';
  const pager = [
    '<div class="pager" aria-label="Review pages">',
    '<button type="button" data-action="page" data-offset="' + Math.max(0, view.offset - view.limit) + '"' +
      (view.offset === 0 ? ' disabled' : '') + '>Previous</button>',
    '<span>Showing ' + view.items.length + ' of ' + view.total + ' facts at offset ' + view.offset + '</span>',
    '<button type="button" data-action="page" data-offset="' + (view.offset + view.items.length) + '"' +
      (view.hasMore ? '' : ' disabled') + '>Next</button>',
    '</div>',
  ].join('');
  const csp = "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce +
    "'; img-src 'none'; base-uri 'none'; form-action 'none';";
  const script = [
    'const vscode = acquireVsCodeApi();',
    "document.addEventListener('click', (event) => {",
    "  const button = event.target.closest('button[data-action]');",
    '  if (!button) return;',
    "  const action = button.getAttribute('data-action');",
    "  if (action === 'page') {",
    "    vscode.postMessage({ type: 'page', offset: Number(button.getAttribute('data-offset')) });",
    '    return;',
    '  }',
    "  if (action === 'filter') {",
    "    const message = { type: 'filter' };",
    "    const scope = button.getAttribute('data-scope');",
    "    const status = button.getAttribute('data-status');",
    '    if (scope) message.scope = scope;',
    '    if (status) message.status = status;',
    '    vscode.postMessage(message);',
    '    return;',
    '  }',
    "  vscode.postMessage({ type: 'action', action, id: button.getAttribute('data-id'),",
    "    revision: Number(button.getAttribute('data-revision')) });",
    '});',
  ].join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<title>Vibe Memory</title>',
    '<style nonce="' + nonce + '">',
    'body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); margin: 0; }',
    'header { padding: 14px 18px 8px; border-bottom: 1px solid var(--vscode-panel-border); }',
    'header h1 { font-size: 16px; margin: 0 0 10px; }',
    'nav { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }',
    'button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 4px 10px; cursor: pointer; }',
    'button:hover { background: var(--vscode-button-hoverBackground); }',
    'button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }',
    'button[aria-pressed="true"] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }',
    'button:disabled { opacity: .5; cursor: default; }',
    'main { padding: 14px 18px 24px; }',
    '.pager { display: flex; gap: 10px; align-items: center; margin: 0 0 12px; color: var(--vscode-descriptionForeground); }',
    '.memory-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }',
    '.memory-item { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; }',
    '.memory-item.selected { border-color: var(--vscode-focusBorder); }',
    '.memory-head { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; }',
    '.memory-key { font-weight: 600; overflow-wrap: anywhere; }',
    '.memory-status { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }',
    '.memory-value { margin: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; }',
    '.memory-meta { margin: 6px 0; font-size: 11px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }',
    '.memory-actions { display: flex; gap: 8px; flex-wrap: wrap; }',
    '.empty, .notice { color: var(--vscode-descriptionForeground); }',
    '.notice { margin: 0 0 10px; }',
    '.status-filter { margin-top: 6px; }',
    '</style>',
    '</head>',
    '<body>',
    '<header>',
    '<h1>Vibe Memory <span class="memory-meta">review</span></h1>',
    '<nav aria-label="Memory scope">' + scopeButtons + '</nav>',
    '<nav class="status-filter" aria-label="Review status">' + statusButtons + '</nav>',
    '</header>',
    '<main>',
    notice ? '<p class="notice" role="status">' + escapeHtml(notice) + '</p>' : '',
    pager,
    empty,
    items ? '<ul class="memory-list" aria-label="Memory facts">' + items + '</ul>' : '',
    '</main>',
    '<script nonce="' + nonce + '">',
    script,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

function createMemoryReviewController(input = {}) {
  if (!isPlainObject(input)) fail('controller options must be an object');
  const {
    vscode,
    storeProvider,
    extensionUri,
    limit = DEFAULT_REVIEW_LIMIT,
    scope = 'project',
    status = 'pending',
  } = input;
  if (!vscode || typeof vscode !== 'object') fail('vscode is required');
  if (typeof storeProvider !== 'function') fail('storeProvider is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REVIEW_ITEMS) fail('limit is invalid');
  if (!SCOPES.has(scope)) fail('scope is invalid');
  if (!STATUSES.has(status)) fail('status is invalid');

  let panel = null;
  let model = null;
  let currentScope = scope;
  let currentStatus = status;
  let currentOffset = 0;
  let lastNotice = '';

  function readStore() {
    const store = storeProvider();
    return store && typeof store === 'object' ? store : null;
  }

  function storeMethod(store, name) {
    return store && typeof store[name] === 'function' ? store[name].bind(store) : null;
  }

  async function loadPage() {
    const store = readStore();
    if (!store) {
      model = null;
      return false;
    }
    const review = storeMethod(store, 'review');
    if (!review) fail('memory store does not provide review()');
    const page = await review({ scope: currentScope, status: currentStatus, offset: currentOffset, limit });
    model = new MemoryReviewModel(page);
    lastNotice = '';
    return true;
  }

  function refresh() {
    if (panel && model) {
      panel.webview.html = renderMemoryReviewHtml(model.view(), { notice: lastNotice });
    }
  }

  async function open() {
    const store = readStore();
    if (!panel) {
      if (!store) {
        vscode.window.showInformationMessage('Vibe Memory: no memory store is connected yet.');
        return { opened: false, reason: 'no-store' };
      }
      try {
        await loadPage();
      } catch (error) {
        vscode.window.showWarningMessage('Vibe Memory: the review queue could not be loaded.');
        return { opened: false, reason: 'load-failed' };
      }
      panel = vscode.window.createWebviewPanel('vibecodium.memory', 'Vibe Memory', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: extensionUri ? [extensionUri] : [],
      });
      panel.webview.onDidReceiveMessage(async (message) => {
        try {
          await handle(message);
        } catch (error) {
          if (panel) vscode.window.showWarningMessage('Vibe Memory: the review action could not be completed.');
        }
      });
      panel.onDidDispose(() => {
        panel = null;
        model = null;
      });
      refresh();
      return { opened: true };
    }
    let loaded = false;
    try {
      loaded = await loadPage();
    } catch (error) {
      vscode.window.showWarningMessage('Vibe Memory: the review queue could not be reloaded.');
      return { opened: true, refreshed: false, reason: 'load-failed' };
    }
    if (!loaded) {
      vscode.window.showWarningMessage('Vibe Memory: the memory store is no longer connected.');
      return { opened: true, refreshed: false, reason: 'no-store' };
    }
    refresh();
    panel.reveal();
    return { opened: true, refreshed: true };
  }

  async function reload() {
    if (!panel) return { handled: false, reason: 'closed' };
    let loaded = false;
    try {
      loaded = await loadPage();
    } catch (error) {
      lastNotice = 'The review queue could not be reloaded.';
      refresh();
      return { handled: true, ok: false, code: 'load-failed' };
    }
    if (!loaded) {
      vscode.window.showWarningMessage('Vibe Memory: the memory store is no longer connected.');
      return { handled: true, ok: false, code: 'no-store' };
    }
    refresh();
    return { handled: true, ok: true };
  }

  async function runAction(message) {
    const action = message.action;
    if (!['approve', 'reject', 'forget'].includes(action)) return { handled: false, reason: 'invalid-message' };
    if (typeof message.id !== 'string' || !SAFE_ID.test(message.id)) {
      return { handled: false, reason: 'invalid-message' };
    }
    if (!Number.isInteger(message.revision) || message.revision < 1) {
      return { handled: false, reason: 'invalid-message' };
    }
    if (!model) return { handled: false, reason: 'no-page' };
    const item = model.view().items.find((entry) => entry.id === message.id);
    if (!item) return { handled: true, ok: false, code: 'not-found' };
    if (item.revision !== message.revision) {
      lastNotice = 'This fact changed since the panel was loaded. Refresh and review it again.';
      refresh();
      return { handled: true, ok: false, code: 'stale-view' };
    }
    const store = readStore();
    const method = storeMethod(store, action);
    if (!method) {
      lastNotice = 'The memory store cannot apply that review action.';
      refresh();
      return { handled: true, ok: false, code: 'no-store' };
    }
    try {
      await method(item.scope, item.id, item.revision);
    } catch (error) {
      const code = error && /revision changed/i.test(String(error.message)) ? 'revision-changed' : 'action-failed';
      lastNotice = code === 'revision-changed'
        ? 'This fact changed since the panel was loaded. Refresh and review it again.'
        : 'The review action failed. The fact was not changed.';
      refresh();
      vscode.window.showWarningMessage('Vibe Memory: ' + lastNotice);
      return { handled: true, ok: false, code };
    }
    let loaded = false;
    try {
      loaded = await loadPage();
    } catch (error) {
      lastNotice = 'The fact was updated, but the review queue could not be reloaded.';
      refresh();
      return { handled: true, ok: true, kind: action, id: item.id, refreshed: false };
    }
    if (!loaded) {
      return { handled: true, ok: true, kind: action, id: item.id, refreshed: false, reason: 'no-store' };
    }
    refresh();
    return { handled: true, ok: true, kind: action, id: item.id };
  }

  async function handle(message) {
    if (!isPlainObject(message)) return { handled: false, reason: 'invalid-message' };
    if (message.type === 'refresh') return reload();
    if (message.type === 'page') {
      if (!Number.isInteger(message.offset) || message.offset < 0 || message.offset > MAX_COUNT) {
        return { handled: false, reason: 'invalid-message' };
      }
      currentOffset = message.offset;
      return reload();
    }
    if (message.type === 'filter') {
      if (message.scope !== undefined) {
        if (!SCOPES.has(message.scope)) return { handled: false, reason: 'invalid-message' };
        currentScope = message.scope;
      }
      if (message.status !== undefined) {
        if (!STATUSES.has(message.status)) return { handled: false, reason: 'invalid-message' };
        currentStatus = message.status;
      }
      currentOffset = 0;
      return reload();
    }
    if (message.type === 'action') return runAction(message);
    return { handled: false, reason: 'invalid-message' };
  }

  function view() {
    return model ? model.view() : null;
  }

  function html() {
    return panel ? panel.webview.html : null;
  }

  function dispose() {
    if (panel) panel.dispose();
  }

  return { open, reload, handleMessage: handle, view, html, dispose };
}

module.exports = {
  MEMORY_REVIEW_VERSION,
  MemoryReviewError,
  MemoryReviewModel,
  createMemoryReviewController,
  renderMemoryReviewHtml,
};
