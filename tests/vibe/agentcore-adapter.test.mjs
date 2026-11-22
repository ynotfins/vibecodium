import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentCoreAdapter,
  AgentCoreAdapterError,
  MAX_MIRROR_BATCH,
  MAX_REMOTE_RECORDS,
  MAX_REMOTE_RECORD_BYTES,
  isAgentCorePresent,
} from '../../src/stable/context-engine/agentcore-adapter.mjs';
import { SessionStore } from '../../src/stable/context-engine/session-store.mjs';

async function createStore(t, fileName = 'session.jsonl') {
  const root = await mkdtemp(join(tmpdir(), 'vibe-agentcore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new SessionStore(root, fileName);
}

function remoteRecord(sequence, payload = `record ${sequence}`, kind = 'user') {
  return { kind, payload, sequence };
}

async function readAllOrEmpty(store) {
  try {
    return await store.readAll();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

class FakeAgentCoreMemory {
  constructor() {
    this.sessions = new Map();
    this.calls = [];
    this.failures = new Map();
  }

  session(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { records: [], closed: false });
    }
    return this.sessions.get(sessionId);
  }

  failOnce(phase, error = new Error(`remote ${phase} failed`)) {
    this.failures.set(phase, error);
  }

  #maybeFail(phase) {
    const error = this.failures.get(phase);
    if (error) {
      this.failures.delete(phase);
      throw error;
    }
  }

  async hydrate({ sessionId }) {
    this.calls.push(['hydrate', sessionId]);
    this.#maybeFail('hydrate');
    return { records: structuredClone(this.session(sessionId).records) };
  }

  async append({ sessionId, records }) {
    this.calls.push(['append', sessionId, records.length]);
    this.#maybeFail('append');
    const session = this.session(sessionId);
    records.forEach((record, index) => {
      const expected = session.records.length + index;
      if (record.sequence !== expected) {
        throw new Error(`unexpected remote sequence ${record.sequence}, expected ${expected}`);
      }
    });
    session.records.push(...structuredClone(records));
    return { accepted: records.length };
  }

  async close({ sessionId }) {
    this.calls.push(['close', sessionId]);
    this.#maybeFail('close');
    const session = this.session(sessionId);
    session.closed = true;
    return { closed: true };
  }
}

test('AgentCore round trip hydrates, appends and closes every record verbatim', async (t) => {
  const local = await createStore(t);
  const remote = new FakeAgentCoreMemory();
  const adapter = new AgentCoreAdapter({ store: local, sessionId: 'session-alpha', client: remote });

  await local.append('user', 'Réponse with unicode ✅\r\nsecond line');
  await local.append('assistant', { text: 'ok', nested: { flags: [true, false, 3] } });
  await local.append('tool_call', { name: 'read_file', args: { path: 'src/app.ts' } });
  await local.append('tool_result', { name: 'read_file', output: 'export const x = 1;\n' });

  assert.equal(adapter.enabled, true);
  assert.deepEqual(await adapter.append(), {
    enabled: true,
    sessionId: 'session-alpha',
    appended: 4,
    mirrored: 4,
  });
  assert.equal(remote.session('session-alpha').records.length, 4);
  assert.deepEqual(await adapter.append(), {
    enabled: true,
    sessionId: 'session-alpha',
    appended: 0,
    mirrored: 4,
  });

  assert.deepEqual(await adapter.close(), {
    enabled: true,
    sessionId: 'session-alpha',
    closed: true,
    mirrored: 4,
    appended: 0,
  });
  assert.equal(remote.session('session-alpha').closed, true);
  assert.deepEqual(remote.calls.map((call) => call[0]), ['append', 'close']);

  const fresh = await createStore(t, 'hydrated.jsonl');
  const restorer = new AgentCoreAdapter({ store: fresh, sessionId: 'session-alpha', client: remote });
  assert.deepEqual(await restorer.hydrate(), {
    enabled: true,
    sessionId: 'session-alpha',
    hydrated: 4,
    total: 4,
    sourceTrust: 'untrusted-session-content',
  });
  assert.deepEqual(await fresh.readAll(), await local.readAll());
  assert.equal(await fresh.readRaw(), await local.readRaw());

  await fresh.append('user', 'after hydrate');
  assert.deepEqual(await restorer.append(), {
    enabled: true,
    sessionId: 'session-alpha',
    appended: 1,
    mirrored: 5,
  });
  assert.equal(remote.session('session-alpha').records.length, 5);
});

test('the adapter is optional and stays local-only without a client', async (t) => {
  const local = await createStore(t);
  const adapter = new AgentCoreAdapter({ store: local, sessionId: 'session-local' });

  assert.equal(adapter.enabled, false);
  await local.append('user', 'stay local');

  assert.deepEqual(await adapter.hydrate(), {
    enabled: false,
    sessionId: 'session-local',
    hydrated: 0,
    total: 0,
  });
  assert.deepEqual(await adapter.append(), {
    enabled: false,
    sessionId: 'session-local',
    appended: 0,
    mirrored: 0,
  });
  assert.deepEqual(await adapter.close(), {
    enabled: false,
    sessionId: 'session-local',
    closed: false,
    mirrored: 0,
  });
  assert.deepEqual((await local.readAll()).map((record) => record.payload), ['stay local']);

  assert.equal(isAgentCorePresent(null), false);
  assert.equal(isAgentCorePresent({ hydrate() {}, append() {} }), false);
  assert.equal(isAgentCorePresent({ hydrate() {}, append() {}, close() {} }), true);
  assert.throws(
    () => new AgentCoreAdapter({ store: local, sessionId: 's', client: { hydrate() {} } }),
    /client must provide hydrate\(\), append\(\) and close\(\)/,
  );
});

test('append mirrors only unmirrored records in bounded batches', async () => {
  const records = Array.from({ length: MAX_MIRROR_BATCH + 250 }, (_, sequence) => (
    remoteRecord(sequence, `turn ${sequence}`)
  ));
  const store = {
    async readAll() { return records; },
    async append() { throw new Error('append must not be called when hydrating remote state'); },
  };
  const batchSizes = [];
  const client = {
    async hydrate() { return { records: [] }; },
    async append({ records: batch }) {
      batchSizes.push(batch.length);
      return { accepted: batch.length };
    },
    async close() { return { closed: true }; },
  };
  const adapter = new AgentCoreAdapter({ store, sessionId: 'batch-session', client });

  const result = await adapter.append();
  assert.equal(result.appended, records.length);
  assert.equal(result.mirrored, records.length);
  assert.deepEqual(batchSizes, [MAX_MIRROR_BATCH, 250]);
});

test('a resume cursor skips records already mirrored', async () => {
  const records = [remoteRecord(0), remoteRecord(1), remoteRecord(2)];
  const sent = [];
  const client = {
    async hydrate() { return { records: [] }; },
    async append({ records: batch }) {
      sent.push(batch.map((record) => record.sequence));
      return { accepted: batch.length };
    },
    async close() { return { closed: true }; },
  };
  const store = {
    async readAll() { return records; },
    async append() {},
  };
  const adapter = new AgentCoreAdapter({ store, sessionId: 'resume-session', client, mirrored: 2 });

  const result = await adapter.append();
  assert.equal(result.appended, 1);
  assert.equal(result.mirrored, 3);
  assert.deepEqual(sent, [[2]]);

  assert.throws(
    () => new AgentCoreAdapter({ store, sessionId: 'resume-session', client, mirrored: -1 }),
    /mirrored must be a non-negative integer/,
  );
  assert.throws(
    () => new AgentCoreAdapter({ store, sessionId: 'resume-session', client, mirrored: 1.5 }),
    /mirrored must be a non-negative integer/,
  );
});

test('cumulative remote session size is capped', async () => {
  const records = Array.from({ length: 51 }, (_, sequence) => (
    remoteRecord(sequence, 'x'.repeat(999_000))
  ));
  const store = {
    async readAll() { return []; },
    async append() {},
  };
  const client = {
    async hydrate() { return { records }; },
    async append() { throw new Error('must not be called'); },
    async close() {},
  };
  const adapter = new AgentCoreAdapter({ store, sessionId: 'huge-session', client });
  await assert.rejects(adapter.hydrate(), /exceeds 50000000 bytes/);
});

test('concurrent append calls mirror each record exactly once', async (t) => {
  const local = await createStore(t);
  await local.append('user', 'one');
  await local.append('user', 'two');

  const remote = new FakeAgentCoreMemory();
  const append = remote.append.bind(remote);
  remote.append = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return append(input);
  };
  const adapter = new AgentCoreAdapter({ store: local, sessionId: 'concurrent', client: remote });

  const [first, second] = await Promise.all([adapter.append(), adapter.append()]);
  assert.equal(first.appended + second.appended, 2);
  assert.equal(remote.session('concurrent').records.length, 2);
});

