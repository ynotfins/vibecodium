// M2 B6 Compact: verbatim-preserving history pruning for the context engine.
//
// Compact reduces an over-budget chat history to a token budget by dropping whole older messages
// and, for the one boundary message, only its oldest whole lines. Every line that survives is
// copied byte-for-byte from its source record: the module never re-wraps, re-indents, normalizes
// newlines or edits text, and it never summarizes with a model. It performs no I/O, reads no
// environment variable and holds no credential, so it can run over untrusted session content.

import { estimateTokens } from './token-budget.mjs';

export const COMPACT_VERSION = 1;
export const MAX_MESSAGES = 10_000;
export const MAX_MESSAGE_CHARS = 1_000_000;
export const MAX_TOTAL_MESSAGE_CHARS = 8_000_000;
export const MAX_TOTAL_LINES = 1_000_000;
export const MAX_BUDGET_TOKENS = 1_000_000_000;
export const ROLES = Object.freeze(['system', 'user', 'assistant', 'tool']);

const ROLE_SET = new Set(ROLES);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const MESSAGE_KEYS = new Set(['role', 'content', 'name', 'tool_call_id']);
const OPTION_KEYS = new Set(['messages', 'maxTokens', 'pinned', 'tokenizer']);

export class CompactError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CompactError';
    this.code = code;
    if (extra.scope !== undefined) this.scope = extra.scope;
    if (extra.availableTokens !== undefined) this.availableTokens = extra.availableTokens;
    if (extra.requiredTokens !== undefined) this.requiredTokens = extra.requiredTokens;
  }
}

function fail(code, message, extra) {
  throw new CompactError(code, message, extra);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  let isArray;
  try {
    isArray = Array.isArray(value);
  } catch {
    return false;
  }
  if (isArray) return false;
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

function ownStringKeys(object, code, label) {
  let keys;
  try {
    keys = Reflect.ownKeys(object);
  } catch {
    fail(code, label + ' cannot be enumerated');
  }
  const strings = [];
  for (const key of keys) {
    if (typeof key !== 'string') fail(code, label + ' has a symbol field');
    strings.push(key);
  }
  return strings;
}

function arrayLength(value, code, label) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail(code, label + ' must be a plain array');
  }
  if (descriptor === undefined || !('value' in descriptor) ||
      !Number.isInteger(descriptor.value) || descriptor.value < 0) {
    fail(code, label + ' must be a plain array');
  }
  return descriptor.value;
}

function hasLoneSurrogate(text) {
  if (typeof text.isWellFormed === 'function') return !text.isWellFormed();
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Split a string into lines that each keep their own terminator, so joining them reproduces the
// exact input. An empty string is one empty line. A trailing newline ends the last line there.
function failTooManyLines() {
  fail('compact-messages', 'history exceeds ' + MAX_TOTAL_LINES + ' lines');
}

function splitLines(text, maxLines) {
  if (maxLines < 1) failTooManyLines();
  if (text.length === 0) return [''];
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      if (lines.length >= maxLines) failTooManyLines();
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) {
    if (lines.length >= maxLines) failTooManyLines();
    lines.push(text.slice(start));
  }
  return lines;
}

function validateTokenizer(tokenizer) {
  if (tokenizer === undefined) return estimateTokens;
  if (typeof tokenizer !== 'function') fail('compact-options', 'tokenizer must be a function');
  return (text) => {
    let count;
    try {
      count = tokenizer(text);
    } catch {
      fail('compact-tokenizer', 'tokenizer threw');
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_BUDGET_TOKENS) {
      fail('compact-tokenizer', 'tokenizer must return a non-negative safe integer at or below ' + MAX_BUDGET_TOKENS);
    }
    if (text.length === 0) {
      if (count !== 0) fail('compact-tokenizer', 'tokenizer must return 0 for empty text');
      return 0;
    }
    // The D4 budget in token-budget.mjs never trusts a count below the UTF-8 byte floor, so
    // neither does compact: the same text costs the same tokens in both places.
    const floor = estimateTokens(text);
    if (count < floor) fail('compact-tokenizer', 'tokenizer under-counted relative to the D4 byte floor');
    return count;
  };
}

function validateMaxTokens(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BUDGET_TOKENS) {
    fail('compact-budget', 'maxTokens must be a positive integer at or below ' + MAX_BUDGET_TOKENS);
  }
  return value;
}

