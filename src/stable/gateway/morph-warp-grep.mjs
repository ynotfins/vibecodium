// M2 B6 WarpGrep code-search agent tool.
//
// The tool runs a bounded, read-only tool loop over one workspace with the `morph-warp-grep-v2.1`
// model through the existing B1 provider client. The caller supplies a B1 client; this module
// selects the WarpGrep model itself. The module owns the `codebase_search` definition, its five
// read-only loop tools (`grep_search`, `glob`, `list_directory`, `read`, `finish`), strict path and
// argument validation, bounded file reads and the finish result. It never reads an environment
// variable, stores a credential, writes a file or exposes a query, file body or response body in an
// error.

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

export const MORPH_WARP_GREP_VERSION = 1;
export const WARP_GREP_MODEL = 'morph-warp-grep-v2.1';
export const MAX_SEARCH_CHARS = 2000;
export const MAX_TURNS = 6;
export const MAX_TOOL_CALLS = 8;
export const MAX_TOTAL_TOOL_CALLS = 24;
export const MAX_FINISH_FILES = 32;
export const MAX_FILE_CONTENT_CHARS = 32768;
export const MAX_RESULT_CHARS = 262144;
export const MAX_GREP_LINES = 200;
export const MAX_READ_LINES = 400;
export const MAX_TOOL_OUTPUT_CHARS = 32768;
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_WALK_ENTRIES = 20000;
export const MAX_WALK_DEPTH = 16;
export const MAX_GREP_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_PATTERN_CHARS = 200;
export const MAX_PATH_CHARS = 1024;
export const MAX_GLOB_CHARS = 256;
export const MAX_TOOL_ARGUMENT_CHARS = 65536;

const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
// Characters the B1 client refuses in a message. Workspace text can contain them, so every tool
// result and the repo-structure listing replace them before the next request instead of aborting
// the whole search with a provider validation error.
const UNSAFE_MESSAGE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu;
const UNSAFE_ARGUMENT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const ENCODED_SEPARATOR = /%(?:2e|2f|5c)/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const OPTION_KEYS = new Set(['client', 'workspaceRoot']);
const INPUT_KEYS = new Set(['search_string', 'search_type', 'repo_path']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SEARCH_TYPES = new Set(['default', 'node_modules']);
const DEFAULT_EXCLUDES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  '.next',
  '.cache',
  '.turbo',
]);
// Credential-shaped files are never searched, read or returned by the walk or an explicit path.
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc|\.netrc|\.pgpass|\.htpasswd|\.npmrc|\.pypirc|\.vault-token|\.git-credentials|\.aws|\.azure|\.ssh|\.docker|\.kube|\.gnupg|credentials(?:\.json)?|service-account\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keystore|ppk))$/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const SYSTEM_PROMPT = [
  'You are a code search sub-agent. Find the files and line ranges that answer the user question.',
  'Use grep_search to locate text and read to inspect files. Paths are relative to the workspace root.',
  'Probe more than one term when the first search is empty.',
  'When you are confident, call finish with one whitespace-separated token per file: path or path:start-end (ranges separated by commas).',
  'Return only files you have actually inspected. Do not describe files you did not read.',
].join(' ');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export const CODEBASE_SEARCH_TOOL = deepFreeze({
  type: 'function',
  function: {
    name: 'codebase_search',
    description: 'Search the workspace for the files and line ranges that answer a natural-language question. Ask what you want to understand, not a bare symbol.',
    parameters: {
      type: 'object',
      properties: {
        search_string: {
          type: 'string',
          description: 'A natural-language question about the code, for example "Where is auth handled and which oauth methods exist?".',
        },
        search_type: {
          type: 'string',
          enum: ['default', 'node_modules'],
          description: 'default searches project files and skips dependencies; node_modules also searches installed packages.',
        },
        repo_path: {
          type: 'string',
          description: 'Absolute path of the repository. When present it must be the configured workspace root.',
        },
      },
      required: ['search_string'],
      additionalProperties: false,
    },
  },
});