test('hydrate rejects divergent, malformed and unsafe remote sessions', async (t) => {
  const local = await createStore(t);
  const remote = new FakeAgentCoreMemory();
  const adapter = new AgentCoreAdapter({ store: local, sessionId: 'session-conflict', client: remote });

  const rejectWith = async (records, pattern, expectedLocalCount = 0) => {
    remote.session('session-conflict').records = records;
    await assert.rejects(adapter.hydrate(), pattern);
    assert.equal((await readAllOrEmpty(local)).length, expectedLocalCount);
  };

  await rejectWith([remoteRecord(0), remoteRecord(2)], /contiguous from sequence 0/);
  await rejectWith([remoteRecord(0), remoteRecord(0)], /contiguous from sequence 0/);
  await rejectWith([{ ...remoteRecord(0), kind: 'other' }], /unsupported record kind|must contain exactly/);
  await rejectWith([{ kind: 'user', payload: { when: new Date('2026-11-22') }, sequence: 0 }], /unsupported payload/);
  await rejectWith([{ kind: 'user', payload: new Map([['a', 1]]), sequence: 0 }], /unsupported payload/);
  await rejectWith([{ kind: 'user', payload: undefined, sequence: 0 }], /unsupported payload/);
  await rejectWith([{ kind: 'user', payload: null, sequence: 0 }], /unsupported payload/);
  await rejectWith([{
    kind: 'user',
    payload: Array.from({ length: 1_000_001 }, () => ({})),
    sequence: 0,
  }], /node count exceeds/);
  await rejectWith([{ ...remoteRecord(0), extra: true }], /must contain exactly/);

  await local.append('user', 'local only');
  await rejectWith([], /returned 0 records but the local session has 1/, 1);

  const conflict = await createStore(t, 'conflict.jsonl');
  await conflict.append('user', 'original');
  const conflictAdapter = new AgentCoreAdapter({
    store: conflict,
    sessionId: 'session-conflict',
    client: remote,
  });
  remote.session('session-conflict').records = [remoteRecord(0, 'different')];
  await assert.rejects(conflictAdapter.hydrate(), /conflicts with local record 0/);
  assert.deepEqual((await conflict.readAll()).map((record) => record.payload), ['original']);
});

