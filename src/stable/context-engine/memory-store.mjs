import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

export const MAX_MEMORY_FILE_SIZE = 20_000_000;
export const MAX_MEMORY_RECORD_SIZE = 256_000;
export const MAX_MEMORY_DEPTH = 32;
export const MAX_MEMORY_KEY_CHARS = 200;
export const MAX_MEMORY_VALUE_CHARS = 16_000;
export const MAX_MEMORY_QUERY_CHARS = 200;
export const MAX_MEMORY_ENTRIES = 10_000;
export const MAX_MEMORY_REVIEW_LIMIT = 500;
export const DEFAULT_MEMORY_REVIEW_LIMIT = 100;

const SCOPES = new Set(['user', 'project']);
const ORIGINS = new Set(['user', 'agent']);
const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const SOURCE_TRUST = 'untrusted-memory-content';

function timestamp() {
  return new Date().toISOString();
}

function assertScope(scope) {
  if (!SCOPES.has(scope)) {
    throw new Error('scope must be "user" or "project"');
  }
}

function assertContained(root, path) {
  const relativePath = relative(root, path);
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    relativePath.split(/[\\/]/).includes('..')
  ) {
    throw new Error('memory path must stay within the memory root');
  }
}

function captureValue(value, seen = new WeakSet(), depth = 1) {
  const valid = 'value must be a JSON-safe value (string, boolean, finite number, null, plain object, or array)';
  if (depth > MAX_MEMORY_DEPTH) {
    return { error: `value nesting depth exceeds ${MAX_MEMORY_DEPTH}` };
  }
  if (typeof value === 'string') {
    return value.length > MAX_MEMORY_VALUE_CHARS
      ? { error: `value exceeds ${MAX_MEMORY_VALUE_CHARS} characters` }
      : { value };
  }
  if (typeof value === 'boolean') return { value };
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? { value }
      : { error: valid };
  }
  if (value === null) return { value: null };
  if (typeof value !== 'object') return { error: valid };
  if (seen.has(value)) return { error: valid };
  seen.add(value);

  if (Array.isArray(value)) {
    const captured = [];
    for (const item of value) {
      const result = captureValue(item, seen, depth + 1);
      if (result.error) return result;
      captured.push(result.value);
    }
    return { value: captured };
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { error: valid };
  if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) return { error: valid };
  if (Object.getOwnPropertySymbols(value).length > 0) return { error: valid };

  const captured = {};
  for (const key of Object.keys(value)) {
    const result = captureValue(value[key], seen, depth + 1);
    if (result.error) return result;
    captured[key] = result.value;
  }
  return { value: captured };
}

function validateKey(key) {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new Error('key must be a non-empty string');
  }
  if (key.length > MAX_MEMORY_KEY_CHARS) {
    throw new Error(`key exceeds ${MAX_MEMORY_KEY_CHARS} characters`);
  }
}

function validateSessionId(sessionId) {
  if (sessionId === undefined) return;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0 || sessionId.length > 200) {
    throw new Error('sessionId must be a non-empty string of at most 200 characters');
  }
}

function validateTimestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`invalid memory ${field}`);
  }
}

function validateId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('memory id must be a non-empty string');
  }
}

function validateRevision(revision) {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('revision must be a positive integer');
  }
}

function publicEntry(entry) {
  const result = {
    id: entry.id,
    scope: entry.scope,
    key: entry.key,
    value: entry.value,
    status: entry.status,
    revision: entry.revision,
    origin: entry.origin,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    sourceTrust: SOURCE_TRUST,
  };
  if (entry.sessionId !== undefined) result.sessionId = entry.sessionId;
  return result;
}

function compareEntries(left, right) {
  const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  const byKey = left.key.localeCompare(right.key);
  return byKey !== 0 ? byKey : left.id.localeCompare(right.id);
}

function compareEvents(left, right) {
  const byCreated = left.createdAt.localeCompare(right.createdAt);
  if (byCreated !== 0) return byCreated;
  const byKey = left.key.localeCompare(
    right.key,
  );
  return byKey !== 0 ? byKey : left.id.localeCompare(right.id);
}

function projectStorageKey(projectId) {
  return createHash('sha256').update(projectId, 'utf8').digest('hex');
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('invalid memory event');
  }
  if (event.type === 'put') {
    if (
      typeof event.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.id)
    ) {
      throw new Error('invalid memory event id');
    }
    assertScope(event.scope);
    validateKey(event.key);
    const valueResult = captureValue(event.value);
    if (valueResult.error) throw new Error(`invalid memory event ${valueResult.error}`);
    if (!REVIEW_STATUSES.has(event.status)) throw new Error('invalid memory event status');
    if (!ORIGINS.has(event.origin)) throw new Error('invalid memory event origin');
    if (!Number.isInteger(event.revision) || event.revision < 1) {
      throw new Error('invalid memory event revision');
    }
    validateTimestamp(event.createdAt, 'createdAt');
    validateTimestamp(event.updatedAt, 'updatedAt');
    validateSessionId(event.sessionId);
    return;
  }
  if (event.type === 'review') {
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new Error('invalid memory event id');
    }
    if (event.status !== 'approved' && event.status !== 'rejected') {
      throw new Error('invalid memory review status');
    }
    if (!Number.isInteger(event.revision) || event.revision < 1) {
      throw new Error('invalid memory event revision');
    }
    validateTimestamp(event.reviewedAt, 'reviewedAt');
    return;
  }
  if (event.type === 'delete') {
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new Error('invalid memory event id');
    }
    validateTimestamp(event.deletedAt, 'deletedAt');
    return;
  }
  throw new Error('invalid memory event type');
}

