// Optional ast-grep structural pattern provider for the standalone index.
//
// The caller supplies a local ast-grep `sg` executable. The provider writes the
// source to stdin and reads one JSON match per line (`--json=stream`), so it
// never scans a directory, writes a rule file or loads a native NAPI module.
// ast-grep 0.51.3 returns zero-based lines and columns; this module converts
// them to the one-based positions the index uses.
import { spawn } from 'node:child_process';
import path from 'node:path';

export const AST_GREP_PROVIDER_ID = 'ast-grep';
export const DEFAULT_AST_GREP_TIMEOUT_MS = 5_000;
export const MAX_AST_GREP_TIMEOUT_MS = 60_000;
export const MAX_AST_GREP_SOURCE_BYTES = 1_000_000;
export const MAX_AST_GREP_OUTPUT_BYTES = 4_000_000;
export const MAX_AST_GREP_MATCHES = 500;
export const MAX_AST_GREP_MATCH_TEXT = 4_000;

export const AST_GREP_LANGUAGES = Object.freeze(['javascript', 'typescript', 'tsx']);

export const AST_GREP_LANGUAGE_BY_EXTENSION = Object.freeze({
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
});

const MIN_TIMEOUT_MS = 100;
const MIN_OUTPUT_BYTES = 1_024;
const MAX_COMMAND_LENGTH = 1_024;
const MAX_PATH_LENGTH = 4_096;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 8_192;
const MAX_PATTERN_LENGTH = 4_096;
const MAX_META_ENTRIES = 64;
const MAX_META_ITEMS = 32;
const MAX_META_TEXT = 512;
const MAX_POSITION = 9_999_999;
const MAX_ERROR_LENGTH = 512;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const META_NAME = /^\$?[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_RENDERED_TEXT = /(?![\t\n\r])\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/gu;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_ENV = /(?:API_?KEY|ACCESS_KEY|(?:_|^)KEY(?:_|$)|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DATABASE_URL|AUTH|(?:_|^)PAT(?:_|$)|JWT|PIP_INDEX_URL|(?:_|^)(?:URL|URI|DSN)(?:_|$)|CONNECTION_STRING|WEBHOOK|SIGNING)/i;
const LOADER_ENV = /^(?:NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_DEBUG|NODE_INSPECT|NODE_V8_COVERAGE|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z0-9_]+|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|RUBYOPT|PERL5OPT|BASH_ENV|BASH_FUNC_[A-Za-z0-9_]+|ENV|SHELLOPTS|PROMPT_COMMAND|ELECTRON_RUN_AS_NODE)$/i;
const LANGUAGES = new Set(AST_GREP_LANGUAGES);

export class AstGrepProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AstGrepProviderError';
  }
}

function fail(message) {
  throw new AstGrepProviderError(message);
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

function cleanText(value, maxLength) {
  return value.replace(UNSAFE_RENDERED_TEXT, '\uFFFD').slice(0, maxLength);
}

export function sanitizeAstGrepEnvironment(environment = process.env, overrides = {}) {
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

function validateCommand(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_COMMAND_LENGTH ||
      command.trim().length === 0 || UNSAFE_TEXT.test(command)) {
    fail('command must be a non-empty executable name or path');
  }
  if (/\.(?:cmd|bat)[\s.]*$/i.test(command)) {
    fail('command must not be a Windows shell script; use an executable');
  }
}

function validateQueryOptions(options) {
  if (!plainObject(options)) fail('query options must be an object');
  const { pattern, language, filePath, maxMatches = MAX_AST_GREP_MATCHES } = options;
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH || pattern.includes('\0')) {
    fail(`pattern must be a non-empty string of at most ${MAX_PATTERN_LENGTH} characters`);
  }
  validateInteger('maxMatches', maxMatches, 1, MAX_AST_GREP_MATCHES);
  if (language !== undefined && (typeof language !== 'string' || !LANGUAGES.has(language))) {
    fail(`language must be one of: ${AST_GREP_LANGUAGES.join(', ')}`);
  }
  let inferred;
  if (filePath !== undefined) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_PATH_LENGTH || filePath.includes('\0')) {
      fail('filePath must be a non-empty path of at most 4096 characters');
    }
    inferred = AST_GREP_LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()];
    if (!inferred) fail(`unsupported file extension for ast-grep: ${path.extname(filePath) || '(none)'}`);
    if (language !== undefined && language !== inferred) {
      fail('language does not match the filePath extension');
    }
  }
  const resolved = language ?? inferred;
  if (!resolved) fail('language or a supported filePath is required');
  return { pattern, language: resolved, maxMatches };
}