const LOOP_TOOLS = deepFreeze([
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search workspace text files for a literal string. Returns matching lines as path:line: text.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Literal text to find, not a regular expression.' },
          path: { type: 'string', description: 'Optional workspace-relative directory to limit the search.' },
          glob: { type: 'string', description: 'Optional workspace-relative glob such as src/**/*.mjs.' },
          case_sensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'List workspace files whose path matches a glob such as src/**/*.mjs.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern relative to the workspace root.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the entries of one workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory. Omit for the root.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a workspace file, whole or as line ranges. Returns numbered lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          lines: { type: 'string', description: 'Optional line range such as 1-50 or 1-20,45-80. Omit to read the file.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Finish the search with the files that answer the question.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'string',
            description: 'Whitespace-separated tokens of path or path:start-end, for example src/a.mjs:1-20 src/b.mjs.',
          },
        },
        required: ['files'],
        additionalProperties: false,
      },
    },
  },
]);

// Executor-side descriptions of the WarpGrep model's built-in tools. They document what this module
// implements locally and are never sent as a `tools` array: the WarpGrep model has these tools built
// in (docs.morphllm.com, WarpGrep Direct API, read 2026-11-26), so sending them would be off-protocol.
export const WARP_GREP_TOOLS = LOOP_TOOLS;

export class WarpGrepError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'WarpGrepError';
    this.code = code;
    if (Number.isInteger(extra.status)) this.status = extra.status;
  }
}

function fail(code, message, extra) {
  throw new WarpGrepError(code, message, extra);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

function ownData(object, key, code, label) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    fail(code, label + ' cannot be read');
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) fail(code, label + ' must be a data property');
  return descriptor.value;
}

function ownKeys(object, code, label) {
  let keys;
  try {
    keys = Object.keys(object);
  } catch {
    fail(code, label + ' cannot be enumerated');
  }
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) fail(code, label + ' has duplicate keys');
    seen.add(key);
  }
  return keys;
}

function readOptions(options) {
  if (!isPlainObject(options)) fail('invalid-options', 'options must be a plain object');
  const keys = ownKeys(options, 'invalid-options', 'options');
  for (const key of keys) {
    if (RESERVED_KEYS.has(key) || !OPTION_KEYS.has(key)) fail('invalid-options', 'unknown option');
  }
  for (const key of OPTION_KEYS) {
    if (!keys.includes(key)) fail('invalid-options', 'missing option: ' + key);
  }
  const client = ownData(options, 'client', 'invalid-options', 'client');
  const workspaceRoot = ownData(options, 'workspaceRoot', 'invalid-options', 'workspace root');
  if (!isPlainObject(client) || typeof ownData(client, 'chat', 'invalid-options', 'client') !== 'function') {
    fail('invalid-options', 'client must expose chat');
  }
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0 || workspaceRoot.length > MAX_PATH_CHARS ||
      CONTROL_OR_BIDI.test(workspaceRoot) || !isAbsolute(workspaceRoot)) {
    fail('invalid-options', 'workspaceRoot must be an absolute path');
  }
  return { client, workspaceRoot: resolve(workspaceRoot) };
}

function readInput(input) {
  if (!isPlainObject(input)) fail('invalid-input', 'codebase_search input must be a plain object');
  const keys = ownKeys(input, 'invalid-input', 'codebase_search input');
  for (const key of keys) {
    if (RESERVED_KEYS.has(key) || !INPUT_KEYS.has(key)) fail('invalid-input', 'unknown codebase_search field');
  }
  if (!keys.includes('search_string')) fail('invalid-input', 'missing codebase_search field: search_string');
  const searchString = ownData(input, 'search_string', 'invalid-input', 'search_string');
  const searchType = keys.includes('search_type')
    ? ownData(input, 'search_type', 'invalid-input', 'search_type')
    : 'default';
  const repoPath = keys.includes('repo_path')
    ? ownData(input, 'repo_path', 'invalid-input', 'repo_path')
    : undefined;
  if (typeof searchString !== 'string' || searchString.length === 0 ||
      searchString.length > MAX_SEARCH_CHARS || CONTROL_OR_BIDI.test(searchString) ||
      !searchString.isWellFormed()) {
    fail('invalid-input', 'search_string is invalid');
  }
  if (typeof searchType !== 'string' || !SEARCH_TYPES.has(searchType)) {
    fail('invalid-input', 'search_type is invalid');
  }
  if (repoPath !== undefined) {
    if (typeof repoPath !== 'string' || repoPath.length === 0 || repoPath.length > MAX_PATH_CHARS ||
        CONTROL_OR_BIDI.test(repoPath) || !isAbsolute(repoPath)) {
      fail('invalid-input', 'repo_path must be an absolute path');
    }
  }
  return { searchString, searchType, repoPath };
}