function foldEvents(events) {
  const entries = new Map();
  for (const event of events) {
    validateEvent(event);
    if (event.type === 'put') {
      entries.set(event.id, {
        id: event.id,
        scope: event.scope,
        key: event.key,
        value: event.value,
        status: event.status,
        revision: event.revision,
        origin: event.origin,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
      });
      if (entries.size > MAX_MEMORY_ENTRIES) {
        throw new Error(`memory exceeds ${MAX_MEMORY_ENTRIES} entries`);
      }
      continue;
    }
    if (event.type === 'review') {
      const prior = entries.get(event.id);
      if (prior && prior.revision === event.revision) {
        entries.set(event.id, {
          ...prior,
          status: event.status,
          updatedAt: event.reviewedAt,
        });
      }
      continue;
    }
    entries.delete(event.id);
  }
  return entries;
}

export class MemoryStore {
  constructor({ root, projectId } = {}) {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new Error('root must be a non-empty path string');
    }
    this.root = resolve(root);
    if (projectId !== undefined) {
      if (
        typeof projectId !== 'string' ||
        !PROJECT_ID_PATTERN.test(projectId) ||
        WINDOWS_RESERVED.test(projectId)
      ) {
        throw new Error('projectId must be a safe 1-128 character identifier');
      }
      this.projectId = projectId;
    }

