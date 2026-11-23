import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export const INDEX_VERSION = 2;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_FILES = 10_000;
export const MAX_SYMBOLS_PER_FILE = 2_000;
export const MAX_TOKENS_PER_FILE = 4_000;
export const MAX_CALLS_PER_FILE = 2_000;
export const MAX_INDEX_BYTES = 64_000_000;
export const MAX_TOTAL_SYMBOLS = 500_000;
export const MAX_TOTAL_TOKENS = 2_000_000;
export const MAX_TOTAL_CALLS = 200_000;
export const MAX_DIRECTORIES = 50_000;

const CODE_EXTENSIONS = new Set([
  '.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx',
]);
const SKIP_DIRECTORIES = new Set([
  '.cache', '.git', '.next', '.vibe', 'build', 'coverage', 'dist', 'node_modules', 'out', 'vendor',
]);
const CONTROL_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield',
]);
const MODIFIERS = '(?:public|private|protected|readonly|static|async|abstract|override|declare)';
const IDENT = '([A-Za-z_$#][\\w$]*)';
const PINNED_INDEXES = new WeakMap();

export class IndexEngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndexEngineError';
  }
}

function fail(message) {
  throw new IndexEngineError(message);
}

function isIndexableFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function normalizeRelative(filePath) {
  if (typeof filePath !== 'string') fail('file path must be a non-empty string');
  if (filePath.length === 0 || filePath.length > 4096) fail('file path must be a non-empty string');
  if (filePath.includes('\0')) fail('file path contains a NUL character');
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')) {
    fail('file path must be relative to the project root');
  }
  if (/[:\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u.test(normalized)) fail('file path contains an unsupported character');
  const segments = normalized.split('/');
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('file path must stay within the project root');
  }
  return segments.join('/');
}

function validateInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const RESERVED_WINDOWS_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function isReservedWindowsName(name) {
  return RESERVED_WINDOWS_NAMES.has(name.split('.')[0].toUpperCase()) || /[ .]$/.test(name);
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rootKey(root) {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function validateExpectedRoot(expectedRoot) {
  if (!expectedRoot || typeof expectedRoot !== 'object' || Array.isArray(expectedRoot) ||
      typeof expectedRoot.rootKey !== 'string' || expectedRoot.rootKey.length === 0 ||
      !Number.isInteger(expectedRoot.rootDev) || expectedRoot.rootDev < 0 ||
      !Number.isInteger(expectedRoot.rootIno) || expectedRoot.rootIno < 0) {
    fail('expectedRoot must contain a pinned root identity');
  }
  return Object.freeze({
    rootKey: expectedRoot.rootKey,
    rootDev: expectedRoot.rootDev,
    rootIno: expectedRoot.rootIno,
  });
}

async function assertExpectedRoot(root, expectedRoot) {
  const real = await realpath(root).catch(() => null);
  if (!real || rootKey(real) !== expectedRoot.rootKey) fail('project root changed after registration');
  const info = await stat(real).catch(() => null);
  if (!info || !info.isDirectory() || info.dev !== expectedRoot.rootDev || info.ino !== expectedRoot.rootIno) {
    fail('project root changed after registration');
  }
}

async function readFileWithin(rootReal, relativePath, maxFileBytes, expectedRoot) {
  const absolute = path.join(rootReal, relativePath);
  const info = await lstat(absolute).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) fail('file is not a regular file within the project root');
  const real = await realpath(absolute).catch(() => null);
  if (!real || !isContained(rootReal, real)) fail('file must stay within the project root');
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    fail('file could not be opened safely');
  }
  try {
    const opened = await handle.stat();
    const after = await lstat(absolute).catch(() => null);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino ||
        !after || !after.isFile() || after.isSymbolicLink() ||
        after.dev !== opened.dev || after.ino !== opened.ino) {
      fail('file changed while it was being indexed');
    }
    if (opened.size > maxFileBytes) fail(`file exceeds ${maxFileBytes} bytes`);
    let buffer;
    try {
      buffer = await handle.readFile();
    } catch {
      fail('file could not be read safely');
    }
    if (buffer.byteLength > maxFileBytes) fail(`file exceeds ${maxFileBytes} bytes`);
    if (expectedRoot !== undefined) await assertExpectedRoot(rootReal, expectedRoot);
    return buffer;
  } finally {
    await handle.close().catch(() => {});
  }
}

function resolveIndexRoot(root, indexDir) {
  if (typeof indexDir !== 'string' || indexDir.length === 0 || path.isAbsolute(indexDir) ||
      /^[A-Za-z]:/.test(indexDir) || indexDir.includes('\0') || /[\x00-\x1f]/.test(indexDir)) {
    fail('indexDir must be a relative path');
  }
  for (const segment of indexDir.split(/[\\/]/)) {
    if (!segment || segment === '.' || segment === '..' || segment.includes(':') || isReservedWindowsName(segment)) {
      fail('indexDir must be a relative path inside the project root');
    }
  }
  const indexRoot = path.resolve(root, indexDir);
  const relative = path.relative(root, indexRoot);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('indexDir must stay within the project root');
  }
  return indexRoot;
}