function validateMessage(raw, index) {
  const label = 'message ' + index;
  if (!isPlainObject(raw)) fail('compact-message', label + ' must be a plain object');
  for (const key of ownStringKeys(raw, 'compact-message', label)) {
    if (key === 'tool_calls') fail('compact-unsupported', label + ' carries tool_calls, which is out of scope');
    if (!MESSAGE_KEYS.has(key)) fail('compact-message', label + ' has an unknown field');
  }
  const role = ownData(raw, 'role', 'compact-message', label);
  if (typeof role !== 'string' || !ROLE_SET.has(role)) {
    fail('compact-message', label + ' has an unknown role');
  }
  const content = ownData(raw, 'content', 'compact-message', label);
  if (typeof content !== 'string' || content.length > MAX_MESSAGE_CHARS) {
    fail('compact-message', label + ' has invalid content');
  }
  if (hasLoneSurrogate(content)) fail('compact-message', label + ' content is not well-formed Unicode');
  const name = ownData(raw, 'name', 'compact-message', label);
  if (name !== undefined && (typeof name !== 'string' || name.length === 0 || name.length > 128 ||
      CONTROL_OR_BIDI.test(name) || hasLoneSurrogate(name))) {
    fail('compact-message', label + ' has an invalid name');
  }
  const toolCallId = ownData(raw, 'tool_call_id', 'compact-message', label);
  if (toolCallId !== undefined &&
      (typeof toolCallId !== 'string' || toolCallId.length === 0 || toolCallId.length > 512 ||
      CONTROL_OR_BIDI.test(toolCallId) || hasLoneSurrogate(toolCallId))) {
    fail('compact-message', label + ' has an invalid tool_call_id');
  }
  return { role, content, name, toolCallId };
}

function validateMessages(raw) {
  let isArray;
  try {
    isArray = Array.isArray(raw);
  } catch {
    fail('compact-messages', 'messages must be an array');
  }
  if (!isArray) fail('compact-messages', 'messages must be an array');
  const length = arrayLength(raw, 'compact-messages', 'messages');
  if (length > MAX_MESSAGES) fail('compact-messages', 'messages exceeds ' + MAX_MESSAGES + ' entries');
  const messages = [];
  let totalChars = 0;
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    } catch {
      fail('compact-messages', 'messages cannot be read');
    }
    if (descriptor === undefined) fail('compact-messages', 'messages must not be sparse');
    if (!('value' in descriptor)) fail('compact-messages', 'messages must use data properties');
    const message = validateMessage(descriptor.value, index);
    totalChars += message.content.length;
    if (totalChars > MAX_TOTAL_MESSAGE_CHARS) {
      fail('compact-messages', 'history exceeds ' + MAX_TOTAL_MESSAGE_CHARS + ' characters');
    }
    messages.push(message);
  }
  let remainingLines = MAX_TOTAL_LINES;
  for (const message of messages) {
    const lines = splitLines(message.content, remainingLines);
    remainingLines -= lines.length;
    message.lines = lines;
  }
  return messages;
}

function validatePinned(value, count) {
  if (value === undefined) return [];
  let isArray;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail('compact-options', 'pinned must be an array');
  }
  if (!isArray) fail('compact-options', 'pinned must be an array');
  const length = arrayLength(value, 'compact-options', 'pinned');
  const seen = new Set();
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail('compact-options', 'pinned must be a dense array of data values');
    }
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('compact-options', 'pinned must be a dense array of data values');
    }
    const entry = descriptor.value;
    if (!Number.isInteger(entry) || entry < 0 || entry >= count) {
      fail('compact-options', 'pinned contains an invalid message index');
    }
    if (seen.has(entry)) fail('compact-options', 'pinned contains a duplicate index');
    seen.add(entry);
  }
  return [...seen].sort((left, right) => left - right);
}

function renderMessage(message, content) {
  const out = { role: message.role, content };
  if (message.name !== undefined) out.name = message.name;
  if (message.toolCallId !== undefined) out.tool_call_id = message.toolCallId;
  return Object.freeze(out);
}

// Longest whole-line suffix of a message whose rendered text fits `remaining`, or null when
// not even the last line fits. Only whole lines are considered, so every surviving line stays
// intact. A monotone tokenizer makes a binary search find the answer in O(log n) calls.
function checkMonotone(lines, countTokens) {
  if (lines.length < 2) return;
  const last = lines.length - 1;
  const whole = countTokens(lines.join(''));
  for (const start of [1, last >>> 1, last - 1, last]) {
    if (start <= 0 || start >= lines.length) continue;
    if (countTokens(lines.slice(start).join('')) > whole) {
      fail('compact-tokenizer', 'tokenizer is not monotone: a shorter suffix costs more tokens');
    }
  }
}