    this.userPath = resolve(this.root, 'user', 'memory.jsonl');
    assertContained(this.root, this.userPath);
    this.projectPath = this.projectId
      ? resolve(this.root, 'projects', projectStorageKey(this.projectId), 'memory.jsonl')
      : null;
    if (this.projectPath) assertContained(this.root, this.projectPath);
    this.queues = {
      user: Promise.resolve(),
      project: Promise.resolve(),
    };
  }

  pathFor(scope) {
    assertScope(scope);
    if (scope === 'user') return this.userPath;
    if (!this.projectPath) {
      throw new Error('projectId is required for project memory');
    }
    return this.projectPath;
  }

  async fileSize(path) {
    return (await stat(path).catch(() => ({ size: 0 }))).size;
  }

  async readEvents(scope) {
    const path = this.pathFor(scope);
    if (await this.fileSize(path) > MAX_MEMORY_FILE_SIZE) {
      throw new Error(`memory file exceeds ${MAX_MEMORY_FILE_SIZE} bytes`);
    }
    const raw = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const lines = raw.trim().length === 0 ? [] : raw.trim().split('\n');
    return lines.map((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error('invalid memory log: malformed JSON');
      }
      validateEvent(event);
      return event;
    });
  }

  enqueue(scope, operation) {
    assertScope(scope);
    const current = this.queues[scope].then(operation);
    this.queues[scope] = current.catch(() => {});
    return current;
  }

  async compact(scope, entries) {
    const path = this.pathFor(scope);
    const events = [...entries.values()]
      .sort(compareEvents)
      .map((entry) => {
        const event = {
          type: 'put',
          id: entry.id,
          scope: entry.scope,
          key: entry.key,
          value: entry.value,
          status: entry.status,
          revision: entry.revision,
          origin: entry.origin,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        };
        if (entry.sessionId !== undefined) event.sessionId = entry.sessionId;
        return event;
      });
    const lines = events.map((event) => `${JSON.stringify(event)}\n`);
    const body = lines.join('');
    if (Buffer.byteLength(body, 'utf8') > MAX_MEMORY_FILE_SIZE) {
      throw new Error(`memory file cannot be compacted within ${MAX_MEMORY_FILE_SIZE} bytes`);
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async appendEvent(scope, event, entries) {
    validateEvent(event);
    const path = this.pathFor(scope);
    const line = `${JSON.stringify(event)}\n`;
    const lineSize = Buffer.byteLength(line, 'utf8');
    if (lineSize > MAX_MEMORY_RECORD_SIZE) {
      throw new Error(`memory event exceeds ${MAX_MEMORY_RECORD_SIZE} bytes`);
    }
    if (await this.fileSize(path) + lineSize > MAX_MEMORY_FILE_SIZE) {
      await this.compact(scope, entries ?? foldEvents(await this.readEvents(scope)));
      if (await this.fileSize(path) + lineSize > MAX_MEMORY_FILE_SIZE) {
        throw new Error(`memory file exceeds ${MAX_MEMORY_FILE_SIZE} bytes`);
      }
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600);
  }

  async remember({ scope, key, value, origin = 'agent', sessionId } = {}) {
    assertScope(scope);
    validateKey(key);
    const valueResult = captureValue(value);
    if (valueResult.error) throw new Error(valueResult.error);
    if (!ORIGINS.has(origin)) throw new Error('origin must be "user" or "agent"');
    validateSessionId(sessionId);

    return this.enqueue(scope, async () => {
      const entries = foldEvents(await this.readEvents(scope));
      const found = [...entries.values()].find((entry) => entry.key === key);
      if (!found && entries.size >= MAX_MEMORY_ENTRIES) {
        throw new Error(`memory exceeds ${MAX_MEMORY_ENTRIES} entries`);
      }
      const now = timestamp();
      const event = {
        type: 'put',
        id: found?.id ?? randomUUID(),
        scope,
        key,
        value: valueResult.value,
        status: 'pending',
        revision: (found?.revision ?? 0) + 1,
        origin,
        createdAt: found?.createdAt ?? now,
        updatedAt: now,
      };
      if (sessionId !== undefined) event.sessionId = sessionId;
      await this.appendEvent(scope, event, entries);
      return publicEntry(event);
    });
  }

  async setStatus(scope, id, status, revision) {
    assertScope(scope);
    validateId(id);
    validateRevision(revision);
    if (status !== 'approved' && status !== 'rejected') {
      throw new Error('review status must be "approved" or "rejected"');
    }
    return this.enqueue(scope, async () => {
      const entries = foldEvents(await this.readEvents(scope));
      const entry = entries.get(id);
      if (!entry) throw new Error(`memory entry not found: ${id}`);
      if (entry.revision !== revision) {
        throw new Error(
          `memory revision changed: expected ${revision}, current ${entry.revision}`,
        );
      }
      if (entry.status === status) return publicEntry(entry);
      const reviewedAt = timestamp();
      await this.appendEvent(scope, {
        type: 'review',
        id,
        status,
        revision,
        reviewedAt,
      }, entries);
      return publicEntry({ ...entry, status, updatedAt: reviewedAt });
    });
  }

  approve(scope, id, revision) {
    return this.setStatus(scope, id, 'approved', revision);
  }

  reject(scope, id, revision) {
    return this.setStatus(scope, id, 'rejected', revision);
  }

  async forget(scope, id, revision) {
    assertScope(scope);
    validateId(id);
    validateRevision(revision);
    return this.enqueue(scope, async () => {
      const entries = foldEvents(await this.readEvents(scope));
      const entry = entries.get(id);
      if (!entry) throw new Error(`memory entry not found: ${id}`);
      if (entry.revision !== revision) {
        throw new Error(
          `memory revision changed: expected ${revision}, current ${entry.revision}`,
        );
      }
      await this.appendEvent(scope, {
        type: 'delete',
        id,
        deletedAt: timestamp(),
      }, entries);
      return { id, deleted: true };
    });
  }

  async get(scope, id) {
    assertScope(scope);
    validateId(id);
    const entries = foldEvents(await this.readEvents(scope));
    const entry = entries.get(id);
    return entry ? publicEntry(entry) : null;
  }

  async review({ scope, status = 'pending', offset = 0, limit = DEFAULT_MEMORY_REVIEW_LIMIT } = {}) {
    assertScope(scope);
    if (status !== 'all' && !REVIEW_STATUSES.has(status)) {
      throw new Error('review status must be "pending", "approved", "rejected" or "all"');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('offset must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMORY_REVIEW_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_MEMORY_REVIEW_LIMIT}`);
    }
    const entries = foldEvents(await this.readEvents(scope));
    const matching = [...entries.values()]
      .filter((entry) => status === 'all' || entry.status === status)
      .sort(compareEntries);
    const items = matching.slice(offset, offset + limit).map(publicEntry);
    return {
      scope,
      status,
      total: matching.length,
      offset,
      limit,
      hasMore: offset + items.length < matching.length,
      items,
    };
  }

  async recall({
    scope,
    key,
    query,
    includePending = false,
    offset = 0,
    limit = DEFAULT_MEMORY_REVIEW_LIMIT,
  } = {}) {
    assertScope(scope);
    if (key !== undefined) validateKey(key);
    if (query !== undefined) {
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('query must be a non-empty string');
      }
      if (query.length > MAX_MEMORY_QUERY_CHARS) {
        throw new Error(`query exceeds ${MAX_MEMORY_QUERY_CHARS} characters`);
      }
    }
    if (typeof includePending !== 'boolean') {
      throw new Error('includePending must be a boolean');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('offset must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMORY_REVIEW_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_MEMORY_REVIEW_LIMIT}`);
    }

    const needle = query?.toLowerCase();
    const entries = foldEvents(await this.readEvents(scope));
    const matching = [...entries.values()]
      .filter((entry) => entry.status === 'approved' || (includePending && entry.status === 'pending'))
      .filter((entry) => key === undefined || entry.key === key)
      .filter((entry) => {
        if (needle === undefined) return true;
        return `${entry.key}\n${JSON.stringify(entry.value)}`.toLowerCase().includes(needle);
      })
      .sort(compareEntries);
    const matches = matching.slice(offset, offset + limit).map(publicEntry);
    return {
      scope,
      total: matching.length,
      offset,
      limit,
      hasMore: offset + matches.length < matching.length,
      matches,
    };
  }
}