test('client failures are isolated and reported without payload contents', async (t) => {
  const local = await createStore(t);
  await local.append('user', 'secret token value must not leak');
  const remote = new FakeAgentCoreMemory();
  remote.failOnce('append', new Error('secret token value must not leak'));
  const adapter = new AgentCoreAdapter({ store: local, sessionId: 'session-failure', client: remote });

  await assert.rejects(adapter.append(), (error) => {
    assert.ok(error instanceof AgentCoreAdapterError);
    assert.equal(error.name, 'AgentCoreAdapterError');
    assert.equal(error.phase, 'append');
    assert.equal(error.sessionId, 'session-failure');
    assert.match(error.message, /agentcore append failed for session session-failure/);
    assert.doesNotMatch(error.message, /secret token value/);
    assert.match(error.cause.message, /secret token value/);
    return true;
  });
  assert.equal((await local.readAll()).length, 1);

  assert.deepEqual(await adapter.append(), {
    enabled: true,
    sessionId: 'session-failure',
    appended: 1,
    mirrored: 1,
  });

  remote.failOnce('close');
  await assert.rejects(adapter.close(), /agentcore close failed for session session-failure/);
  assert.deepEqual(await adapter.close(), {
    enabled: true,
    sessionId: 'session-failure',
    closed: true,
    mirrored: 1,
    appended: 0,
  });
  await assert.rejects(adapter.append(), /is closed/);
});

test('input and remote caps fail closed before touching the remote or local store', async (t) => {
  const local = await createStore(t);
  const remote = new FakeAgentCoreMemory();

  assert.throws(() => new AgentCoreAdapter({ store: local, sessionId: '' }), /sessionId must be a non-empty string/);
  assert.throws(() => new AgentCoreAdapter({ store: local, sessionId: ' leading' }), /leading or trailing whitespace/);
  assert.throws(() => new AgentCoreAdapter({ store: local, sessionId: 'bad\nid' }), /control characters/);
  assert.throws(
    () => new AgentCoreAdapter({ store: local, sessionId: 'x'.repeat(201) }),
    /exceeds 200 characters/,
  );
  assert.throws(() => new AgentCoreAdapter({ store: {}, sessionId: 's' }), /store must provide/);

  const tooMany = new AgentCoreAdapter({
    store: local,
    sessionId: 'too-many',
    client: { async hydrate() { return { records: new Array(MAX_REMOTE_RECORDS + 1) }; }, async append() {}, async close() {} },
  });
  await assert.rejects(tooMany.hydrate(), /exceeds 100000 records/);

  const oversized = new AgentCoreAdapter({
    store: {
      async readAll() { return [remoteRecord(0, 'x'.repeat(MAX_REMOTE_RECORD_BYTES))]; },
      async append() {},
    },
    sessionId: 'oversized',
    client: { async hydrate() { return { records: [] }; }, async append() { throw new Error('must not be called'); }, async close() {} },
  });
  await assert.rejects(oversized.append(), /exceeds 1000000 bytes/);

  let snapshots = [[remoteRecord(0), remoteRecord(1)], [remoteRecord(0)]];
  const shrinking = new AgentCoreAdapter({
    store: {
      async readAll() { return snapshots.shift(); },
      async append() {},
    },
    sessionId: 'shrinking',
    client: { async hydrate() { return { records: [] }; }, async append() { return { accepted: 2 }; }, async close() {} },
  });
  assert.equal((await shrinking.append()).appended, 2);
  await assert.rejects(shrinking.append(), /shorter than the 2 mirrored records/);

  const invalidResponse = new AgentCoreAdapter({
    store: local,
    sessionId: 'bad-response',
    client: { async hydrate() { return { records: 'not-an-array' }; }, async append() {}, async close() {} },
  });
  await assert.rejects(invalidResponse.hydrate(), /must include a records array/);

  const badAck = new AgentCoreAdapter({
    store: { async readAll() { return [remoteRecord(0)]; }, async append() {} },
    sessionId: 'bad-ack',
    client: { async hydrate() { return { records: [] }; }, async append() { return { accepted: 0 }; }, async close() {} },
  });
  await assert.rejects(badAck.append(), /acknowledgement/);
});
