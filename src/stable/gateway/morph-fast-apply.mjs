// M2 B6 Fast Apply agent tool.
//
// The tool merges one lazy edit into an existing workspace file through the existing B1 provider
// client. The caller supplies a client that is already scoped to the Fast Apply model. This
// module owns the `edit_file` definition, strict input and path validation, bounded file I/O,
// provider response validation and the atomic write. It never reads an environment variable,
// stores a credential or exposes the request or response body in an error.

import { constants } from 'node:fs';
import { lstat, open, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { TextDecoder } from 'node:util';

import { MAX_MESSAGE_CHARS } from './provider-client.mjs';

export const MORPH_FAST_APPLY_VERSION = 1;
export const FAST_APPLY_MODEL = 'morph-v3-fast';
export const MAX_TARGET_CHARS = 1024;
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_EDIT_CHARS = 1024 * 1024;
export const MAX_INSTRUCTION_CHARS = 4000;
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_EDIT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNSAFE_SOURCE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const ENCODED_SEPARATOR = /%(?:2e|2f|5c)/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const OPTION_KEYS = new Set(['client', 'workspaceRoot']);
const INPUT_KEYS = new Set(['target_file', 'code_edit', 'instructions']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export const EDIT_FILE_TOOL = deepFreeze({
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Edit an existing workspace file through Fast Apply. Use // ... existing code ... for unchanged sections.',
    parameters: {
      type: 'object',
      properties: {
        target_file: {
          type: 'string',
          description: 'The path of the existing file to edit, relative to the workspace root.',
        },
        code_edit: {
          type: 'string',
          description: 'The code changes to apply. Use // ... existing code ... for unchanged sections.',
        },
        instructions: {
          type: 'string',
          description: 'A brief description of what the edit does.',
        },
      },
      required: ['target_file', 'code_edit', 'instructions'],
      additionalProperties: false,
    },
  },
});

export class FastApplyError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'FastApplyError';
    this.code = code;
    if (Number.isInteger(extra.status)) this.status = extra.status;
  }
}

function fail(code, message, extra) {
  throw new FastApplyError(code, message, extra);
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

function keysOf(value, label) {
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-options', label + ' cannot be enumerated');
  }
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) fail('invalid-options', label + ' has duplicate keys');
    seen.add(key);
  }
  return keys;
}

function readOptions(options) {
  if (!isPlainObject(options)) fail('invalid-options', 'options must be a plain object');
  const keys = keysOf(options, 'options');
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
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0 || workspaceRoot.length > MAX_TARGET_CHARS ||
      CONTROL_OR_BIDI.test(workspaceRoot) || !isAbsolute(workspaceRoot)) {
    fail('invalid-options', 'workspaceRoot must be an absolute path');
  }
  return { client, workspaceRoot: resolve(workspaceRoot) };
}

function readInput(input) {
  if (!isPlainObject(input)) fail('invalid-input', 'edit_file input must be a plain object');
  let keys;
  try {
    keys = Object.keys(input);
  } catch {
    fail('invalid-input', 'edit_file input cannot be enumerated');
  }
  for (const key of keys) {
    if (RESERVED_KEYS.has(key) || !INPUT_KEYS.has(key)) fail('invalid-input', 'unknown edit_file field');
  }
  for (const key of INPUT_KEYS) {
    if (!keys.includes(key)) fail('invalid-input', 'missing edit_file field: ' + key);
  }
  const target = ownData(input, 'target_file', 'invalid-input', 'target_file');
  const codeEdit = ownData(input, 'code_edit', 'invalid-input', 'code_edit');
  const instructions = ownData(input, 'instructions', 'invalid-input', 'instructions');
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_TARGET_CHARS) {
    fail('invalid-target', 'target_file is invalid');
  }
  if (typeof codeEdit !== 'string' || codeEdit.length === 0 || codeEdit.length > MAX_EDIT_CHARS ||
      UNSAFE_EDIT.test(codeEdit) || !codeEdit.isWellFormed()) {
    fail('invalid-edit', 'code_edit is invalid');
  }
  if (typeof instructions !== 'string' || instructions.length === 0 ||
      instructions.length > MAX_INSTRUCTION_CHARS || CONTROL_OR_BIDI.test(instructions) ||
      !instructions.isWellFormed()) {
    fail('invalid-instructions', 'instructions is invalid');
  }
  return { targetFile: validateTarget(target), codeEdit, instructions };
}

function validateTarget(value) {
  if (CONTROL_OR_BIDI.test(value) || isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
      value.startsWith('\\') || value.startsWith('/') || ENCODED_SEPARATOR.test(value)) {
    fail('invalid-target', 'target_file must be a relative path inside the workspace');
  }
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes(':') ||
        CONTROL_OR_BIDI.test(segment) || WINDOWS_RESERVED.test(segment)) {
      fail('invalid-target', 'target_file must be a relative path inside the workspace');
    }
  }
  return segments;
}

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function renderPrompt(instructions, source, codeEdit) {
  return '<instruction>' + instructions + '</instruction>\n<code>' + source + '</code>\n<update>' + codeEdit + '</update>';
}

function validSource(text) {
  return text.length > 0 && UNSAFE_SOURCE.test(text) === false;
}

function validResult(text) {
  if (typeof text !== 'string' || text.length === 0) fail('empty-result', 'Fast Apply returned no merged code');
  if (!text.isWellFormed()) fail('ill-formed-result', 'Fast Apply returned ill-formed Unicode');
  if (UNSAFE_SOURCE.test(text)) fail('invalid-result', 'Fast Apply returned invalid source text');
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) fail('result-too-large', 'Fast Apply result is too large');
  return text;
}

