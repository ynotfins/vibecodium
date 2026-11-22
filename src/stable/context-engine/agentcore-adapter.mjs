import { isDeepStrictEqual } from 'node:util';

export const MAX_SESSION_ID_CHARS = 200;
export const MAX_MIRROR_BATCH = 1000;
export const MAX_REMOTE_RECORDS = 100_000;
export const MAX_REMOTE_RECORD_BYTES = 1_000_000;
export const MAX_REMOTE_SESSION_BYTES = 50_000_000;
export const MAX_PAYLOAD_NODES = 250_000;
export const MAX_REMOTE_DEPTH = 32;
export const AGENTCORE_SOURCE_TRUST = 'untrusted-session-content';

const RECORD_KINDS = new Set([
  'user',
  'assistant',
  'system',
  'tool_call',
  'tool_result',
]);

const RECORD_KEYS = ['kind', 'payload', 'sequence'];
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export class AgentCoreAdapterError extends Error {
  constructor(message, { phase, sessionId } = {}) {
    super(message);
    this.name = 'AgentCoreAdapterError';
    this.phase = phase;
    this.sessionId = sessionId;
  }
}

export function isAgentCorePresent(client) {
  return Boolean(
    client
    && typeof client === 'object'
    && typeof client.hydrate === 'function'
    && typeof client.append === 'function'
    && typeof client.close === 'function',
  );
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('sessionId must be a non-empty string');
  }
  if (CONTROL_CHARS.test(sessionId)) {
    throw new Error('sessionId must not contain control characters');
  }
  if (sessionId.trim() !== sessionId) {
    throw new Error('sessionId must not have leading or trailing whitespace');
  }
  if (sessionId.length > MAX_SESSION_ID_CHARS) {
    throw new Error(`sessionId exceeds ${MAX_SESSION_ID_CHARS} characters`);
  }
  return sessionId;
}

function jsonStringBytes(value) {
  let extra = 0;
  for (let position = 0; position < value.length; position += 1) {
    const code = value.charCodeAt(position);
    if (code === 0x22 || code === 0x5c) extra += 1;
    else if (code < 0x20) extra += (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) ? 1 : 5;
  }
  return Buffer.byteLength(value, 'utf8') + 2 + extra;
}

function payloadProblem(value, state = { seen: new WeakSet(), nodes: 0, bytes: 0 }, depth = 1, requirePlainObject = false) {
  const tooBig = () => `payload exceeds ${MAX_REMOTE_RECORD_BYTES} bytes`;
  if (depth > MAX_REMOTE_DEPTH) {
    return `payload nesting depth exceeds ${MAX_REMOTE_DEPTH}`;
  }
  state.bytes += 1;
  state.nodes += 1;
  if (state.nodes > MAX_PAYLOAD_NODES) {
    return `payload node count exceeds ${MAX_PAYLOAD_NODES}`;
  }
  if (state.bytes > MAX_REMOTE_RECORD_BYTES) return tooBig();
  if (typeof value === 'string') {
    if (value.length === 0) return 'payload strings must not be empty';
    if (value.length > MAX_REMOTE_RECORD_BYTES - state.bytes) return tooBig();
    state.bytes += jsonStringBytes(value);
    return state.bytes > MAX_REMOTE_RECORD_BYTES ? tooBig() : null;
  }
  if (typeof value === 'boolean') {
    state.bytes += 5;
    return state.bytes > MAX_REMOTE_RECORD_BYTES ? tooBig() : null;
  }
  if (value === null) return 'payload must not contain null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) return 'payload numbers must be finite';
    state.bytes += String(value).length;
    return state.bytes > MAX_REMOTE_RECORD_BYTES ? tooBig() : null;
  }
  if (typeof value !== 'object') {
    return `payload type ${typeof value} is not JSON-safe`;
  }
  if (state.seen.has(value)) {
    return 'payload must not repeat object references';
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (requirePlainObject) return 'payload must be a non-empty string, boolean, finite number or plain object';
    state.bytes += 2 + Math.max(0, value.length - 1);
    if (state.bytes > MAX_REMOTE_RECORD_BYTES) return tooBig();
    for (const item of value) {
      const problem = payloadProblem(item, state, depth + 1);
      if (problem) return problem;
    }
    return null;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return 'payload must contain only plain objects';
  }
  if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
    return 'payload must not define toJSON';
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return 'payload must not contain symbol keys';
  }
  const keys = Object.keys(value);
  state.bytes += 2 + Math.max(0, keys.length - 1);
  if (state.bytes > MAX_REMOTE_RECORD_BYTES) return tooBig();
  for (const key of keys) {
    if (key.length > MAX_REMOTE_RECORD_BYTES - state.bytes) return tooBig();
    state.bytes += jsonStringBytes(key) + 2;
    if (state.bytes > MAX_REMOTE_RECORD_BYTES) return tooBig();
    const problem = payloadProblem(value[key], state, depth + 1);
    if (problem) return problem;
  }
  return null;
}