function normalizeForCompare(value) {
  const normalized = value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function toWorkspaceRelative(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

function validSegments(value) {
  if (CONTROL_OR_BIDI.test(value) || isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
      value.startsWith('\\') || value.startsWith('/') || ENCODED_SEPARATOR.test(value)) {
    return null;
  }
  let normalized = value.replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized === '' || normalized === '.') return [];
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes(':') ||
        (process.platform === 'win32' && segment !== segment.replace(/[. ]+$/u, '')) ||
        CONTROL_OR_BIDI.test(segment) || WINDOWS_RESERVED.test(segment)) {
      return null;
    }
  }
  return segments;
}

function matchGlobSegment(pattern, text) {
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let mark = 0;
  while (textIndex < text.length) {
    if (patternIndex < pattern.length && (pattern[patternIndex] === '?' || pattern[patternIndex] === text[textIndex])) {
      patternIndex += 1;
      textIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      patternIndex += 1;
      mark = textIndex;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      textIndex = ++mark;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

// Linear glob matching over path segments. One segment uses a greedy single-star walk and
// `**` spans zero or more segments, so a model-supplied glob cannot backtrack like a regex.
function globMatches(glob, candidate) {
  const pattern = glob.split('/');
  const segments = candidate.split('/');
  let patternIndex = 0;
  let segmentIndex = 0;
  let starIndex = -1;
  let mark = 0;
  while (segmentIndex < segments.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === '**') {
      starIndex = patternIndex;
      patternIndex += 1;
      mark = segmentIndex;
    } else if (patternIndex < pattern.length && matchGlobSegment(pattern[patternIndex], segments[segmentIndex])) {
      patternIndex += 1;
      segmentIndex += 1;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      segmentIndex = ++mark;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === '**') patternIndex += 1;
  return patternIndex === pattern.length;
}

async function readTextFile(absolute) {
  const before = await lstat(absolute).catch(() => null);
  if (before === null || before.isSymbolicLink() || !before.isFile()) return null;
  if (before.size > MAX_SOURCE_BYTES) return null;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  let buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size > MAX_SOURCE_BYTES) {
      return null;
    }
    buffer = await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
  if (buffer.byteLength > MAX_SOURCE_BYTES) return null;
  if (buffer.includes(0)) return null;
  try {
    return UTF8.decode(buffer);
  } catch {
    return null;
  }
}

function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// A tool result or a listing can contain characters the B1 client refuses (format, bidi and C1
// characters); replacing them keeps the search alive without echoing the unsafe sequence.
function sanitizeToolText(text) {
  return text.replace(UNSAFE_MESSAGE_CHARS, '\uFFFD');
}

// Win32 and the default macOS filesystem are case-insensitive, and Win32 also strips trailing dots
// and spaces, so `.GIT`, `.git.` and `.Git ` all alias the excluded name. Normalise before comparing.
function normalizedName(name) {
  const trimmed = process.platform === 'win32' ? name.replace(/[. ]+$/u, '') : name;
  return process.platform === 'win32' || process.platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
}

function excluded(name, searchType) {
  const normalized = normalizedName(name);
  if (normalized.length > 0 && SECRET_NAME.test(normalized)) return true;
  if (normalized === '.git') return true;
  if (normalized === 'node_modules') return searchType !== 'node_modules';
  return normalized.length > 0 && DEFAULT_EXCLUDES.has(normalized);
}

// Applies the walk exclusions to every segment of a resolved workspace-relative path, so an
// explicit `read`, `finish` or `grep_search` path cannot reach `.git`, dependency or build folders.
function hasExcludedSegment(relativePath, searchType) {
  if (relativePath === '') return false;
  for (const segment of relativePath.split('/')) {
    if (excluded(segment, searchType)) return true;
  }
  return false;
}

// A trained WarpGrep call often sends a plain alternation such as `import|require`. A pattern that
// is only plain words joined by `|` matches any alternative; anything else is matched literally.
function patternNeedles(pattern, caseSensitive) {
  const parts = pattern.split('|');
  const meta = /[.^$*+?()[\]{}]/;
  const plain = parts.length > 1 && parts.every((part) => part.length > 0 && meta.test(part) === false);
  const list = plain ? parts : [pattern];
  return list.map((part) => (caseSensitive ? part : part.toLowerCase()));
}

async function grepWorkspace(root, startDirectory, searchType, options) {
  const needles = patternNeedles(options.pattern, options.caseSensitive);
  const glob = options.glob === undefined ? undefined : options.glob;
  const collected = [];
  let chars = 0;
  let bytes = 0;
  let entries = 0;
  let truncated = false;

  async function walk(directory, depth) {
    if (truncated || depth > MAX_WALK_DEPTH) return;
    let listing;
    try {
      listing = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    listing.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of listing) {
      if (truncated) return;
      entries += 1;
      if (entries > MAX_WALK_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      if (excluded(entry.name, searchType)) continue;
      if (entry.isDirectory()) {
        await walk(resolve(directory, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const absolute = resolve(directory, entry.name);
      const relativePath = toWorkspaceRelative(root, absolute);
      if (glob !== undefined && globMatches(glob, relativePath) === false) continue;
      const text = await readTextFile(absolute);
      if (text === null) continue;
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_GREP_TOTAL_BYTES) {
        truncated = true;
        return;
      }
      const lines = splitLines(text);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const haystack = options.caseSensitive ? line : line.toLowerCase();
        if (needles.some((needle) => haystack.includes(needle)) === false) continue;
        const rendered = relativePath + ':' + (index + 1) + ': ' + line;
        if (collected.length >= MAX_GREP_LINES || chars + rendered.length > MAX_TOOL_OUTPUT_CHARS - 32) {
          if (collected.length === 0) {
            collected.push(rendered.slice(0, MAX_TOOL_OUTPUT_CHARS - 40) + ' (line truncated)');
          }
          truncated = true;
          return;
        }
        collected.push(rendered);
        chars += rendered.length + 1;
      }
    }
  }

  await walk(startDirectory, 0);
  if (collected.length === 0) return truncated ? 'no matches (truncated)' : 'no matches';
  if (truncated) collected.push('(truncated)');
  return collected.join('\n');
}

function parseRanges(value) {
  if (value === undefined) return [];
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || !value.isWellFormed()) return null;
  const ranges = [];
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(trimmed);
    if (match === null) return null;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
    ranges.push([start, end]);
  }
  if (ranges.length === 0) return null;
  return ranges;
}

function selectLines(lines, ranges, limit) {
  const parts = [];
  let chars = 0;
  const push = (line) => {
    if (chars + line.length + 1 > limit) return false;
    parts.push(line);
    chars += line.length + 1;
    return true;
  };
  if (ranges.length === 0) {
    for (const line of lines) {
      if (push(line) === false) return null;
    }
    return parts.join('\n');
  }
  for (const [start, end] of ranges) {
    if (start > lines.length) return null;
    const last = Math.min(end, lines.length);
    for (let index = start; index <= last; index += 1) {
      if (push(lines[index - 1]) === false) return null;
    }
  }
  return parts.join('\n');
}

// Resolves a model-supplied path. A relative path is validated segment by segment; an absolute
// path is accepted only when it resolves inside the workspace root. Both are then canonicalised.
function resolveModelPath(root, value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_PATH_CHARS || !value.isWellFormed()) return null;
  if (isAbsolute(value)) {
    if (CONTROL_OR_BIDI.test(value) || ENCODED_SEPARATOR.test(value)) return null;
    const absolute = resolve(value);
    if (absolute !== root && !isContained(root, absolute)) return null;
    return absolute;
  }
  const segments = validSegments(value);
  if (segments === null) return null;
  if (segments.length === 0) return root;
  const target = resolve(root, ...segments);
  return isContained(root, target) ? target : null;
}

async function resolveWorkspaceFile(root, value, searchType) {
  const target = resolveModelPath(root, value);
  if (target === null) return null;
  const before = await lstat(target).catch(() => null);
  if (before === null || before.isSymbolicLink() || !before.isFile()) return null;
  const real = await realpath(target).catch(() => null);
  if (real === null || !isContained(root, real)) return null;
  const relativePath = toWorkspaceRelative(root, real);
  if (hasExcludedSegment(relativePath, searchType)) return null;
  return { target: real, relativePath };
}

async function resolveWorkspaceDirectory(root, value, searchType) {
  const target = resolveModelPath(root, value);
  if (target === null) return null;
  if (target === root) return root;
  const info = await lstat(target).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) return null;
  const real = await realpath(target).catch(() => null);
  if (real === null || !isContained(root, real)) return null;
  if (hasExcludedSegment(toWorkspaceRelative(root, real), searchType)) return null;
  return real;
}

