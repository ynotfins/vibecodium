import { appendFile, chmod, readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export const MAX_FILE_SIZE = 50_000_000;
export const MAX_NESTING_DEPTH = 32;
export const MAX_RECORD_SIZE = 1_000_000;
export const MAX_RECORDS = 100_000;

const RECORD_KINDS = new Set([
  'user',
  'assistant',
  'system',
  'tool_call',
  'tool_result',
]);

function capturePayload(
  payload,
  seen = new WeakSet(),
  requirePlainObject = true,
  depth = 1,
) {
  const valid = 'a JSON-safe value (non-empty string, boolean, finite number, null, plain object, or array)';
  if (depth > MAX_NESTING_DEPTH) {
    return { error: `payload nesting depth exceeds ${MAX_NESTING_DEPTH}` };
  }
  if (typeof payload === 'string' && payload.length === 0) {
    return { error: `payload must be ${valid}` };
  }
  if (typeof payload === 'string') return { value: payload };
  if (typeof payload === 'boolean') return { value: payload };
  if (typeof payload === 'number') {
    return Number.isFinite(payload) && !Object.is(payload, -0)
      ? { value: payload }
      : { error: `payload must be ${valid}` };
  }
  if (payload === null || typeof payload !== 'object') {
    return { error: `payload must be ${valid}` };
  }
  if (Array.isArray(payload)) {
    if (requirePlainObject) return { error: `payload must be ${valid}` };
    if (seen.has(payload)) return { error: `payload must be ${valid}` };
    seen.add(payload);
    const captured = [];
    for (const item of payload) {
      const itemResult = capturePayload(item, seen, false, depth + 1);
      if (itemResult.error) return itemResult;
      captured.push(itemResult.value);
    }
    return { value: captured };
  }
  if (seen.has(payload)) return { error: `payload must be ${valid}` };
  seen.add(payload);
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) {
    return { error: `payload must be ${valid}` };
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'toJSON')) {
    return { error: `payload must be ${valid}` };
  }
  if (Object.getOwnPropertySymbols(payload).length > 0) {
    return { error: `payload must be ${valid}` };
  }
  const value = {};
  for (const key of Object.keys(payload)) {
    const item = payload[key];
    const itemResult = capturePayload(item, seen, false, depth + 1);
    if (itemResult.error) return itemResult;
    Object.defineProperty(value, key, {
      value: itemResult.value, enumerable: true, configurable: true, writable: true,
    });
  }
  return { value };
}

function validateRecord(record) {
  if (!RECORD_KINDS.has(record.kind)) {
    throw new Error(`invalid record kind: ${record.kind}`);
  }
  if (!Number.isInteger(record.sequence) || record.sequence < 0) {
    throw new Error('invalid record sequence');
  }
  const payloadError = capturePayload(record.payload).error;
  if (payloadError) throw new Error(payloadError);
  return record;
}

export class SessionStore {
  constructor(root, fileName = 'session.jsonl') {
    if (!root || typeof root !== 'string') {
      throw new Error('root must be a non-empty path string');
    }
    if (!fileName || typeof fileName !== 'string') {
      throw new Error('fileName must be a non-empty path string');
    }

    this.root = resolve(root);
    this.path = resolve(this.root, fileName);
    const relativePath = relative(this.root, this.path);
    const pathDepth = relativePath === '' ? 0 : relativePath.split(/[\\/]/).length;
    if (
      relativePath === '' ||
      relativePath.startsWith('..') ||
      relativePath.split(/[\\/]/).includes('..') ||
      pathDepth > MAX_NESTING_DEPTH
    ) {
      throw new Error('fileName must stay within the session root');
    }
    this.appendQueue = Promise.resolve();
  }

  append(kind, payload) {
    const task = this.appendQueue.then(async () => {
      if (!RECORD_KINDS.has(kind)) {
        throw new Error(`unsupported record kind: ${kind}`);
      }

      const payloadResult = capturePayload(payload);
      if (payloadResult.error) throw new Error(payloadResult.error);

      const recordCount = await this.count();
      if (recordCount >= MAX_RECORDS) {
        throw new Error(`session exceeds ${MAX_RECORDS} records`);
      }

      const record = {
        kind,
        payload: payloadResult.value,
        sequence: recordCount,
      };
      const line = `${JSON.stringify(record)}\n`;
      const lineSize = Buffer.byteLength(line, 'utf8');
      if (lineSize > MAX_RECORD_SIZE) {
        throw new Error(`record exceeds ${MAX_RECORD_SIZE} bytes`);
      }
      if (await this.fileSize() + lineSize > MAX_FILE_SIZE) {
        throw new Error(`session exceeds ${MAX_FILE_SIZE} bytes`);
      }

      await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 });
      await chmod(this.path, 0o600);
      return record;
    });
    this.appendQueue = task.catch(() => {});
    return task;
  }

  async fileSize() {
    return (await stat(this.path).catch(() => ({ size: 0 }))).size;
  }

  async count() {
    if (await this.fileSize() > MAX_FILE_SIZE) {
      throw new Error(`session exceeds ${MAX_FILE_SIZE} bytes`);
    }
    const raw = await this.readRaw().catch(() => '');
    return raw.trim().length === 0 ? 0 : raw.trim().split('\n').length;
  }

  async readAll() {
    if (await this.fileSize() > MAX_FILE_SIZE) {
      throw new Error(`session exceeds ${MAX_FILE_SIZE} bytes`);
    }
    const raw = await this.readRaw();
    const lines = raw.trim().length === 0 ? [] : raw.trim().split('\n');
    return lines.map((line) => validateRecord(JSON.parse(line)));
  }

  readRaw() {
    return readFile(this.path, 'utf8');
  }

  async compact({ tailCount = 10 } = {}) {
    if (!Number.isInteger(tailCount) || tailCount < 0) {
      throw new Error('tailCount must be a non-negative integer');
    }
    const records = await this.readAll();
    const retained = records.slice(-tailCount);
    return { removed: records.length - retained.length, retained };
  }
}