function position(value) {
  if (!plainObject(value) || !Number.isInteger(value.line) || value.line < 0 || value.line > MAX_POSITION ||
      !Number.isInteger(value.column) || value.column < 0 || value.column > MAX_POSITION) {
    fail('ast-grep returned an invalid match position');
  }
  return { line: value.line + 1, column: value.column + 1 };
}

function parseRange(value, label) {
  if (!plainObject(value) || !plainObject(value.byteOffset)) fail(`ast-grep returned an invalid match ${label}`);
  const { start, end } = value.byteOffset;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    fail('ast-grep returned invalid byte offsets');
  }
  const from = position(value.start);
  const to = position(value.end);
  return { offset: { start, end }, from, to };
}

function parseMetaNode(value, maxText) {
  if (!plainObject(value) || typeof value.text !== 'string') {
    fail('ast-grep returned an invalid meta variable');
  }
  const range = parseRange(value.range, 'meta variable');
  return {
    text: cleanText(value.text, maxText),
    line: range.from.line,
    column: range.from.column,
    endLine: range.to.line,
    endColumn: range.to.column,
  };
}

function normalizeLanguage(value) {
  const lower = value.toLowerCase();
  return LANGUAGES.has(lower) ? lower : null;
}

function validMetaName(name) {
  return META_NAME.test(name) && name !== '__proto__' && name !== 'constructor' && name !== 'prototype';
}

function parseMetaVariables(value) {
  if (value === undefined) return { single: {}, multi: {}, transformed: {} };
  if (!plainObject(value)) fail('ast-grep returned invalid meta variables');
  const single = {};
  const multi = {};
  const transformed = {};
  if (value.single !== undefined) {
    if (!plainObject(value.single)) fail('ast-grep returned invalid single meta variables');
    for (const name of Object.keys(value.single).slice(0, MAX_META_ENTRIES)) {
      if (!validMetaName(name)) fail('ast-grep returned an invalid meta variable name');
      single[name] = parseMetaNode(value.single[name], MAX_META_TEXT);
    }
  }
  if (value.multi !== undefined) {
    if (!plainObject(value.multi)) fail('ast-grep returned invalid multi meta variables');
    for (const name of Object.keys(value.multi).slice(0, MAX_META_ENTRIES)) {
      if (!validMetaName(name) || !Array.isArray(value.multi[name])) fail('ast-grep returned an invalid multi meta variable');
      multi[name] = value.multi[name].slice(0, MAX_META_ITEMS).map((item) => parseMetaNode(item, MAX_META_TEXT / 2));
    }
  }
  if (value.transformed !== undefined) {
    if (!plainObject(value.transformed)) fail('ast-grep returned invalid transformed meta variables');
    for (const name of Object.keys(value.transformed).slice(0, MAX_META_ENTRIES)) {
      const text = value.transformed[name];
      if (!validMetaName(name) || typeof text !== 'string') fail('ast-grep returned an invalid transformed meta variable');
      transformed[name] = cleanText(text, MAX_META_TEXT);
    }
  }
  return { single, multi, transformed };
}

function parseMatch(raw, requestedLanguage) {
  if (!plainObject(raw) || typeof raw.text !== 'string') fail('ast-grep returned an invalid match');
  const range = parseRange(raw.range, 'range');
  if (raw.language !== undefined) {
    const reported = typeof raw.language === 'string' ? normalizeLanguage(raw.language) : null;
    if (!reported) fail('ast-grep returned an invalid match language');
    if (reported !== requestedLanguage) fail('ast-grep returned a match for a different language');
  }
  return {
    text: cleanText(raw.text, MAX_AST_GREP_MATCH_TEXT),
    textTruncated: raw.text.length > MAX_AST_GREP_MATCH_TEXT,
    line: range.from.line,
    column: range.from.column,
    endLine: range.to.line,
    endColumn: range.to.column,
    byteOffset: range.offset,
    metaVariables: parseMetaVariables(raw.metaVariables),
  };
}