async function toolGlob(root, searchType, args) {
  const pattern = args.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_GLOB_CHARS ||
      !pattern.isWellFormed() || CONTROL_OR_BIDI.test(pattern)) {
    return 'error: glob pattern is invalid';
  }
  const collected = [];
  let entries = 0;
  let totalChars = 0;
  let truncated = false;
  async function walk(directory, depth) {
    if (truncated || depth > MAX_WALK_DEPTH) return;
    let listing;
    try {
      listing = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    listing.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of listing) {
      if (truncated) return;
      entries += 1;
      if (entries > MAX_WALK_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      if (excluded(entry.name, searchType)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = toWorkspaceRelative(root, absolute);
      if (globMatches(pattern, relativePath) === false) continue;
      if (collected.length >= MAX_GREP_LINES ||
          totalChars + relativePath.length + 1 > MAX_TOOL_OUTPUT_CHARS - 16) {
        truncated = true;
        return;
      }
      collected.push(relativePath);
      totalChars += relativePath.length + 1;
    }
  }
  await walk(root, 0);
  if (collected.length === 0) return 'no matches';
  if (truncated) collected.push('(truncated)');
  return collected.join('\n');
}
async function toolListDirectory(root, searchType, args) {
  const value = args.path === undefined ? '.' : args.path;
  if (typeof value !== 'string') return 'error: list_directory path is invalid';
  const directory = await resolveWorkspaceDirectory(root, value, searchType);
  if (directory === null) return 'error: list_directory path must be a directory inside the workspace';
  let listing;
  try {
    listing = await readdir(directory, { withFileTypes: true });
  } catch {
    return 'error: list_directory failed';
  }
  const out = [];
  let chars = 0;
  for (const entry of listing.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (entry.isSymbolicLink() || excluded(entry.name, searchType)) continue;
    const rendered = entry.name + (entry.isDirectory() ? '/' : '');
    if (out.length >= 500 || chars + rendered.length + 1 > MAX_TOOL_OUTPUT_CHARS) {
      out.push('(truncated)');
      break;
    }
    out.push(rendered);
    chars += rendered.length + 1;
  }
  return out.length === 0 ? '(empty)' : out.join('\n');
}

async function toolGrep(root, searchType, args) {
  const keys = Object.keys(args);
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) return 'error: unknown grep_search field';
  }
  const pattern = args.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN_CHARS ||
      CONTROL_OR_BIDI.test(pattern) || !pattern.isWellFormed()) {
    return 'error: grep_search pattern is invalid';
  }
  let glob;
  if (args.glob !== undefined) {
    if (typeof args.glob !== 'string' || args.glob.length === 0 || args.glob.length > MAX_GLOB_CHARS ||
        !args.glob.isWellFormed() || CONTROL_OR_BIDI.test(args.glob)) {
      return 'error: grep_search glob is invalid';
    }
    glob = args.glob;
  }
  let caseSensitive = args.case_sensitive === true;
  if (typeof args.case_sensitive === 'string') {
    if (args.case_sensitive.toLowerCase() === 'true') caseSensitive = true;
    else if (args.case_sensitive.toLowerCase() === 'false') caseSensitive = false;
    else return 'error: grep_search case_sensitive is invalid';
  } else if (args.case_sensitive !== undefined && typeof args.case_sensitive !== 'boolean') {
    return 'error: grep_search case_sensitive is invalid';
  }
  let startDirectory = root;
  if (args.path !== undefined) {
    if (typeof args.path !== 'string' || args.path.length === 0 || args.path.length > MAX_PATH_CHARS) {
      return 'error: grep_search path is invalid';
    }
    const directory = await resolveWorkspaceDirectory(root, args.path, searchType);
    if (directory === null) return 'error: grep_search path must be a directory inside the workspace';
    startDirectory = directory;
  }
  try {
    return await grepWorkspace(root, startDirectory, searchType, {
      pattern,
      glob,
      caseSensitive,
    });
  } catch {
    return 'error: grep_search failed';
  }
}

