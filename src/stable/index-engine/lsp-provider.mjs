// Optional generic Language Server Protocol symbol provider for the standalone index.
//
// The caller supplies the server command. The provider uses Content-Length framed
// JSON-RPC over stdio with shell execution disabled, bounded frames and timeouts,
// and a secret-filtered child environment. It only requests document symbols; it
// never enables diagnostics, hover, completion or other server features.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LSP_PROVIDER_ID = 'lsp-generic';
export const DEFAULT_LSP_TIMEOUT_MS = 5_000;
export const MAX_LSP_TIMEOUT_MS = 60_000;
export const MAX_LSP_MESSAGE_BYTES = 8_000_000;
export const MAX_LSP_HEADER_BYTES = 8_192;
export const MAX_LSP_DOCUMENT_LENGTH = 1_500_000;
export const MAX_LSP_SYMBOLS = 2_000;

const DEFAULT_EXTENSIONS = Object.freeze([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
]);
const MIN_MESSAGE_BYTES = 1_024;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 8_192;
const MAX_PATH_LENGTH = 4_096;
const MAX_NAME_LENGTH = 512;
const MAX_CONTAINER_DEPTH = 32;
const MAX_ERROR_LENGTH = 512;
const IDENTIFIER_NAME = /^#?[A-Za-z_$][\w$]*$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const LANGUAGE_ID = /^[A-Za-z0-9_+.-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_ENV = /(?:API_?KEY|ACCESS_KEY|(?:_|^)KEY(?:_|$)|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DATABASE_URL|AUTH|(?:_|^)PAT(?:_|$)|JWT|PIP_INDEX_URL)/i;
const LOADER_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z0-9_]+|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|RUBYOPT|PERL5OPT|BASH_ENV|ENV|SHELLOPTS|PROMPT_COMMAND)$/i;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SYMBOL_KINDS = new Map([
  [2, 'namespace'], [3, 'namespace'], [5, 'class'], [6, 'method'], [7, 'variable'],
  [8, 'variable'], [9, 'constructor'], [10, 'enum'], [11, 'interface'], [12, 'function'],
  [13, 'variable'], [14, 'variable'], [22, 'variable'], [23, 'class'], [26, 'type'],
]);

export class LspProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LspProviderError';
  }
}

function fail(message) {
  throw new LspProviderError(message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeMessage(value) {
  const text = typeof value === 'string' ? value : 'unknown error';
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, MAX_ERROR_LENGTH);
}

export function sanitizeLspEnvironment(environment = process.env, overrides = {}) {
  if (!plainObject(environment)) fail('environment must be an object');
  if (!plainObject(overrides)) fail('environment overrides must be an object');
  const output = {};
  const add = (name, value, strict) => {
    if (!ENV_NAME.test(name) || name === '__proto__' || name === 'constructor' || name === 'prototype') {
      if (strict) fail('environment variable names must be safe identifiers');
      return;
    }
    if (value === undefined) return;
    if (typeof value !== 'string' || value.length > 8_192 || value.includes('\0')) {
      if (strict) fail(`environment variable ${name} must be a string without NUL characters`);
      return;
    }
    if (SECRET_ENV.test(name) || LOADER_ENV.test(name)) return;
    output[name] = value;
  };
  for (const [name, value] of Object.entries(environment)) add(name, value, false);
  for (const [name, value] of Object.entries(overrides)) add(name, value, true);
  return output;
}

function normalizeFile(filePath, cwd, extensions) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_PATH_LENGTH) {
    fail('filePath must be a non-empty relative path');
  }
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//') || normalized.includes(':') ||
      UNSAFE_TEXT.test(normalized) || normalized.includes('<') || normalized.includes('>')) {
    fail('filePath must be a safe relative path');
  }
  const keys = normalized.split('/');
  if (keys.some((key) => key === '' || key === '.' || key === '..')) {
    fail('filePath must stay within the project root');
  }
  const extension = path.extname(normalized).toLowerCase();
  if (!extensions.has(extension)) return null;
  const absolute = path.resolve(cwd, ...keys);
  const relative = path.relative(cwd, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('filePath must stay within the project root');
  }
  return { relative: keys.join('/'), absolute };
}