function parseStream(output, maxMatches, requestedLanguage) {
  const matches = [];
  let truncated = false;
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      fail('ast-grep returned invalid JSON in the match stream');
    }
    matches.push(parseMatch(raw, requestedLanguage));
  }
  return { matches, truncated };
}

function runAstGrep({ command, args, cwd, env, language, pattern, source, timeoutMs, maxOutputBytes, maxMatches }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args, 'run', '--stdin', '--lang', language, '--pattern', pattern, '--json=stream', '--color', 'never'], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new AstGrepProviderError(`ast-grep failed to start: ${safeMessage(error?.message)}`));
      return;
    }

    let settled = false;
    let outputBytes = 0;
    let output = '';
    const stop = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const escalate = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 250);
      escalate.unref?.();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        stop();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(new AstGrepProviderError(`ast-grep timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > maxOutputBytes) {
        finish(new AstGrepProviderError(`ast-grep output exceeds ${maxOutputBytes} bytes`));
        return;
      }
      output += chunk;
    });
    child.stdout.on('error', () => finish(new AstGrepProviderError('ast-grep output stream failed')));
    child.stderr.on('data', () => {});
    child.stderr.on('error', () => {});
    child.stdin.on('error', (error) => finish(new AstGrepProviderError(`ast-grep input failed: ${safeMessage(error?.message)}`)));
    child.once('error', (error) => finish(new AstGrepProviderError(`ast-grep failed to start: ${safeMessage(error?.code ?? error?.message)}`)));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code === 1) {
        finish(null, { matches: [], truncated: false });
        return;
      }
      if (code !== 0) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        finish(new AstGrepProviderError(`ast-grep exited with ${detail}`));
        return;
      }
      try {
        finish(null, parseStream(output, maxMatches, language));
      } catch (error) {
        finish(error);
      }
    });
    try {
      child.stdin.end(source);
    } catch {
      finish(new AstGrepProviderError('ast-grep input could not be written'));
    }
  });
}

export function createAstGrepProvider(options = {}) {
  if (!plainObject(options)) fail('ast-grep provider options must be an object');
  const {
    command,
    args = [],
    cwd = process.cwd(),
    timeoutMs = DEFAULT_AST_GREP_TIMEOUT_MS,
    maxOutputBytes = MAX_AST_GREP_OUTPUT_BYTES,
    id = AST_GREP_PROVIDER_ID,
    env = {},
  } = options;
  validateCommand(command);
  if (!Array.isArray(args) || args.length > MAX_ARGS ||
      !args.every((value) => typeof value === 'string' && value.length <= MAX_ARG_LENGTH && !value.includes('\0'))) {
    fail(`args must be an array of at most ${MAX_ARGS} short strings`);
  }
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LENGTH || cwd.includes('\0')) {
    fail('cwd must be a non-empty path');
  }
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) fail('id must be a short lowercase identifier');
  validateInteger('timeoutMs', timeoutMs, MIN_TIMEOUT_MS, MAX_AST_GREP_TIMEOUT_MS);
  validateInteger('maxOutputBytes', maxOutputBytes, MIN_OUTPUT_BYTES, MAX_AST_GREP_OUTPUT_BYTES);
  const environment = sanitizeAstGrepEnvironment(process.env, env);

  const query = async (source, queryOptions) => {
    if (typeof source !== 'string') fail('source must be a string');
    if (Buffer.byteLength(source, 'utf8') > MAX_AST_GREP_SOURCE_BYTES) {
      fail(`source exceeds ${MAX_AST_GREP_SOURCE_BYTES} bytes`);
    }
    const { pattern, language, maxMatches } = validateQueryOptions(queryOptions);
    const result = await runAstGrep({
      command, args, cwd, env: environment, language, pattern, source, timeoutMs, maxOutputBytes, maxMatches,
    });
    return { pattern, language, matches: result.matches, truncated: result.truncated, sourceTrust: 'untrusted-source-content' };
  };

  return Object.freeze({
    id,
    languages: AST_GREP_LANGUAGES,
    query,
    search: query,
  });
}