function renderNumbered(lines, ranges) {
  const out = [];
  let chars = 0;
  let truncated = false;
  const emit = (index) => {
    if (out.length >= MAX_READ_LINES) {
      truncated = true;
      return false;
    }
    const text = index + '| ' + lines[index - 1];
    if (chars + text.length + 1 > MAX_TOOL_OUTPUT_CHARS) {
      if (out.length === 0) out.push(text.slice(0, MAX_TOOL_OUTPUT_CHARS));
      truncated = true;
      return false;
    }
    out.push(text);
    chars += text.length + 1;
    return true;
  };
  if (ranges.length === 0) {
    for (let index = 1; index <= lines.length; index += 1) {
      if (emit(index) === false) break;
    }
  } else {
    for (const [start, end] of ranges) {
      if (start > lines.length) return null;
      const last = Math.min(end, lines.length);
      let stopped = false;
      for (let index = start; index <= last; index += 1) {
        if (emit(index) === false) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
  }
  const text = out.join('\n');
  return truncated ? text + '\n(truncated)' : text;
}

async function toolRead(root, args, searchType) {
  const keys = Object.keys(args);
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) return 'error: unknown read field';
  }
  const value = args.path;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_CHARS) {
    return 'error: read path is invalid';
  }
  const ranges = parseRanges(args.lines);
  if (ranges === null) return 'error: read lines is invalid';
  const file = await resolveWorkspaceFile(root, value, searchType);
  if (file === null) return 'error: read path must be a file inside the workspace';
  const text = await readTextFile(file.target);
  if (text === null) return 'error: read path is not a readable text file';
  const lines = splitLines(text);
  const rendered = renderNumbered(lines, ranges);
  if (rendered === null) return 'error: read lines are outside the file';
  return rendered;
}