export function maskNonCode(source) {
  const out = source.split('');
  const blank = (index) => {
    if (index >= 0 && index < out.length && source[index] !== '\n') out[index] = ' ';
  };
  const parenStack = [];
  let pendingParenControl = null;
  let lastSignificant = null;
  let previousSignificant = null;
  let dotPending = false;

  const setSignificant = (token, keepPending) => {
    previousSignificant = lastSignificant;
    lastSignificant = token;
    if (!keepPending) pendingParenControl = null;
    dotPending = false;
  };

  const regexStartAllowed = () => {
    if (lastSignificant === null) return true;
    if (lastSignificant.type === 'punct') {
      if (lastSignificant.value === ')') return pendingParenControl ?? false;
      if (lastSignificant.value === '++' || lastSignificant.value === '--') return false;
      return '=([{,;:!&|?+-*%~^<>}/'.includes(lastSignificant.value);
    }
    if (lastSignificant.type === 'word') {
      return !lastSignificant.property && [
        'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new',
        'of', 'return', 'throw', 'typeof', 'void', 'yield',
      ].includes(lastSignificant.value);
    }
    return false;
  };

  const isControlWord = (token) => token !== null && token.type === 'word' && !token.property &&
    ['if', 'while', 'for', 'with'].includes(token.value);

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];

    if (c === '/' && n === '/') {
      while (i < source.length && source[i] !== '\n') {
        blank(i);
        i += 1;
      }
      continue;
    }

    if (c === '/' && n === '*') {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        blank(i);
        i += 1;
      }
      blank(i);
      blank(i + 1);
      i += 2;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      blank(i);
      i += 1;
      while (i < source.length) {
        const d = source[i];
        if (d === '\\') {
          blank(i);
          blank(i + 1);
          i += 2;
          continue;
        }
        if (d === c) {
          blank(i);
          i += 1;
          break;
        }
        blank(i);
        i += 1;
      }
      setSignificant({ type: 'string', value: '' }, false);
      continue;
    }

    if (c === '(') {
      let control = isControlWord(lastSignificant);
      if (!control && lastSignificant !== null && lastSignificant.type === 'word' &&
          !lastSignificant.property && lastSignificant.value === 'await' &&
          previousSignificant !== null && previousSignificant.type === 'word' &&
          !previousSignificant.property && previousSignificant.value === 'for') {
        control = true;
      }
      parenStack.push(control);
      setSignificant({ type: 'punct', value: '(' }, false);
      i += 1;
      continue;
    }

    if (c === ')') {
      pendingParenControl = parenStack.pop() ?? false;
      setSignificant({ type: 'punct', value: ')' }, true);
      i += 1;
      continue;
    }

    if (c === '/' && regexStartAllowed()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      const limit = Math.min(source.length, i + 4096);
      while (j < limit) {
        const d = source[j];
        if (d === '\\') {
          blank(j);
          blank(j + 1);
          j += 2;
          continue;
        }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        if (d === ']') inClass = false;
        if (d === '/' && !inClass) {
          blank(j);
          j += 1;
          closed = true;
          break;
        }
        blank(j);
        j += 1;
      }
      if (closed) {
        blank(i);
        i = j;
        setSignificant({ type: 'regex', value: '' }, false);
        continue;
      }
      let k = i + 1;
      while (k < source.length && source[k] !== '\n') {
        blank(k);
        k += 1;
      }
      i = k;
      setSignificant({ type: 'regex', value: '' }, false);
      continue;
    }

    if (c === '+' && n === '+') {
      setSignificant({ type: 'punct', value: '++' }, false);
      i += 2;
      continue;
    }

    if (c === '-' && n === '-') {
      setSignificant({ type: 'punct', value: '--' }, false);
      i += 2;
      continue;
    }

    if (c === '?' && n === '.') {
      setSignificant({ type: 'punct', value: '?.' }, false);
      dotPending = true;
      i += 2;
      continue;
    }

    if (c === '.') {
      setSignificant({ type: 'punct', value: '.' }, false);
      dotPending = true;
      i += 1;
      continue;
    }

    if (/[\w$]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[\w$]/.test(source[j])) j += 1;
      const property = dotPending;
      dotPending = false;
      setSignificant({ type: 'word', value: source.slice(i, j), property }, false);
      i = j;
      continue;
    }

    if (/\s/.test(c)) {
      i += 1;
      continue;
    }

    setSignificant({ type: 'punct', value: c }, false);
    i += 1;
  }

  return out.join('');
}

function lineStartsOf(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOfOffset(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, high);
}

function bracePairs(masked) {
  const pairs = new Map();
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === '{') stack.push(i);
    else if (masked[i] === '}') {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  }
  return pairs;
}

