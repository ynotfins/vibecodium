'use strict';

const crypto = require('node:crypto');

const PROVIDER_SETUP_PANEL_VERSION = 1;
const MAX_MESSAGE_BYTES = 64 * 1024;
const SAFE_NONCE = /^[A-Za-z0-9+/=]{16,128}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;

class ProviderSetupPanelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderSetupPanelError';
  }
}

function fail(message) {
  throw new ProviderSetupPanelError(message);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function label(value, fallback) {
  return typeof value === 'string' && value.length > 0 && !UNSAFE_TEXT.test(value) ? value : fallback;
}

function option(value, selected, text) {
  return '<option value="' + escapeHtml(value) + '"' + (value === selected ? ' selected' : '') + '>' +
    escapeHtml(text ?? value) + '</option>';
}

function providerRow(provider) {
  const model = provider.model === undefined ? (provider.baseUrlEnv === undefined ? '-' : 'from env') : provider.model;
  const key = provider.apiKeyRequired
    ? (provider.secretStored ? 'stored' : 'missing')
    : 'not required';
  const actions = [
    '<button type="button" data-action="select" data-provider="' + escapeHtml(provider.id) + '"' +
      (provider.active ? ' disabled' : '') + '>' + (provider.active ? 'Active' : 'Use') + '</button>',
    '<button type="button" data-action="clear" data-provider="' + escapeHtml(provider.id) + '"' +
      (provider.secretStored ? '' : ' disabled') + '>Clear key</button>',
  ];
  if (provider.configured) {
    actions.push('<button type="button" data-action="remove" data-provider="' + escapeHtml(provider.id) + '">Remove</button>');
  }
  return '<tr data-provider-row="' + escapeHtml(provider.id) + '">' +
    '<td><strong>' + escapeHtml(provider.id) + '</strong><br><span class="muted">' + escapeHtml(provider.label) + '</span></td>' +
    '<td>' + escapeHtml(provider.transport) + '</td>' +
    '<td>' + escapeHtml(model) + '</td>' +
    '<td>' + escapeHtml(provider.apiKeyEnv ?? '-') + '<br><span class="muted">' + escapeHtml(key) + '</span></td>' +
    '<td class="actions">' + actions.join(' ') + '</td>' +
    '</tr>';
}

function renderProviderSetupHtml(view, status = {}) {
  if (!view || typeof view !== 'object') {
    return '<!doctype html><html><body><p>Provider setup is not available.</p></body></html>';
  }
  const nonce = crypto.randomBytes(18).toString('base64');
  if (!SAFE_NONCE.test(nonce)) fail('could not create a panel nonce');
  const envNames = Array.isArray(view.envNames) ? view.envNames : [];
  const providers = Array.isArray(view.providers) ? view.providers : [];
  const envOptions = ['<option value="">None</option>']
    .concat(envNames.map((name) => option(name, undefined, name)))
    .join('');
  const keyEnvOptions = ['<option value="">Not required</option>']
    .concat(envNames.map((name) => option(name, undefined, name)))
    .join('');
  const statusBlock = status.message
    ? '<p class="status" role="status">' + escapeHtml(label(status.message, 'Updated.')) + '</p>'
    : '';
  const errorBlock = status.error
    ? '<p class="error" role="alert">' + escapeHtml(label(status.error, 'The action failed.')) + '</p>'
    : '';
  const transportOptions = ['openai-chat', 'openai-responses']
    .map((value) => option(value, 'openai-chat', value)).join('');
  const authOptions = ['bearer', 'none'].map((value) => option(value, 'bearer', value)).join('');
  const capabilityBoxes = ['chat', 'stream', 'tools', 'embeddings'].map((value) =>
    '<label class="inline"><input type="checkbox" name="capability" value="' + value + '"' +
      (value === 'chat' ? ' checked' : '') + '> ' + value + '</label>').join('');

  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-' +
    nonce + '\'">\n<title>Vibecodium Providers</title>\n<style>' +
    'body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)}' +
    'table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border-bottom:1px solid var(--vscode-panel-border);padding:6px;text-align:left;vertical-align:top}' +
    '.muted{opacity:.7;font-size:.9em}.actions{white-space:nowrap}button{margin-right:4px}' +
    '.status{color:var(--vscode-testing-iconPassed)}.error{color:var(--vscode-errorForeground)}' +
    'form{display:grid;grid-template-columns:12em 1fr;gap:6px;align-items:center;max-width:48em}' +
    'fieldset{grid-column:1 / -1;border:1px solid var(--vscode-panel-border);padding:6px}.inline{display:inline-block;margin-right:8px}' +
    '</style>\n</head>\n<body>\n<h1>Providers</h1>\n' +
    '<p>Add a provider, pick the environment variable that holds its key, and switch providers without editing any file. Keys are stored in the Windows Credential Manager.</p>\n' +
    statusBlock + errorBlock +
    '<table>\n<thead><tr><th>Provider</th><th>Transport</th><th>Model</th><th>Key</th><th></th></tr></thead>\n<tbody id="provider-list">\n' +
    providers.map(providerRow).join('\n') + '\n</tbody>\n</table>\n' +
    '<h2>Add provider</h2>\n<form id="add-form">\n' +
    '<label for="provider-id">Id</label><input id="provider-id" name="provider-id" required pattern="[a-z][a-z0-9-]*">\n' +
    '<label for="provider-label">Label</label><input id="provider-label" name="provider-label" required>\n' +
    '<label for="provider-transport">Transport</label><select id="provider-transport" name="provider-transport">' + transportOptions + '</select>\n' +
    '<label for="provider-base-url">Base URL</label><input id="provider-base-url" name="provider-base-url" required>\n' +
    '<label for="provider-model">Model</label><input id="provider-model" name="provider-model" required>\n' +
    '<label for="provider-auth">Auth</label><select id="provider-auth" name="provider-auth">' + authOptions + '</select>\n' +
    '<label for="provider-key-env">Key variable</label><select id="provider-key-env" name="provider-key-env">' + keyEnvOptions + '</select>\n' +
    '<span>Capabilities</span><fieldset>' + capabilityBoxes + '</fieldset>\n' +
    '<label for="import-env">Import key from</label><select id="import-env" name="import-env">' + envOptions + '</select>\n' +
    '<span></span><button type="submit">Add provider</button>\n</form>\n' +
    '<script nonce="' + nonce + '">\n' +
    '(function () {\n' +
    '  const api = acquireVsCodeApi();\n' +
    '  document.getElementById("provider-list").addEventListener("click", function (event) {\n' +
    '    const button = event.target.closest("button[data-action]");\n' +
    '    if (!button) return;\n' +
    '    const action = button.getAttribute("data-action");\n' +
    '    const provider = button.getAttribute("data-provider");\n' +
    '    if (action === "select") api.postMessage({ type: "selectProvider", provider: provider });\n' +
    '    else if (action === "clear") api.postMessage({ type: "clearSecret", provider: provider });\n' +
    '    else if (action === "remove") api.postMessage({ type: "removeProvider", provider: provider });\n' +
    '  });\n' +
    '  document.getElementById("add-form").addEventListener("submit", function (event) {\n' +
    '    event.preventDefault();\n' +
    '    const form = event.target;\n' +
    '    const value = function (name) { return form.elements[name] ? form.elements[name].value.trim() : ""; };\n' +
    '    const provider = {\n' +
    '      id: value("provider-id"),\n' +
    '      label: value("provider-label"),\n' +
    '      transport: value("provider-transport"),\n' +
    '      baseUrl: value("provider-base-url"),\n' +
    '      model: value("provider-model"),\n' +
    '      auth: value("provider-auth"),\n' +
    '      capabilities: Array.from(form.querySelectorAll("input[name=capability]:checked")).map(function (input) { return input.value; })\n' +
    '    };\n' +
    '    const keyEnv = value("provider-key-env");\n' +
    '    if (keyEnv) provider.apiKeyEnv = keyEnv;\n' +
    '    api.postMessage({ type: "addProvider", provider: provider });\n' +
    '    const importEnv = value("import-env");\n' +
    '    if (importEnv) api.postMessage({ type: "importSecret", provider: provider.id, envName: importEnv });\n' +
    '  });\n' +
    '}());\n' +
    '</script>\n</body>\n</html>\n';
}

function publicError(error, secret) {
  const fallback = 'The provider setup action failed.';
  const message = error && typeof error.code === 'string' && typeof error.message === 'string'
    ? error.message
    : fallback;
  if (typeof secret === 'string' && secret.length > 0 && message.includes(secret)) return fallback;
  return UNSAFE_TEXT.test(message) ? fallback : message;
}

function createProviderSetupController(input = {}) {
  if (!input || typeof input !== 'object') fail('controller options must be an object');
  const { vscode, setupProvider, extensionUri } = input;
  if (!vscode || typeof vscode !== 'object') fail('vscode is required');
  if (typeof setupProvider !== 'function') fail('setupProvider is required');
  let panel = null;
  let status = { message: null, error: null };

  function setup() {
    const value = setupProvider();
    if (!value || typeof value.view !== 'function') fail('the provider setup service is not available');
    return value;
  }

  function refresh() {
    if (!panel) return;
    try {
      panel.webview.html = renderProviderSetupHtml(setup().view(), status);
    } catch (error) {
      panel.webview.html = renderProviderSetupHtml(null);
      status = { message: null, error: publicError(error) };
    }
  }

  function describeAction(type) {
    if (type === 'selectProvider') return 'Active provider changed.';
    if (type === 'addProvider') return 'Provider saved.';
    if (type === 'setSecret') return 'Key stored in the Windows Credential Manager.';
    if (type === 'importSecret') return 'Key imported from the selected environment variable.';
    if (type === 'clearSecret') return 'Stored key cleared.';
    if (type === 'removeProvider') return 'Provider removed.';
    return 'Updated.';
  }

  async function handle(raw) {
    if (!raw || typeof raw !== 'object') return { handled: false, reason: 'invalid-message' };
    if (JSON.stringify(raw).length > MAX_MESSAGE_BYTES) return { handled: false, reason: 'message-too-large' };
    const type = raw.type;
    const secret = typeof raw.secret === 'string' ? raw.secret : undefined;
    try {
      if (type === 'selectProvider') setup().selectProvider(raw.provider);
      else if (type === 'addProvider') setup().addProvider(raw.provider);
      else if (type === 'setSecret') await setup().setSecret({ provider: raw.provider, secret: raw.secret });
      else if (type === 'importSecret') {
        await setup().importSecretFromEnvironment({ provider: raw.provider, envName: raw.envName });
      } else if (type === 'clearSecret') await setup().clearSecret({ provider: raw.provider });
      else if (type === 'removeProvider') await setup().removeProvider(raw.provider);
      else if (type === 'refresh') {
        // no state change
      } else return { handled: false, reason: 'unknown-message' };
    } catch (error) {
      status = { message: null, error: publicError(error, secret) };
      refresh();
      return { handled: true, kind: 'error', code: typeof error.code === 'string' ? error.code : 'failed' };
    }
    status = { message: describeAction(type), error: null };
    refresh();
    return { handled: true, kind: type };
  }

  function open() {
    try {
      setup();
    } catch {
      vscode.window.showInformationMessage('Vibe Providers: the provider setup service is not connected yet.');
      return { opened: false, reason: 'no-setup' };
    }
    if (!panel) {
      panel = vscode.window.createWebviewPanel('vibecodium.providers', 'Vibe Providers', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: extensionUri ? [extensionUri] : [],
      });
      panel.webview.onDidReceiveMessage((message) => {
        handle(message).catch(() => {
          if (panel) vscode.window.showWarningMessage('Vibe Providers: the action could not be completed.');
        });
      });
      panel.onDidDispose(() => {
        panel = null;
      });
      refresh();
      return { opened: true };
    }
    refresh();
    panel.reveal();
    return { opened: false };
  }

  function view() {
    let base;
    try {
      base = setup().view();
    } catch {
      return null;
    }
    return { ...base, status: { ...status } };
  }

  function html() {
    return panel ? panel.webview.html : null;
  }

  function dispose() {
    if (panel) panel.dispose();
  }

  return { version: PROVIDER_SETUP_PANEL_VERSION, open, view, html, handleMessage: handle, dispose };
}

module.exports = {
  PROVIDER_SETUP_PANEL_VERSION,
  ProviderSetupPanelError,
  createProviderSetupController,
  renderProviderSetupHtml,
};