function parseFinishArguments(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_TOOL_ARGUMENT_CHARS) {
    fail('invalid-finish', 'finish arguments are too large');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('invalid-finish', 'finish arguments are not valid JSON');
  }
  if (!isPlainObject(parsed)) fail('invalid-finish', 'finish arguments must be an object');
  const keys = ownKeys(parsed, 'invalid-finish', 'finish arguments');
  for (const key of keys) {
    if (RESERVED_KEYS.has(key) || key !== 'files') fail('invalid-finish', 'unknown finish field');
  }
  const files = ownData(parsed, 'files', 'invalid-finish', 'finish files');
  if (typeof files !== 'string' || files.length === 0 || files.length > 8192 ||
      UNSAFE_ARGUMENT.test(files) || !files.isWellFormed()) {
    fail('invalid-finish', 'finish files is invalid');
  }
  const tokens = files.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_FINISH_FILES) fail('invalid-finish', 'finish files is invalid');
  return tokens.map((token) => {
    const colon = token.indexOf(':', token.length > 2 && token[1] === ':' ? 2 : 0);
    const pathPart = colon === -1 ? token : token.slice(0, colon);
    const rangePart = colon === -1 ? '*' : token.slice(colon + 1);
    if (rangePart === '' || rangePart === '*') return { path: pathPart, ranges: [] };
    const ranges = parseRanges(rangePart);
    if (ranges === null) fail('invalid-finish', 'finish range is invalid');
    return { path: pathPart, ranges };
  });
}