// The returned `tokens` is the exact count that was compared, and the caller charges that same
// value, so usedTokens can never exceed the budget even for a tokenizer that is not deterministic.
function longestFittingSuffix(lines, remaining, countTokens) {
  checkMonotone(lines, countTokens);
  const whole = countTokens(lines.join(''));
  if (whole <= remaining) return { start: 0, tokens: whole };
  let best = null;
  let low = 1;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const tokens = countTokens(lines.slice(middle).join(''));
    if (tokens <= remaining) {
      best = { start: middle, tokens };
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return best;
}

export function compactHistory(options = {}) {
  if (!isPlainObject(options)) fail('compact-options', 'options must be a plain object');
  for (const key of ownStringKeys(options, 'compact-options', 'options')) {
    if (!OPTION_KEYS.has(key)) fail('compact-options', 'options has an unknown field');
  }
  const messages = validateMessages(ownData(options, 'messages', 'compact-options', 'options'));
  const maxTokens = validateMaxTokens(ownData(options, 'maxTokens', 'compact-options', 'options'));
  const countTokens = validateTokenizer(ownData(options, 'tokenizer', 'compact-options', 'options'));
  const explicitPinned = validatePinned(ownData(options, 'pinned', 'compact-options', 'options'), messages.length);

  const pinned = new Set(explicitPinned);
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === 'system') pinned.add(index);
  }

  const tokenCounts = [];
  let pinnedTokens = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const count = countTokens(messages[index].content);
    tokenCounts.push(count);
    if (pinned.has(index)) pinnedTokens += count;
  }
  if (pinnedTokens > maxTokens) {
    fail('compact-overflow', 'pinned messages exceed the token budget', {
      scope: 'pinned',
      availableTokens: maxTokens,
      requiredTokens: pinnedTokens,
    });
  }

  let remaining = maxTokens - pinnedTokens;
  const dropped = new Set();
  const truncated = new Map();
  const charged = new Map();
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (pinned.has(index)) continue;
    if (tokenCounts[index] <= remaining) {
      remaining -= tokenCounts[index];
      continue;
    }
    const fit = longestFittingSuffix(messages[index].lines, remaining, countTokens);
    if (fit !== null) {
      if (fit.start > 0) truncated.set(index, fit);
      charged.set(index, fit.tokens);
      remaining -= fit.tokens;
    } else {
      dropped.add(index);
    }
    boundary = index;
    break;
  }
  if (boundary >= 0) {
    for (let index = 0; index < boundary; index += 1) {
      if (!pinned.has(index)) dropped.add(index);
    }
  }

  const kept = [];
  let keptTokens = 0;
  let keptLines = 0;
  let droppedLines = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (dropped.has(index)) {
      droppedLines += message.lines.length;
      continue;
    }
    let content = message.content;
    const short = truncated.get(index);
    if (short !== undefined) {
      content = message.lines.slice(short.start).join('');
      droppedLines += short.start;
      keptLines += message.lines.length - short.start;
      keptTokens += short.tokens;
    } else {
      keptLines += message.lines.length;
      keptTokens += charged.has(index) ? charged.get(index) : tokenCounts[index];
    }
    kept.push(renderMessage(message, content));
  }

  const droppedIndexes = Object.freeze([...dropped].sort((left, right) => left - right));
  const truncatedIndexes = Object.freeze([...truncated.keys()].sort((left, right) => left - right));
  const stats = Object.freeze({
    version: COMPACT_VERSION,
    budgetTokens: maxTokens,
    usedTokens: keptTokens,
    pinnedMessages: pinned.size,
    keptMessages: kept.length,
    droppedMessages: droppedIndexes.length,
    truncatedMessages: truncatedIndexes.length,
    keptLines,
    droppedLines,
    droppedIndexes,
    truncatedIndexes,
  });
  return Object.freeze({
    version: COMPACT_VERSION,
    messages: Object.freeze(kept),
    stats,
  });
}

export function describeCompact() {
  return Object.freeze({
    version: COMPACT_VERSION,
    roles: ROLES,
    maxMessages: MAX_MESSAGES,
    maxMessageChars: MAX_MESSAGE_CHARS,
    maxTotalMessageChars: MAX_TOTAL_MESSAGE_CHARS,
    maxTotalLines: MAX_TOTAL_LINES,
    maxBudgetTokens: MAX_BUDGET_TOKENS,
  });
}