function positionOf(value) {
  const start = value?.start;
  if (!plainObject(start) || !Number.isInteger(start.line) || start.line < 0 || start.line > 9_999_999 ||
      !Number.isInteger(start.character) || start.character < 0 || start.character > 9_999_999) {
    fail('language server returned an invalid symbol range');
  }
  return { line: start.line + 1, column: start.character + 1 };
}

function symbolName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_NAME_LENGTH || UNSAFE_TEXT.test(value) ||
      !IDENTIFIER_NAME.test(value)) {
    fail('language server returned an invalid symbol name');
  }
  return value;
}

function containerName(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_NAME_LENGTH || UNSAFE_TEXT.test(value)) {
    fail('language server returned an invalid symbol container');
  }
  return IDENTIFIER_NAME.test(value) ? value : undefined;
}

function mapKind(raw, detail, name) {
  if (!Number.isInteger(raw) || raw < 1 || raw > 26) fail('language server returned an invalid symbol kind');
  if (name === 'constructor') return 'constructor';
  if (detail === 'getter') return 'getter';
  if (detail === 'setter') return 'setter';
  return SYMBOL_KINDS.get(raw) ?? null;
}

function symbolsFromResult(result, uri, symbolLimit) {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) fail('language server returned an invalid symbol list');
  const symbols = [];
  const seen = new Set();
  const add = (symbol) => {
    if (symbols.length >= symbolLimit) return;
    const key = `${symbol.line}:${symbol.column}:${symbol.name}:${symbol.kind}:${symbol.container ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push(symbol);
  };

  const visitDocumentSymbol = (raw, container, depth) => {
    if (symbols.length >= symbolLimit) return;
    if (depth > MAX_CONTAINER_DEPTH) fail('language server returned symbols nested too deeply');
    if (!plainObject(raw)) fail('language server returned an invalid document symbol');
    const name = symbolName(raw.name);
    const kind = mapKind(raw.kind, raw.detail, name);
    if (kind) {
      add({ name, kind, ...positionOf(raw.range ?? raw.selectionRange), ...(container ? { container } : {}) });
    }
    if (raw.children !== undefined) {
      if (!Array.isArray(raw.children)) fail('language server returned invalid symbol children');
      const childContainer = kind ? name : container;
      for (const child of raw.children) visitDocumentSymbol(child, childContainer, depth + 1);
    }
  };

  for (const raw of result) {
    if (!plainObject(raw)) fail('language server returned an invalid symbol entry');
    if (raw.location !== undefined) {
      const location = raw.location;
      if (!plainObject(location) || typeof location.uri !== 'string' || location.uri !== uri) continue;
      const name = symbolName(raw.name);
      const kind = mapKind(raw.kind, raw.detail, name);
      if (!kind) continue;
      add({ name, kind, ...positionOf(location.range), ...(containerName(raw.containerName) ? { container: raw.containerName } : {}) });
      continue;
    }
    visitDocumentSymbol(raw, undefined, 0);
  }
  return symbols.sort((left, right) =>
    left.line - right.line || left.column - right.column || left.name.localeCompare(right.name) ||
    left.kind.localeCompare(right.kind) || (left.container ?? '').localeCompare(right.container ?? ''));
}

function parseContentLength(header) {
  let length;
  for (const raw of header.split(/\r?\n/)) {
    if (raw === '') continue;
    const colon = raw.indexOf(':');
    if (colon <= 0) return null;
    const name = raw.slice(0, colon).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
    const value = raw.slice(colon + 1).trim();
    if (value.length === 0) return null;
    if (name !== 'content-length') continue;
    if (length !== undefined || !/^\d+$/.test(value)) return null;
    length = Number(value);
    if (!Number.isSafeInteger(length)) return null;
  }
  return length === undefined ? null : length;
}

class LspConnection {
  constructor({ command, args, cwd, rootUri, timeoutMs, maxMessageBytes, env, initializationOptions }) {
    this.timeoutMs = timeoutMs;
    this.maxMessageBytes = maxMessageBytes;
    this.nextId = 1;
    this.requests = new Map();
    this.buffer = Buffer.alloc(0);
    this.broken = null;
    this.closed = false;
    this.child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) => {
      const finish = (code, signal) => resolve({ code, signal });
      this.child.once('exit', (code, signal) => {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        if (!this.closed && !this.broken) this.abort(`language server exited before responding (${detail})`);
        finish(code, signal);
      });
      this.child.once('close', (code, signal) => finish(code, signal));
    });
    this.child.once('error', (error) => {
      this.abort(`language server failed to start: ${safeMessage(error?.code ?? error?.message)}`);
    });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stdout.on('error', () => this.abort('language server output stream failed'));
    this.child.stderr.on('data', () => {});
    this.child.stderr.on('error', () => {});
    this.child.stdin.on('error', (error) => this.abort(`language server input stream failed: ${safeMessage(error?.message)}`));
    this.initializationOptions = initializationOptions;
    this.rootUri = rootUri;
    this.cwd = cwd;
  }

  async initialize() {
    const params = {
      processId: process.pid,
      clientInfo: { name: 'Vibecodium index', version: '1' },
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: path.basename(this.cwd) || 'workspace' }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
        general: { positionEncodings: ['utf-16'] },
      },
      ...(this.initializationOptions === undefined ? {} : { initializationOptions: this.initializationOptions }),
    };
    const result = await this.request('initialize', params);
    if (!plainObject(result) || !plainObject(result.capabilities) ||
        !result.capabilities.documentSymbolProvider) {
      fail('language server does not advertise document symbols');
    }
    this.notify('initialized', {});
  }

  request(method, params = null, timeoutMs = this.timeoutMs) {
    if (this.broken) return Promise.reject(this.broken);
    if (this.closed) return Promise.reject(new LspProviderError('language server connection is closed'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new LspProviderError(`language server timed out waiting for ${method}`));
        this.abort('language server request timed out');
      }, timeoutMs);
      this.requests.set(id, { resolve, reject, timer, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(error instanceof LspProviderError ? error : new LspProviderError('language server request failed'));
        this.abort('language server request could not be written');
      }
    });
  }

  notify(method, params) {
    if (this.broken || this.closed) return;
    try {
      this.write({ jsonrpc: '2.0', method, params });
    } catch {
      this.abort('language server notification could not be written');
    }
  }

  write(message) {
    if (!this.child.stdin || this.child.stdin.destroyed) fail('language server input stream is closed');
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.byteLength > this.maxMessageBytes) fail('language server request exceeds the message limit');
    const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii');
    this.child.stdin.write(header);
    this.child.stdin.write(body);
  }

  onData(chunk) {
    if (this.broken || this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > this.maxMessageBytes + MAX_LSP_HEADER_BYTES + 4) {
      this.abort('language server response exceeds the message limit');
      return;
    }
    for (;;) {
      let headerEnd = this.buffer.indexOf('\r\n\r\n');
      let delimiter = 4;
      if (headerEnd < 0) {
        headerEnd = this.buffer.indexOf('\n\n');
        delimiter = 2;
      }
      if (headerEnd < 0) {
        if (this.buffer.byteLength > MAX_LSP_HEADER_BYTES) this.abort('language server response header is too large');
        return;
      }
      if (headerEnd > MAX_LSP_HEADER_BYTES) {
        this.abort('language server response header is too large');
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = parseContentLength(header);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.maxMessageBytes) {
        this.abort('language server response has an invalid Content-Length');
        return;
      }
      const start = headerEnd + delimiter;
      if (this.buffer.byteLength < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        this.abort('language server response is not valid JSON');
        return;
      }
      this.dispatch(message);
      if (this.broken) return;
    }
  }

  dispatch(message) {
    if (!plainObject(message) || message.jsonrpc !== '2.0') {
      this.abort('language server response is not JSON-RPC 2.0');
      return;
    }
    if (message.method !== undefined) {
      if (message.id === undefined) return;
      const result = message.method === 'workspace/configuration'
        ? (Array.isArray(message.params?.items) ? message.params.items.slice(0, 32).map(() => null) : [])
        : null;
      try {
        this.write({ jsonrpc: '2.0', id: message.id, result });
      } catch {
        this.abort('language server request could not be answered');
      }
      return;
    }
    if (message.id === undefined) return;
    const pending = this.requests.get(message.id);
    if (!pending) return;
    this.requests.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const detail = plainObject(message.error) ? safeMessage(message.error.message) : 'unknown server error';
      pending.reject(new LspProviderError(`language server request failed: ${detail}`));
      return;
    }
    pending.resolve(message.result);
  }

  abort(message) {
    if (this.broken) return;
    this.broken = new LspProviderError(message);
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.broken);
    }
    this.requests.clear();
    try { this.child.kill(); } catch { /* already gone */ }
  }

  async close() {
    if (this.closed) return;
    if (!this.broken) {
      try {
        await this.request('shutdown', null, Math.min(this.timeoutMs, 1_000));
        this.notify('exit', null);
      } catch { /* the server may already be gone */ }
    }
    this.closed = true;
    this.abort('language server connection is closed');
    try { this.child.stdin.end(); } catch { /* already closed */ }
    await Promise.race([
      this.exited,
      new Promise((resolve) => { const timer = setTimeout(resolve, 1_000); timer.unref?.(); }),
    ]);
  }
}

export function createLspSymbolProvider(options = {}) {
  if (!plainObject(options)) fail('LSP provider options must be an object');
  const {
    command,
    args = [],
    cwd = process.cwd(),
    rootUri,
    timeoutMs = DEFAULT_LSP_TIMEOUT_MS,
    maxMessageBytes = MAX_LSP_MESSAGE_BYTES,
    languageId = 'typescript',
    extensions = DEFAULT_EXTENSIONS,
    id = LSP_PROVIDER_ID,
    env = {},
    initializationOptions,
  } = options;
  if (typeof command !== 'string' || command.length === 0 || command.length > 1_024 || command.includes('\0') ||
      UNSAFE_TEXT.test(command)) {
    fail('command must be a non-empty executable name or path');
  }
  if (!Array.isArray(args) || args.length > MAX_ARGS ||
      !args.every((value) => typeof value === 'string' && value.length <= MAX_ARG_LENGTH && !value.includes('\0'))) {
    fail(`args must be an array of at most ${MAX_ARGS} short strings`);
  }
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LENGTH || cwd.includes('\0')) {
    fail('cwd must be a non-empty path');
  }
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) fail('id must be a short lowercase identifier');
  if (typeof languageId !== 'string' || !LANGUAGE_ID.test(languageId)) fail('languageId must be a short protocol identifier');
  validateInteger('timeoutMs', timeoutMs, 100, MAX_LSP_TIMEOUT_MS);
  validateInteger('maxMessageBytes', maxMessageBytes, MIN_MESSAGE_BYTES, MAX_LSP_MESSAGE_BYTES);
  if (!Array.isArray(extensions) || extensions.length === 0 || extensions.length > 32 ||
      !extensions.every((value) => typeof value === 'string' && /^\.[A-Za-z0-9]+$/.test(value))) {
    fail('extensions must be a non-empty array of simple dotted file extensions');
  }
  const extensionSet = new Set(extensions.map((value) => value.toLowerCase()));
  const resolvedCwd = path.resolve(cwd);
  let resolvedRoot;
  try {
    resolvedRoot = rootUri === undefined ? pathToFileURL(resolvedCwd) : new URL(rootUri);
  } catch {
    fail('rootUri must be a valid file URL');
  }
  if (resolvedRoot.protocol !== 'file:' || resolvedRoot.host !== '' || resolvedRoot.username || resolvedRoot.password) {
    fail('rootUri must be a local file URL');
  }
  let initOptions;
  if (initializationOptions !== undefined) {
    if (!plainObject(initializationOptions)) fail('initializationOptions must be an object');
    let text;
    try { text = JSON.stringify(initializationOptions); } catch { fail('initializationOptions must be JSON-serializable'); }
    if (typeof text !== 'string' || text.length > 65_536) fail('initializationOptions is too large');
    initOptions = JSON.parse(text);
  }
  const childEnv = sanitizeLspEnvironment(process.env, env);
  let connection = null;
  let opening = null;
  const inFlight = new Set();
  let closePromise = null;
  let closed = false;

  const launch = async () => {
    const next = new LspConnection({
      command,
      args,
      cwd: resolvedCwd,
      rootUri: resolvedRoot.href,
      timeoutMs,
      maxMessageBytes,
      env: childEnv,
      initializationOptions: initOptions,
    });
    try {
      await next.initialize();
      if (closed) {
        await next.close().catch(() => {});
        fail('language server provider is closed');
      }
      return next;
    } catch (error) {
      await next.close().catch(() => {});
      throw error instanceof LspProviderError ? error : new LspProviderError('language server initialization failed');
    }
  };
  const liveConnection = async () => {
    if (closed) fail('language server provider is closed');
    if (connection) return connection;
    if (!opening) {
      const pending = launch();
      opening = pending;
      const clear = () => { if (opening === pending) opening = null; };
      pending.then(clear, clear);
    }
    const value = await opening;
    if (closed) {
      await value.close().catch(() => {});
      fail('language server provider is closed');
    }
    connection = value;
    return value;
  };
  const reset = async () => {
    const current = connection;
    const pending = opening;
    connection = null;
    opening = null;
    const resources = new Set();
    if (current) resources.add(current);
    if (pending) {
      try { resources.add(await pending); } catch { /* the launch already failed */ }
    }
    for (const resource of resources) await resource.close().catch(() => {});
  };

  const runExtract = async (source, extractOptions = {}) => {
    if (closed) fail('language server provider is closed');
    if (typeof source !== 'string' || source.length > MAX_LSP_DOCUMENT_LENGTH) {
      fail(`source must be a string of at most ${MAX_LSP_DOCUMENT_LENGTH} characters`);
    }
    if (!plainObject(extractOptions)) fail('options must be an object');
    const file = normalizeFile(extractOptions.filePath, resolvedCwd, extensionSet);
    if (!file) return null;
    const symbolLimit = validateInteger('maxSymbols', extractOptions.maxSymbols ?? MAX_LSP_SYMBOLS, 1, MAX_LSP_SYMBOLS);
    const uri = pathToFileURL(file.absolute).href;
    let active;
    try {
      active = await liveConnection();
      active.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: source },
      });
      let result;
      try {
        result = await active.request('textDocument/documentSymbol', { textDocument: { uri } });
      } finally {
        active.notify('textDocument/didClose', { textDocument: { uri } });
      }
      return symbolsFromResult(result, uri, symbolLimit);
    } catch (error) {
      if (connection === active) await reset();
      if (error instanceof LspProviderError) throw error;
      throw new LspProviderError(`language server symbol request failed: ${safeMessage(error?.message)}`);
    }
  };

  const extract = (source, extractOptions = {}) => {
    if (closed) return Promise.reject(new LspProviderError('language server provider is closed'));
    const operation = runExtract(source, extractOptions);
    const tracked = operation.then(
      (value) => { inFlight.delete(tracked); return value; },
      (error) => { inFlight.delete(tracked); throw error; },
    );
    inFlight.add(tracked);
    return tracked;
  };

  return {
    id,
    extract,
    extractSymbols: extract,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await reset();
        await Promise.all([...inFlight].map((operation) => operation.catch(() => {})));
      })();
      return closePromise;
    },
  };
}