async function buildResult(root, entries, turn, usage, searchType) {
  const files = [];
  let total = 0;
  for (const entry of entries) {
    const file = await resolveWorkspaceFile(root, entry.path, searchType);
    if (file === null) fail('invalid-finish', 'finish path must be a file inside the workspace');
    const text = await readTextFile(file.target);
    if (text === null) fail('invalid-finish', 'finish path is not a readable text file');
    const lines = splitLines(text);
    for (const [start, end] of entry.ranges) {
      if (start > lines.length) fail('invalid-finish', 'finish range is outside the file');
      if (end < start) fail('invalid-finish', 'finish range is outside the file');
    }
    const budget = Math.min(MAX_FILE_CONTENT_CHARS, MAX_RESULT_CHARS - total);
    const content = selectLines(lines, entry.ranges, budget);
    if (content === null) fail('result-too-large', 'WarpGrep result is too large');
    total += content.length;
    if (total > MAX_RESULT_CHARS) fail('result-too-large', 'WarpGrep result is too large');
    files.push(Object.freeze({
      path: file.relativePath,
      ranges: Object.freeze(entry.ranges.map((range) => Object.freeze([range[0], range[1]]))),
      content,
    }));
  }
  if (files.length === 0) fail('invalid-finish', 'finish returned no files');
  return Object.freeze({
    files: Object.freeze(files),
    searchType,
    turns: turn,
    usage: Object.freeze({ ...usage, totalTokens: usage.inputTokens + usage.outputTokens }),
  });
}

function usageOf(answer) {
  const usage = answer !== null && typeof answer === 'object' ? answer.usage : undefined;
  const input = usage !== null && typeof usage === 'object' && Number.isInteger(usage.inputTokens) && usage.inputTokens >= 0
    ? usage.inputTokens
    : 0;
  const output = usage !== null && typeof usage === 'object' && Number.isInteger(usage.outputTokens) && usage.outputTokens >= 0
    ? usage.outputTokens
    : 0;
  return { inputTokens: input, outputTokens: output };
}

// A bounded flat listing of the workspace, depth two, sent as the documented <repo_structure> block.
async function buildRepoStructure(root, searchType) {
  const entries = [];
  async function walk(directory, depth) {
    if (depth > 2 || entries.length >= 200) return;
    let listing;
    try {
      listing = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    listing.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of listing) {
      if (entries.length >= 200) return;
      if (entry.isSymbolicLink() || excluded(entry.name, searchType)) continue;
      const absolute = resolve(directory, entry.name);
      const relativePath = toWorkspaceRelative(root, absolute);
      const rendered = sanitizeToolText(relativePath + (entry.isDirectory() ? '/' : ''));
      if (entries.length === 0 || entries[entries.length - 1] !== rendered) {
        if (entries.join('\n').length + rendered.length + 1 > MAX_TOOL_OUTPUT_CHARS) return;
        entries.push(rendered);
      }
      if (entry.isDirectory()) await walk(absolute, depth + 1);
    }
  }
  await walk(root, 1);
  return entries.join('\n');
}