function classSpans(masked, depthAtLine, pairs) {
  const spans = [];
  const re = /(?:^|\n)[ 	]*(?:declare\s+)?(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)[^{;\n]{0,500}\{/g;
  const lineStarts = lineStartsOf(masked);
  let match;
  while ((match = re.exec(masked)) !== null) {
    const name = match[1];
    if (CONTROL_WORDS.has(name)) continue;
    const open = masked.indexOf('{', match.index + match[0].indexOf('class'));
    if (open < 0) continue;
    const close = pairs.get(open);
    if (close === undefined) continue;
    const startLine = lineOfOffset(lineStarts, open);
    const endLine = lineOfOffset(lineStarts, close);
    spans.push({ name, startLine, endLine, bodyDepth: depthAtLine[startLine] + 1 });
  }
  return spans;
}

function symbolAt(name, kind, line, column, container) {
  return { name, kind, line: line + 1, column: column + 1, ...(container ? { container } : {}) };
}

export function extractSymbols(source, options = {}) {
  if (typeof source !== 'string') fail('source must be a string');
  source = source.replace(/^\uFEFF/, '');
  const maxSymbols = options.maxSymbols ?? MAX_SYMBOLS_PER_FILE;
  const masked = maskNonCode(source);
  const lines = source.split('\n');
  const maskedLines = masked.split('\n');
  const lineStarts = lineStartsOf(masked);
  const depthAtLine = [];
  let depth = 0;
  for (let line = 0; line < maskedLines.length; line += 1) {
    depthAtLine.push(depth);
    for (const char of maskedLines[line]) {
      if (char === '{') depth += 1;
      else if (char === '}') depth = Math.max(0, depth - 1);
    }
  }

  const byKey = new Map();
  const add = (symbol) => {
    const key = `${symbol.line}:${symbol.column}:${symbol.name}:${symbol.kind}:${symbol.container ?? ''}`;
    if (!byKey.has(key)) byKey.set(key, symbol);
  };

  const declarationPatterns = [
    [new RegExp(`^[ \\t]*(?:declare\\s+)?(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${IDENT}`), 'function'],
    [new RegExp(`^[ \\t]*(?:declare\\s+)?(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${IDENT}`), 'class'],
    [new RegExp(`^[ \\t]*(?:declare\\s+)?(?:export\\s+)?interface\\s+${IDENT}`), 'interface'],
    [new RegExp(`^[ \\t]*(?:declare\\s+)?(?:export\\s+)?type\\s+${IDENT}\\s*(?:<[^>]*>)?\\s*=`), 'type'],
    [new RegExp(`^[ \\t]*(?:declare\\s+)?(?:export\\s+)?(?:const\\s+)?enum\\s+${IDENT}`), 'enum'],
    [new RegExp(`^[ \\t]*(?:declare\\s+)?(?:export\\s+)?(?:namespace|module)\\s+${IDENT}`), 'namespace'],
    [new RegExp(`^[ \\t]*(?:declare\\s+)?(?:export\\s+)?(?:const|let|var)\\s+${IDENT}`), 'variable'],
  ];

  for (let line = 0; line < maskedLines.length; line += 1) {
    if (depthAtLine[line] !== 0) continue;
    const text = maskedLines[line];
    for (const [pattern, kind] of declarationPatterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      let symbolKind = kind;
      if (kind === 'variable') {
        const rest = text.slice(match[0].length);
        if (/=>/.test(rest) || /=\s*(?:async\s+)?function\b/.test(rest)) symbolKind = 'function';
      }
      if (CONTROL_WORDS.has(match[1])) continue;
      add(symbolAt(match[1], symbolKind, line, match.index + match[0].indexOf(match[1])));
      break;
    }
  }

  const pairs = bracePairs(masked);
  const methodPattern = new RegExp(
    `^[ \\t]*(?:${MODIFIERS}\\s+)*(?:(get|set)\\s+)?${IDENT}\\s*(?:<[^>]*>)?\\s*\\(`,
  );
  for (const span of classSpans(masked, depthAtLine, pairs)) {
    for (let line = span.startLine + 1; line <= span.endLine && line < maskedLines.length; line += 1) {
      if (depthAtLine[line] !== span.bodyDepth) continue;
      const match = methodPattern.exec(maskedLines[line]);
      if (!match) continue;
      const name = match[2];
      if (CONTROL_WORDS.has(name)) continue;
      const kind = name === 'constructor' ? 'constructor' : match[1] === 'get' ? 'getter' : match[1] === 'set' ? 'setter' : 'method';
      add(symbolAt(name, kind, line, match.index + match[0].indexOf(name), span.name));
    }
  }

  const symbols = [...byKey.values()].sort((a, b) =>
    a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
  return symbols.slice(0, maxSymbols);
}

function extractTokens(source, maxTokens) {
  const lineStarts = lineStartsOf(source);
  const map = new Map();
  let tokens = 0;
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match;
  while ((match = re.exec(source)) !== null && tokens < maxTokens) {
    const word = match[0].toLowerCase();
    if (word.length < 2 || word.length > 128) continue;
    const line = lineOfOffset(lineStarts, match.index) + 1;
    let entry = map.get(word);
    if (!entry) {
      entry = [];
      map.set(word, entry);
      tokens += 1;
    }
    if (entry.length === 0 || entry[entry.length - 1] !== line) {
      if (entry.length < 100) entry.push(line);
    }
  }
  return map.size === 0 ? {} : Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fileEntry(buffer, options) {
  const source = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const symbols = extractSymbols(source, { maxSymbols: options.maxSymbolsPerFile });
  const calls = extractCalls(source, {
    maxCalls: options.maxCallsPerFile,
    maxSymbols: options.maxSymbolsPerFile,
    symbols,
  });
  const tokens = extractTokens(maskNonCode(source), options.maxTokensPerFile);
  return { hash: hashBuffer(buffer), bytes: buffer.byteLength, symbols, calls, tokens };
}

function rebuildSymbols(files, maxSymbols = MAX_TOTAL_SYMBOLS) {
  const symbols = [];
  for (const [file, entry] of Object.entries(files)) {
    for (const symbol of entry.symbols) {
      if (symbols.length >= maxSymbols) fail('index contains too many symbols');
      symbols.push({ ...symbol, file });
    }
  }
  return symbols.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
}

function makeIndex(files) {
  const symbols = rebuildSymbols(files);
  let tokenCount = 0;
  let callCount = 0;
  for (const entry of Object.values(files)) {
    tokenCount += Object.keys(entry.tokens).length;
    callCount += entry.calls.length;
    if (tokenCount > MAX_TOTAL_TOKENS) fail('index contains too many tokens');
    if (callCount > MAX_TOTAL_CALLS) fail('index contains too many calls');
  }
  const fileCount = Object.keys(files).length;
  return { version: INDEX_VERSION, files, symbols, text: { tokenCount, fileCount }, fileCount };
}

const SYMBOL_KINDS = new Set(['class', 'constructor', 'enum', 'function', 'getter', 'interface', 'method', 'namespace', 'setter', 'type', 'variable']);

function validateLoadedIndex(value) {
  if (!value || typeof value !== 'object' || value.version !== INDEX_VERSION) fail('index file has an unsupported format');
  if (!value.files || typeof value.files !== 'object' || Array.isArray(value.files)) fail('index file has an invalid files map');
  const files = Object.entries(value.files);
  if (files.length > MAX_FILES) fail('index file contains too many files');
  for (const [file, entry] of files) {
    normalizeRelative(file);
    if (!entry || typeof entry !== 'object' || !/^[a-f0-9]{64}$/.test(entry.hash ?? '') ||
        !Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES ||
        !Array.isArray(entry.symbols) || entry.symbols.length > MAX_SYMBOLS_PER_FILE ||
        !Array.isArray(entry.calls) || entry.calls.length > MAX_CALLS_PER_FILE ||
        !entry.tokens || typeof entry.tokens !== 'object' || Array.isArray(entry.tokens)) {
      fail('index file has an invalid file entry');
    }
    for (const symbol of entry.symbols) {
      if (!symbol || typeof symbol.name !== 'string' || symbol.name.length < 1 || symbol.name.length > 512 ||
          !IDENTIFIER_NAME.test(symbol.name) ||
          !SYMBOL_KINDS.has(symbol.kind) || !Number.isInteger(symbol.line) || symbol.line < 1 ||
          !Number.isInteger(symbol.column) || symbol.column < 1 ||
          (symbol.container !== undefined && (typeof symbol.container !== 'string' || symbol.container.length > 512 ||
              !IDENTIFIER_NAME.test(symbol.container)))) {
        fail('index file has an invalid symbol');
      }
    }
    for (const call of entry.calls) {
      if (!call || typeof call.name !== 'string' || call.name.length < 1 || call.name.length > 512 ||
          !IDENTIFIER_NAME.test(call.name) ||
          (call.kind !== 'call' && call.kind !== 'new') ||
          !Number.isInteger(call.line) || call.line < 1 ||
          !Number.isInteger(call.column) || call.column < 1 ||
          !Number.isInteger(call.endLine) || call.endLine < call.line || call.endLine > 10_000_000 ||
          !Number.isInteger(call.depth) || call.depth < 0 || call.depth > 1_000_000 ||
          (call.receiver !== undefined && (typeof call.receiver !== 'string' || call.receiver.length > 512 ||
              !IDENTIFIER_NAME.test(call.receiver)))) {
        fail('index file has an invalid call site');
      }
    }
    const tokens = Object.entries(entry.tokens);
    if (tokens.length > MAX_TOKENS_PER_FILE) fail('index file contains too many tokens');
    for (const [word, lines] of tokens) {
      if (typeof word !== 'string' || word.length < 2 || word.length > 128 || !Array.isArray(lines) ||
          lines.length > 100 || !lines.every((line) => Number.isInteger(line) && line > 0 && line <= 10_000_000)) {
        fail('index file has an invalid token entry');
      }
    }
  }
  if (value.symbols !== undefined) fail('index file has an unsupported format');
  let tokenCount = 0;
  for (const [, entry] of files) tokenCount += Object.keys(entry.tokens).length;
  let callCount = 0;
  for (const [, entry] of files) callCount += entry.calls.length;
  if (callCount > MAX_TOTAL_CALLS) fail('index contains too many calls');
  if (tokenCount > MAX_TOTAL_TOKENS) fail('index contains too many tokens');
  const fileCount = files.length;
  if (value.fileCount !== fileCount || !value.text || typeof value.text !== 'object' ||
      value.text.tokenCount !== tokenCount || value.text.fileCount !== fileCount) {
    fail('index file has inconsistent metadata');
  }
  return {
    version: value.version,
    files: value.files,
    symbols: rebuildSymbols(value.files),
    text: { tokenCount, fileCount },
    fileCount,
  };
}

async function listFiles(root, options) {
  const files = [];
  const skipped = { symlinks: 0, oversized: 0, unsupported: 0 };
  const queue = [''];
  let directories = 0;
  while (queue.length > 0) {
    const dir = queue.pop();
    directories += 1;
    if (directories > options.maxDirs) fail(`project exceeds ${options.maxDirs} directories`);
    const dirPath = path.join(root, dir);
    const before = await lstat(dirPath).catch(() => null);
    if (!before || !before.isDirectory() || before.isSymbolicLink()) {
      skipped.symlinks += 1;
      continue;
    }
    const beforeReal = await realpath(dirPath).catch(() => null);
    if (!beforeReal || !isContained(root, beforeReal)) {
      skipped.symlinks += 1;
      continue;
    }
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      fail('project directory could not be read');
    }
    const afterReal = await realpath(dirPath).catch(() => null);
    if (!afterReal || !isContained(root, afterReal)) {
      skipped.symlinks += 1;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      try {
        if (normalizeRelative(rel) !== rel) {
          skipped.unsupported += 1;
          continue;
        }
      } catch {
        skipped.unsupported += 1;
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.symlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) queue.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isIndexableFile(rel)) {
        skipped.unsupported += 1;
        continue;
      }
      const info = await lstat(path.join(root, rel)).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink()) {
        skipped.symlinks += 1;
        continue;
      }
      if (info.size > options.maxFileBytes) {
        skipped.oversized += 1;
        continue;
      }
      files.push(rel);
      if (files.length > options.maxFiles) fail(`project exceeds ${options.maxFiles} indexable files`);
    }
  }
  return { files: files.sort(), skipped };
}

async function ensureIndexRoot(root, indexRoot) {
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) fail('project root does not exist');
  const relative = path.relative(root, indexRoot);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('index directory must stay within the project root');
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') fail('index directory must stay within the project root');
    current = path.join(current, segment);
    const existing = await lstat(current).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) fail('index directory must be a real directory inside the project root');
      const real = await realpath(current).catch(() => null);
      if (!real || !isContained(rootReal, real)) fail('index directory must stay within the project root');
    } else {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch {
        fail('index directory could not be created');
      }
      const real = await realpath(current).catch(() => null);
      if (!real || !isContained(rootReal, real)) fail('index directory must stay within the project root');
    }
  }
  const real = await realpath(indexRoot).catch(() => null);
  if (!real || !isContained(rootReal, real)) fail('index directory must stay within the project root');
  return real;
}