async function openPinned(target, flags) {
  try {
    return await open(target, flags | (constants.O_NOFOLLOW ?? 0));
  } catch {
    fail('unsafe-target', 'target file could not be opened safely');
  }
}

async function readTarget(rootReal, segments) {
  const target = resolve(rootReal, ...segments);
  if (!isContained(rootReal, target)) fail('unsafe-target', 'target file must stay inside the workspace');
  const before = await lstat(target).catch(() => null);
  if (before === null) fail('target-not-found', 'target file does not exist');
  if (before.isSymbolicLink()) fail('unsafe-target', 'target file must not be a symbolic link');
  if (!before.isFile()) fail('not-a-file', 'target path is not a regular file');
  if (before.size > MAX_SOURCE_BYTES) fail('source-too-large', 'target file is too large');
  const real = await realpath(target).catch(() => null);
  if (real === null || !isContained(rootReal, real)) fail('unsafe-target', 'target file must stay inside the workspace');
  const handle = await openPinned(target, constants.O_RDONLY);
  let opened;
  let after;
  let buffer;
  try {
    opened = await handle.stat();
    after = await lstat(target).catch(() => null);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        after === null || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      fail('file-changed', 'target file changed while it was being read');
    }
    if (opened.size > MAX_SOURCE_BYTES) fail('source-too-large', 'target file is too large');
    buffer = await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
  if (buffer.byteLength > MAX_SOURCE_BYTES) fail('source-too-large', 'target file is too large');
  let source;
  try {
    source = UTF8.decode(buffer);
  } catch {
    fail('binary-source', 'target file is not valid UTF-8 text');
  }
  if (!validSource(source)) fail('binary-source', 'target file is not valid source text');
  return { target, source, identity: { dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs }, real };
}

async function assertUnchanged(target, expected, source) {
  const info = await lstat(target).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isFile() ||
      info.dev !== expected.dev || info.ino !== expected.ino || info.size !== expected.size) {
    fail('file-changed', 'target file changed while Fast Apply was running');
  }
  const handle = await openPinned(target, constants.O_RDONLY);
  try {
    const current = await handle.readFile();
    if (!current.equals(Buffer.from(source, 'utf8'))) {
      fail('file-changed', 'target file changed while Fast Apply was running');
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeMerged(rootReal, target, identity, source, merged) {
  const directory = dirname(target);
  if (directory !== rootReal && !isContained(rootReal, directory)) {
    fail('unsafe-target', 'target directory must stay inside the workspace');
  }
  const temporary = resolve(directory, '.' + basename(target) + '.vibe-apply-' + process.pid + '-' + randomBytes(8).toString('hex') + '.tmp');
  if (!isContained(rootReal, temporary)) fail('unsafe-target', 'temporary file must stay inside the workspace');
  try {
    await writeFile(temporary, merged, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await assertUnchanged(target, identity, source);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error instanceof FastApplyError) throw error;
    fail('write-failed', 'target file could not be replaced');
  }
}

function usageOf(answer) {
  const usage = answer !== null && typeof answer === 'object' ? answer.usage : undefined;
  const input = usage !== null && typeof usage === 'object' && Number.isInteger(usage.inputTokens) && usage.inputTokens >= 0
    ? usage.inputTokens
    : 0;
  const output = usage !== null && typeof usage === 'object' && Number.isInteger(usage.outputTokens) && usage.outputTokens >= 0
    ? usage.outputTokens
    : 0;
  return Object.freeze({ inputTokens: input, outputTokens: output, totalTokens: input + output });
}

export function createMorphFastApplyTool(options) {
  const config = readOptions(options);
  let rootReal;

  async function root() {
    if (rootReal !== undefined) return rootReal;
    const real = await realpath(config.workspaceRoot).catch(() => null);
    if (real === null) fail('invalid-options', 'workspaceRoot does not exist');
    const info = await stat(real).catch(() => null);
    if (info === null || !info.isDirectory()) fail('invalid-options', 'workspaceRoot must be a directory');
    rootReal = real;
    return rootReal;
  }

  async function execute(input) {
    const request = readInput(input);
    const workspaceRoot = await root();
    const file = await readTarget(workspaceRoot, request.targetFile);
    const prompt = renderPrompt(request.instructions, file.source, request.codeEdit);
    if (prompt.length > MAX_MESSAGE_CHARS) {
      fail('prompt-too-large', 'Fast Apply request exceeds the provider message limit');
    }
    let answer;
    try {
      answer = await config.client.chat({
        model: FAST_APPLY_MODEL,
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : undefined;
      fail('provider-error', 'Fast Apply request failed', { status });
    }
    if (answer === null || typeof answer !== 'object' || typeof answer.text !== 'string') {
      fail('invalid-response', 'Fast Apply returned an invalid answer');
    }
    const merged = validResult(answer.text);
    const changed = merged !== file.source;
    if (changed) await writeMerged(workspaceRoot, file.real, file.identity, file.source, merged);
    return Object.freeze({
      targetFile: request.targetFile.join('/'),
      changed,
      bytesWritten: changed ? Buffer.byteLength(merged, 'utf8') : 0,
      usage: usageOf(answer),
    });
  }

  return Object.freeze({
    version: MORPH_FAST_APPLY_VERSION,
    definition: EDIT_FILE_TOOL,
    execute,
    describe: () => describeMorphFastApply(),
  });
}

export function describeMorphFastApply() {
  return Object.freeze({
    version: MORPH_FAST_APPLY_VERSION,
    name: 'edit_file',
    model: FAST_APPLY_MODEL,
    maxSourceBytes: MAX_SOURCE_BYTES,
    maxEditChars: MAX_EDIT_CHARS,
    maxInstructionChars: MAX_INSTRUCTION_CHARS,
    maxResultBytes: MAX_RESULT_BYTES,
  });
}