export function createMorphWarpGrepTool(options) {
  const config = readOptions(options);
  let rootReal;
  let rootRealPath;

  async function root() {
    if (rootReal !== undefined) return rootReal;
    const real = await realpath(config.workspaceRoot).catch(() => null);
    if (real === null) fail('invalid-options', 'workspaceRoot does not exist');
    const info = await stat(real).catch(() => null);
    if (info === null || !info.isDirectory()) fail('invalid-options', 'workspaceRoot must be a directory');
    rootReal = real;
    rootRealPath = normalFor(real);
    return rootReal;
  }

  function normalFor(value) {
    return normalizeForCompare(value);
  }

  async function execute(input) {
    const request = readInput(input);
    const workspace = await root();
    if (request.repoPath !== undefined) {
      const repoReal = await realpath(request.repoPath).catch(() => null);
      if (repoReal === null || (normalizeForCompare(repoReal) !== rootRealPath &&
          normalizeForCompare(resolve(request.repoPath)) !== rootRealPath)) {
        fail('outside-workspace', 'repo_path must be the configured workspace root');
      }
    }
    const structure = await buildRepoStructure(workspace, request.searchType);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: '<repo_structure>\n' + structure + '\n</repo_structure>\n\n<search_string>' +
          request.searchString + '</search_string>',
      },
    ];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let toolCallsTotal = 0;
    for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
      let answer;
      try {
        answer = await config.client.chat({ model: WARP_GREP_MODEL, messages });
      } catch (error) {
        let status;
        try {
          status = Number.isInteger(error?.status) ? error.status : undefined;
        } catch {
          status = undefined;
        }
        fail('provider-error', 'WarpGrep model call failed', { status });
      }
      let text;
      let turnUsage;
      let calls;
      try {
        if (answer === null || typeof answer !== 'object') fail('invalid-response', 'WarpGrep returned an invalid answer');
        text = answer.text;
        const rawCalls = answer.toolCalls;
        turnUsage = usageOf(answer);
        if (typeof text !== 'string' || !Array.isArray(rawCalls)) {
          fail('invalid-response', 'WarpGrep returned an invalid answer');
        }
        calls = [];
        for (const call of rawCalls) {
          if (call === null || typeof call !== 'object') fail('invalid-response', 'WarpGrep returned an invalid tool call');
          const id = call.id;
          const name = call.name;
          const args = call.arguments;
          if (typeof id !== 'string' || id.length === 0 || id.length > 512 ||
              typeof name !== 'string' || name.length === 0 || name.length > 128 ||
              typeof args !== 'string' || args.length > 1000000) {
            fail('invalid-response', 'WarpGrep returned an invalid tool call');
          }
          // A non-finish call is echoed back to the provider before it is executed, so an
          // oversized one is refused here instead of being replayed into the next request. A
          // finish call is never echoed and its own parser bounds the file list.
          if (name !== 'finish' && args.length > MAX_TOOL_ARGUMENT_CHARS) {
            fail('invalid-response', 'WarpGrep returned an oversized tool call');
          }
          calls.push({ id, name, arguments: args });
        }
      } catch (error) {
        if (error instanceof WarpGrepError) throw error;
        fail('invalid-response', 'WarpGrep returned an invalid answer');
      }
      usage.inputTokens += turnUsage.inputTokens;
      usage.outputTokens += turnUsage.outputTokens;
      if (calls.length === 0) fail('no-tool-calls', 'WarpGrep produced no tool call');
      if (calls.length > MAX_TOOL_CALLS) fail('too-many-tool-calls', 'WarpGrep requested too many tool calls');
      toolCallsTotal += calls.length;
      if (toolCallsTotal > MAX_TOTAL_TOOL_CALLS) fail('too-many-tool-calls', 'WarpGrep requested too many tool calls');
      const finishCall = calls.find((call) => call.name === 'finish');
      if (finishCall !== undefined) {
        const entries = parseFinishArguments(finishCall.arguments);
        return buildResult(workspace, entries, turn, usage, request.searchType);
      }
      messages.push({
        role: 'assistant',
        content: sanitizeToolText(text),
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of calls) {
        const output = await runTool(workspace, request.searchType, call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
      const remaining = MAX_TURNS - turn;
      if (remaining > 0) {
        messages.push({
          role: 'user',
          content: 'You have used ' + turn + ' turn(s) and have ' + remaining +
            ' turn(s) remaining.' + (remaining === 1 ? ' You MUST call the finish tool now.' : ''),
        });
      }
    }
    fail('turn-limit', 'WarpGrep did not finish within the turn limit');
  }

  return Object.freeze({
    version: MORPH_WARP_GREP_VERSION,
    definition: CODEBASE_SEARCH_TOOL,
    execute,
    describe: () => describeMorphWarpGrep(),
  });
}

async function runTool(root, searchType, call) {
  if (typeof call.arguments !== 'string' || call.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
    return 'error: tool arguments are too large';
  }
  let args;
  try {
    args = JSON.parse(call.arguments === '' ? '{}' : call.arguments);
  } catch {
    return 'error: tool arguments are not valid JSON';
  }
  if (!isPlainObject(args)) return 'error: tool arguments must be an object';
  try {
    if (call.name === 'grep_search') return sanitizeToolText(await toolGrep(root, searchType, args));
    if (call.name === 'glob') return sanitizeToolText(await toolGlob(root, searchType, args));
    if (call.name === 'list_directory') return sanitizeToolText(await toolListDirectory(root, searchType, args));
    if (call.name === 'read') return sanitizeToolText(await toolRead(root, args, searchType));
  } catch {
    return 'error: tool failed';
  }
  return 'error: unknown tool';
}

export function describeMorphWarpGrep() {
  return Object.freeze({
    version: MORPH_WARP_GREP_VERSION,
    name: 'codebase_search',
    model: WARP_GREP_MODEL,
    maxTurns: MAX_TURNS,
  });
}