async function writeIndexFile(root, indexRoot, indexFile, index) {
  const persisted = {
    version: index.version,
    files: index.files,
    text: index.text,
    fileCount: index.fileCount,
  };
  const raw = `${JSON.stringify(persisted)}\n`;
  if (Buffer.byteLength(raw, 'utf8') > MAX_INDEX_BYTES) fail('index exceeds the maximum size');
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) fail('project root does not exist');
  const safeRoot = await ensureIndexRoot(root, indexRoot);
  const temp = path.join(safeRoot, `${indexFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch {
    fail('index could not be written');
  }
  try {
    const tempReal = await realpath(temp).catch(() => null);
    const dirReal = await realpath(safeRoot).catch(() => null);
    if (!tempReal || !dirReal || !isContained(rootReal, tempReal) || !isContained(rootReal, dirReal)) {
      fail('index directory changed while writing');
    }
    try {
      await handle.writeFile(raw, 'utf8');
    } catch {
      fail('index could not be written');
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    if (error instanceof IndexEngineError) throw error;
    fail('index could not be written');
  }
  await handle.close().catch(() => {});
  try {
    const dirReal = await realpath(safeRoot).catch(() => null);
    if (!dirReal || !isContained(rootReal, dirReal)) fail('index directory changed while writing');
    await rename(temp, path.join(safeRoot, indexFile));
    const finalReal = await realpath(path.join(safeRoot, indexFile)).catch(() => null);
    if (!finalReal || !isContained(rootReal, finalReal)) {
      await unlink(path.join(safeRoot, indexFile)).catch(() => {});
      fail('index directory changed while writing');
    }
  } catch (error) {
    await unlink(temp).catch(() => {});
    if (error instanceof IndexEngineError) throw error;
    fail('index could not be written');
  }
}

export class ProjectIndex {
  constructor(root, options = {}) {
    if (typeof root !== 'string' || root.length === 0) fail('root must be a non-empty path string');
    if (options === null || typeof options !== 'object') fail('options must be an object');
    this.root = path.resolve(root);
    this.persist = options.persist !== false;
    if (options.persist !== undefined && typeof options.persist !== 'boolean') fail('persist must be a boolean');
    if (options.expectedRoot !== undefined) PINNED_INDEXES.set(this, validateExpectedRoot(options.expectedRoot));
    this.indexDir = resolveIndexRoot(this.root, options.indexDir ?? '.vibe/index');
    this.indexFile = options.indexFile ?? 'index.json';
    if (typeof this.indexFile !== 'string' || !/^[A-Za-z0-9._-]+\.json$/.test(this.indexFile) ||
        this.indexFile === '.' || this.indexFile === '..' || isReservedWindowsName(this.indexFile)) {
      fail('indexFile must be a simple JSON file name');
    }
    this.options = {
      maxFiles: validateInteger('maxFiles', options.maxFiles ?? MAX_FILES, 1, MAX_FILES),
      maxDirs: validateInteger('maxDirs', options.maxDirs ?? MAX_DIRECTORIES, 1, MAX_DIRECTORIES),
      maxFileBytes: validateInteger('maxFileBytes', options.maxFileBytes ?? MAX_FILE_BYTES, 1, MAX_FILE_BYTES),
      maxSymbolsPerFile: validateInteger('maxSymbolsPerFile', options.maxSymbolsPerFile ?? MAX_SYMBOLS_PER_FILE, 1, MAX_SYMBOLS_PER_FILE),
      maxTokensPerFile: validateInteger('maxTokensPerFile', options.maxTokensPerFile ?? MAX_TOKENS_PER_FILE, 1, MAX_TOKENS_PER_FILE),
      maxCallsPerFile: validateInteger('maxCallsPerFile', options.maxCallsPerFile ?? MAX_CALLS_PER_FILE, 1, MAX_CALLS_PER_FILE),
    };
    this.current = null;
  }

  get indexPath() {
    return path.join(this.indexDir, this.indexFile);
  }

  async load() {
    const info = await lstat(this.indexPath).catch(() => null);
    if (!info) fail('index not found; run refresh() first');
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INDEX_BYTES) fail('index file is not a valid index');
    const rootReal = await realpath(this.root).catch(() => null);
    if (!rootReal) fail('project root does not exist');
    const pinned = PINNED_INDEXES.get(this);
    if (pinned) await assertExpectedRoot(this.root, pinned);
    const relativePath = path.relative(this.root, this.indexPath).replace(/\\/g, '/');
    let raw;
    try {
      const buffer = await readFileWithin(rootReal, relativePath, MAX_INDEX_BYTES, pinned);
      raw = buffer.toString('utf8');
    } catch {
      fail('index file could not be read');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('index file is not valid JSON');
    }
    const loaded = validateLoadedIndex(parsed);
    if (pinned) await this.verifySnapshot(loaded, pinned);
    this.current = loaded;
    return { index: this.current, stats: { files: Object.keys(this.current.files).length, symbols: this.current.symbols.length } };
  }

  async refresh({ full = false, expectedRoot } = {}) {
    if (typeof full !== 'boolean') fail('full must be a boolean');
    const pinned = PINNED_INDEXES.get(this);
    if (pinned) expectedRoot = pinned;
    else if (expectedRoot !== undefined) validateExpectedRoot(expectedRoot);
    const rootReal = await realpath(this.root).catch(() => null);
    if (!rootReal) fail('project root does not exist');
    const rootInfo = await stat(rootReal).catch(() => null);
    if (!rootInfo || !rootInfo.isDirectory()) fail('project root must be a directory');
    if (expectedRoot !== undefined &&
        (rootKey(rootReal) !== expectedRoot.rootKey ||
        rootInfo.dev !== expectedRoot.rootDev || rootInfo.ino !== expectedRoot.rootIno)) {
      fail('project root changed after registration');
    }
    let previousFiles = {};
    if (!full) {
      if (this.persist) {
        try {
          previousFiles = (await this.load()).index.files;
        } catch {
          previousFiles = {};
        }
      } else if (this.current) {
        previousFiles = this.current.files;
      }
    }
    const { files: relFiles, skipped } = await listFiles(rootReal, this.options);
    if (expectedRoot !== undefined) await assertExpectedRoot(this.root, expectedRoot);
    const files = {};
    let changed = 0;
    let reused = 0;
    let totalSymbols = 0;
    let totalTokens = 0;
    for (const rel of relFiles) {
      let buffer;
      try {
        buffer = await readFileWithin(rootReal, rel, this.options.maxFileBytes, expectedRoot);
      } catch {
        skipped.raced = (skipped.raced ?? 0) + 1;
        continue;
      }
      const hash = hashBuffer(buffer);
      const previous = previousFiles[rel];
      let entry;
      if (previous && previous.hash === hash && Array.isArray(previous.symbols) && Array.isArray(previous.calls) && previous.tokens) {
        entry = previous;
        reused += 1;
      } else {
        entry = fileEntry(buffer, this.options);
        changed += 1;
      }
      totalSymbols += entry.symbols.length;
      totalTokens += Object.keys(entry.tokens).length;
      if (totalSymbols > MAX_TOTAL_SYMBOLS) fail('index contains too many symbols');
      if (totalTokens > MAX_TOTAL_TOKENS) fail('index contains too many tokens');
      files[rel] = entry;
    }
    const index = makeIndex(files);
    if (expectedRoot !== undefined) await this.verifySnapshot(index, expectedRoot);
    if (expectedRoot !== undefined) await assertExpectedRoot(this.root, expectedRoot);
    if (this.persist) await writeIndexFile(this.root, this.indexDir, this.indexFile, index);
    this.current = index;
    return {
      index,
      changed,
      stats: {
        files: relFiles.length,
        symbols: index.symbols.length,
        tokens: index.text.tokenCount,
        changed,
        reused,
        skipped,
      },
    };
  }

  async verifySnapshot(index, expectedRoot) {
    const pinned = PINNED_INDEXES.get(this);
    if (pinned) expectedRoot = pinned;
    else validateExpectedRoot(expectedRoot);
    if (!index || typeof index !== 'object' || !index.files || typeof index.files !== 'object' ||
        Array.isArray(index.files)) {
      fail('index snapshot is not valid');
    }
    const rootReal = await realpath(this.root).catch(() => null);
    if (!rootReal) fail('project root does not exist');
    const rootInfo = await stat(rootReal).catch(() => null);
    if (!rootInfo || !rootInfo.isDirectory() || rootKey(rootReal) !== expectedRoot.rootKey ||
        rootInfo.dev !== expectedRoot.rootDev || rootInfo.ino !== expectedRoot.rootIno) {
      fail('project root changed after registration');
    }
    for (const [file, entry] of Object.entries(index.files)) {
      if (!entry || typeof entry !== 'object' || !/^[a-f0-9]{64}$/.test(entry.hash ?? '')) {
        fail('index snapshot is not valid');
      }
      const rel = normalizeRelative(file);
      const buffer = await readFileWithin(rootReal, rel, this.options.maxFileBytes, expectedRoot);
      if (hashBuffer(buffer) !== entry.hash) fail('index snapshot does not match the project root');
    }
    await assertExpectedRoot(this.root, expectedRoot);
    return true;
  }

  async reindexFile(filePath) {
    if (PINNED_INDEXES.has(this)) fail('reindexFile is unavailable for pinned indexes');
    const rel = normalizeRelative(filePath);
    if (!isIndexableFile(rel)) fail('file is not an indexable source file');
    if (!this.current) await this.load();
    const rootReal = await realpath(this.root).catch(() => null);
    if (!rootReal) fail('project root does not exist');
    const buffer = await readFileWithin(rootReal, rel, this.options.maxFileBytes);
    const entry = fileEntry(buffer, this.options);
    const previous = this.current.files[rel];
    if (previous && previous.hash === entry.hash) {
      return { index: this.current, changed: false };
    }
    const files = { ...this.current.files, [rel]: entry };
    let totalSymbols = 0;
    let totalTokens = 0;
    for (const fileEntryValue of Object.values(files)) {
      totalSymbols += fileEntryValue.symbols.length;
      totalTokens += Object.keys(fileEntryValue.tokens).length;
    }
    if (totalSymbols > MAX_TOTAL_SYMBOLS) fail('index contains too many symbols');
    if (totalTokens > MAX_TOTAL_TOKENS) fail('index contains too many tokens');
    const index = makeIndex(files);
    if (this.persist) await writeIndexFile(this.root, this.indexDir, this.indexFile, index);
    this.current = index;
    return { index, changed: true };
  }

  symbols({ file, kind, limit = 200 } = {}) {
    if (!this.current) fail('index not loaded; run refresh() or load() first');
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) fail('limit must be between 1 and 5000');
    const rel = file === undefined ? undefined : normalizeRelative(file);
    if (kind !== undefined && typeof kind !== 'string') fail('kind must be a string');
    return this.current.symbols
      .filter((symbol) => (rel === undefined || symbol.file === rel) && (kind === undefined || symbol.kind === kind))
      .slice(0, limit);
  }

  searchText(query, { limit = 20 } = {}) {
    if (!this.current) fail('index not loaded; run refresh() or load() first');
    if (typeof query !== 'string' || query.trim().length === 0 || query.length > 200) {
      fail('query must be a non-empty string of at most 200 characters');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('limit must be between 1 and 100');
    const words = [...new Set(query.toLowerCase().match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])]
      .filter((word) => word.length >= 2);
    if (words.length === 0 || words.length > 16) fail('query must contain between 1 and 16 words');
    const hits = [];
    for (const [file, entry] of Object.entries(this.current.files)) {
      const lineLists = words.map((word) => (Object.hasOwn(entry.tokens, word) ? entry.tokens[word] : undefined));
      if (lineLists.some((lines) => !lines || lines.length === 0)) continue;
      const lines = [...new Set(lineLists[0])].slice(0, 20);
      const score = lineLists.reduce((sum, list) => sum + list.length, 0);
      hits.push({ file, lines, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, limit);
  }
}
const IDENTIFIER_NAME = /^#?[A-Za-z_$][\w$]*$/;

function wordBefore(masked, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(masked[i])) i -= 1;
  const end = i + 1;
  while (i >= 0 && /[\w$#]/.test(masked[i])) i -= 1;
  return masked.slice(i + 1, end);
}

function receiverBefore(masked, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(masked[i])) i -= 1;
  if (i < 1 || masked[i] !== '.') return undefined;
  let end = i;
  if (masked[end - 1] === '?') end -= 1;
  let start = end - 1;
  while (start >= 0 && /[\w$#]/.test(masked[start])) start -= 1;
  const name = masked.slice(start + 1, end);
  return IDENTIFIER_NAME.test(name) ? name : undefined;
}

function nextNonSpace(masked, index) {
  let i = index;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  return i < masked.length ? masked[i] : '';
}

function closeParenAfter(masked, open, limit) {
  let depth = 0;
  for (let i = open; i < masked.length && i < open + limit; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readIdentifierBefore(masked, end) {
  let i = end - 1;
  while (i >= 0 && /[\w$]/.test(masked[i])) i -= 1;
  if (i >= 0 && masked[i] === '#' && end - i > 1) i -= 1;
  if (i + 1 >= end) return null;
  const name = masked.slice(i + 1, end);
  return IDENTIFIER_NAME.test(name) ? { name, start: i + 1 } : null;
}

function identifierBeforeParen(masked, open) {
  let i = open - 1;
  while (i >= 0 && /\s/.test(masked[i])) i -= 1;
  if (i < 0) return null;
  if (masked[i] === '>') {
    let depth = 0;
    let scan = i;
    const limit = Math.max(0, i - 200);
    for (; scan >= limit; scan -= 1) {
      const c = masked[scan];
      if (c === '>') depth += 1;
      else if (c === '<') {
        depth -= 1;
        if (depth === 0) break;
      } else if (!/[A-Za-z0-9_$.,\[\]\s]/.test(c)) return null;
    }
    if (depth !== 0) return null;
    i = scan - 1;
    while (i >= 0 && /\s/.test(masked[i])) i -= 1;
  }
  return readIdentifierBefore(masked, i + 1);
}

// Extracts call sites from code only. Declarations and object-literal method shorthand are not calls.
// The scan visits each character at most once plus each identifier once, so a long identifier run
// cannot make it quadratic.
export function extractCalls(source, options = {}) {
  if (typeof source !== 'string') fail('source must be a string');
  source = source.replace(/^\uFEFF/, '');
  const maxCalls = validateInteger('maxCalls', options.maxCalls ?? MAX_CALLS_PER_FILE, 1, MAX_CALLS_PER_FILE);
  const masked = maskNonCode(source);
  const symbols = options.symbols ?? extractSymbols(source, {
    maxSymbols: options.maxSymbols ?? MAX_SYMBOLS_PER_FILE,
  });
  const declarations = new Set(symbols.map((symbol) => `${symbol.line}:${symbol.column}:${symbol.name}`));
  const lineStarts = lineStartsOf(masked);
  const calls = [];
  const seen = new Set();
  let depth = 0;
  for (let i = 0; i < masked.length && calls.length < maxCalls; i += 1) {
    const char = masked[i];
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char !== '(') continue;
    const found = identifierBeforeParen(masked, i);
    if (!found) continue;
    const { name, start } = found;
    const bare = name.replace(/^#/, '');
    if (CONTROL_WORDS.has(bare)) continue;
    const line = lineOfOffset(lineStarts, start) + 1;
    const column = start - lineStarts[line - 1] + 1;
    if (declarations.has(`${line}:${column}:${name}`)) continue;
    const close = closeParenAfter(masked, i, 4_000);
    if (close >= 0 && nextNonSpace(masked, close + 1) === '{') continue;
    const endLine = close >= 0 ? lineOfOffset(lineStarts, close) + 1 : line;
    const receiver = receiverBefore(masked, start);
    const kind = wordBefore(masked, start) === 'new' ? 'new' : 'call';
    const key = `${line}:${column}:${name}:${kind}:${receiver ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ name, line, column, endLine, depth, kind, ...(receiver ? { receiver } : {}) });
  }
  return calls;
}