function validateRecord(record, index, { sessionId, phase, source }) {
  const prefix = `${source} record ${index}`;
  const fail = (reason) => {
    throw new AgentCoreAdapterError(
      `${prefix} ${reason} for session ${sessionId}`,
      { phase, sessionId },
    );
  };

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('must be a plain object');
  }
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('must be a plain object');
  }
  const keys = Object.keys(record).sort();
  if (
    keys.length !== RECORD_KEYS.length
    || !keys.every((key, position) => key === RECORD_KEYS[position])
  ) {
    fail('must contain exactly kind, payload and sequence');
  }
  if (!RECORD_KINDS.has(record.kind)) {
    fail('has an unsupported record kind');
  }
  if (!Number.isInteger(record.sequence) || record.sequence < 0) {
    fail('has an invalid sequence');
  }
  if (record.sequence !== index) {
    fail(`has sequence ${record.sequence}, but ${source} records must be contiguous from sequence 0`);
  }
  const problem = payloadProblem(record.payload, undefined, 1, true);
  if (problem) {
    fail(`has an unsupported payload: ${problem}`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  if (bytes > MAX_REMOTE_RECORD_BYTES) {
    fail(`exceeds ${MAX_REMOTE_RECORD_BYTES} bytes`);
  }
  return bytes;
}

function validateRecords(records, options) {
  const { sessionId, phase, source } = options;
  if (!Array.isArray(records)) {
    throw new AgentCoreAdapterError(
      `agentcore hydrate response for session ${sessionId} must include a records array`,
      { phase, sessionId },
    );
  }
  if (records.length > MAX_REMOTE_RECORDS) {
    throw new AgentCoreAdapterError(
      `${source} session ${sessionId} exceeds ${MAX_REMOTE_RECORDS} records`,
      { phase, sessionId },
    );
  }
  let totalBytes = 0;
  for (let index = 0; index < records.length; index += 1) {
    totalBytes += validateRecord(records[index], index, options);
    if (totalBytes > MAX_REMOTE_SESSION_BYTES) {
      throw new AgentCoreAdapterError(
        `${source} session ${sessionId} exceeds ${MAX_REMOTE_SESSION_BYTES} bytes`,
        { phase, sessionId },
      );
    }
  }
}

export class AgentCoreAdapter {
  constructor({ store, sessionId, client, mirrored = 0 } = {}) {
    this.sessionId = validateSessionId(sessionId);
    if (!store || typeof store.readAll !== 'function' || typeof store.append !== 'function') {
      throw new Error('store must provide readAll() and append()');
    }
    if (!Number.isInteger(mirrored) || mirrored < 0) {
      throw new Error('mirrored must be a non-negative integer');
    }
    this.enabled = client !== undefined && client !== null;
    if (this.enabled && !isAgentCorePresent(client)) {
      throw new Error('client must provide hydrate(), append() and close()');
    }
    this.store = store;
    this.client = this.enabled ? client : null;
    this.mirrored = mirrored;
    this.closed = false;
    this.queue = Promise.resolve();
  }

  #enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  #assertOpen(phase) {
    if (this.closed) {
      throw new AgentCoreAdapterError(
        `agentcore session ${this.sessionId} is closed`,
        { phase, sessionId: this.sessionId },
      );
    }
  }

  async #call(phase, fn) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AgentCoreAdapterError) throw error;
      throw new AgentCoreAdapterError(
        `agentcore ${phase} failed for session ${this.sessionId}`,
        { phase, sessionId: this.sessionId },
      );
    }
  }

  async #readLocal(phase = 'append') {
    let local;
    try {
      local = await this.store.readAll();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    validateRecords(local, {
      sessionId: this.sessionId,
      phase,
      source: 'local',
    });
    return local;
  }

  async #mirrorPending() {
    this.#assertOpen('append');
    const local = await this.#readLocal();
    if (local.length < this.mirrored) {
      throw new AgentCoreAdapterError(
        `local session ${this.sessionId} has ${local.length} records, shorter than the ${this.mirrored} mirrored records`,
        { phase: 'append', sessionId: this.sessionId },
      );
    }

    const pending = local.slice(this.mirrored);
    let appended = 0;
    for (let offset = 0; offset < pending.length; offset += MAX_MIRROR_BATCH) {
      const batch = pending.slice(offset, offset + MAX_MIRROR_BATCH);
      const response = await this.#call('append', () => this.client.append({
        sessionId: this.sessionId,
        records: batch,
      }));
      const accepted = response?.accepted;
      if (!Number.isInteger(accepted) || accepted !== batch.length) {
        throw new AgentCoreAdapterError(
          `agentcore append acknowledgement for session ${this.sessionId} did not confirm ${batch.length} records`,
          { phase: 'append', sessionId: this.sessionId },
        );
      }
      this.mirrored += batch.length;
      appended += batch.length;
    }
    return appended;
  }

  async hydrate() {
    if (!this.enabled) {
      return {
        enabled: false,
        sessionId: this.sessionId,
        hydrated: 0,
        total: 0,
      };
    }
    return this.#enqueue(async () => {
      if (this.closed) {
        throw new AgentCoreAdapterError(
          `agentcore session ${this.sessionId} is closed`,
          { phase: 'hydrate', sessionId: this.sessionId },
        );
      }
      const local = await this.#readLocal('hydrate');

      const response = await this.#call('hydrate', () => this.client.hydrate({
        sessionId: this.sessionId,
      }));
      const remote = response?.records;
      validateRecords(remote, {
        sessionId: this.sessionId,
        phase: 'hydrate',
        source: 'remote',
      });
      if (remote.length < local.length) {
        throw new AgentCoreAdapterError(
          `agentcore hydrate returned ${remote.length} records but the local session has ${local.length}`,
          { phase: 'hydrate', sessionId: this.sessionId },
        );
      }
      for (let index = 0; index < local.length; index += 1) {
        if (!isDeepStrictEqual(local[index], remote[index])) {
          throw new AgentCoreAdapterError(
            `agentcore hydrate record ${index} conflicts with local record ${index} for session ${this.sessionId}`,
            { phase: 'hydrate', sessionId: this.sessionId },
          );
        }
      }

      const missing = remote.slice(local.length);
      for (const record of missing) {
        await this.store.append(record.kind, record.payload);
      }
      if (remote.length > this.mirrored) this.mirrored = remote.length;
      return {
        enabled: true,
        sessionId: this.sessionId,
        hydrated: missing.length,
        total: remote.length,
        sourceTrust: AGENTCORE_SOURCE_TRUST,
      };
    });
  }

  async append() {
    if (!this.enabled) {
      return {
        enabled: false,
        sessionId: this.sessionId,
        appended: 0,
        mirrored: 0,
      };
    }
    return this.#enqueue(async () => {
      const appended = await this.#mirrorPending();
      return {
        enabled: true,
        sessionId: this.sessionId,
        appended,
        mirrored: this.mirrored,
      };
    });
  }

  async close() {
    if (!this.enabled) {
      return {
        enabled: false,
        sessionId: this.sessionId,
        closed: false,
        mirrored: 0,
      };
    }
    return this.#enqueue(async () => {
      if (this.closed) {
        return {
          enabled: true,
          sessionId: this.sessionId,
          closed: true,
          mirrored: this.mirrored,
          appended: 0,
        };
      }
      const appended = await this.#mirrorPending();
      await this.#call('close', () => this.client.close({
        sessionId: this.sessionId,
      }));
      this.closed = true;
      return {
        enabled: true,
        sessionId: this.sessionId,
        closed: true,
        mirrored: this.mirrored,
        appended,
      };
    });
  }
}
