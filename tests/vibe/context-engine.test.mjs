import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MAX_NESTING_DEPTH, MAX_RECORD_SIZE, SessionStore } from '../../src/stable/context-engine/session-store.mjs';
import {
  DEFAULT_EXPAND_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_EXPAND_LIMIT,
  MAX_LIST_LIMIT,
  MAX_QUERY_CHARS,
  MAX_SUMMARY_CHARS,
  buildSummaryDag,
  buildSummaryDagFromStore,
} from '../../src/stable/context-engine/summary-dag.mjs';

function deeplyNested(depth) {
  let value = null;
  for (let index = 0; index < depth; index += 1) {
    value = { value };
  }
  return value;
}

test('session store keeps every record verbatim through compaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-session-store-'));
  const store = new SessionStore(root);

  await store.append('user', 'Réponse: keep bytes & line breaks\r\nline two');
  await store.append('tool_call', { name: 'read', args: ['hidden "file"'] });
  await store.append('tool_result', { name: 'read', output: 'ok\nsecond' });

  const original = await store.readAll();
  const originalBytes = await store.readRaw();
  const compaction = await store.compact({ tailCount: 1 });

  assert.equal(compaction.removed, 2);
  assert.deepEqual(compaction.retained, [original.at(-1)]);
  assert.equal(await store.readRaw(), originalBytes);
  assert.deepEqual(await store.readAll(), original);
  assert.deepEqual(
    (await store.readAll()).map((record) => record.payload),
    [
      'Réponse: keep bytes & line breaks\r\nline two',
      { name: 'read', args: ['hidden "file"'] },
      { name: 'read', output: 'ok\nsecond' },
    ],
  );

  await rm(root, { recursive: true, force: true });
});

test('session store rejects non-verbatim records and invalid compaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-session-store-invalid-'));
  const store = new SessionStore(root);

  await assert.rejects(store.append('other', 'ok'), /unsupported record kind/);
  await assert.rejects(store.append('user', ''), /payload must be/);
  await assert.rejects(store.append('user', null), /payload must be/);
  await assert.rejects(store.append('user', ['verbatim']), /payload must be/);
  await assert.rejects(store.append('user', new Map([['key', 'value']])), /payload must be/);
  await assert.rejects(store.append('user', new Date('2026-11-21')), /payload must be/);
  await assert.rejects(store.append('tool_call', { nested: new Map([['key', 'value']]) }), /payload must be/);
  await assert.rejects(store.append('tool_call', { nested: new Date('2026-11-21') }), /payload must be/);
  await assert.rejects(store.append('tool_call', { nested: undefined }), /payload must be/);
  await assert.rejects(store.append('tool_call', { nested: Number.NaN }), /payload must be/);
  await assert.rejects(store.append('tool_call', { nested: () => 'changed' }), /payload must be/);
  await assert.rejects(store.append('tool_call', { nested: [Symbol('changed')] }), /payload must be/);
  await assert.rejects(store.append('tool_call', { toJSON: () => ({ changed: true }) }), /payload must be/);
  await assert.rejects(store.append('tool_call', { nested: { toJSON: () => ({}) } }), /payload must be/);
  const changing = { mutating: false };
  Object.defineProperty(changing, 'value', {
    get() {
      if (changing.mutating) {
        return { toJSON: () => ({ changed: true }) };
      }
      changing.mutating = true;
      return 'safe';
    },
    enumerable: true,
  });
  const changingStore = new SessionStore(root);
  await changingStore.append('tool_call', changing);
  const changingRecord = (await changingStore.readAll()).at(-1);
  assert.equal(changingRecord.payload.value, 'safe');
  assert.equal(changingRecord.payload.toJSON, undefined);
  await assert.rejects(store.compact({ tailCount: -1 }), /tailCount must be/);
  await assert.rejects(store.compact({ tailCount: 1.5 }), /tailCount must be/);

  await rm(root, { recursive: true, force: true });
});

test('session store enforces containment, resource limits, and safe reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-session-store-limits-'));

  assert.throws(() => new SessionStore(root, '../outside.jsonl'), /must stay within/);
  assert.throws(
    () => new SessionStore(root, `${'nested/'.repeat(64)}session.jsonl`),
    /must stay within/,
  );

  const store = new SessionStore(root);
  await assert.rejects(
    store.append('user', 'x'.repeat(MAX_RECORD_SIZE)),
    /record exceeds/,
  );
  await assert.rejects(
    store.append('tool_call', { value: deeplyNested(MAX_NESTING_DEPTH) }),
    /nesting depth/,
  );
  await store.append('user', 'safe');
  await assert.rejects(store.compact({ tailCount: 1.5 }), /tailCount must be/);

  const raw = await store.readRaw();
  const corruptPath = join(root, 'corrupt.jsonl');
  const corruptStore = new SessionStore(root, 'corrupt.jsonl');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    corruptPath,
    '{"kind":"user","payload":[1],"sequence":0}\n',
    'utf8',
  );
  await assert.rejects(corruptStore.readAll(), /payload must be/);
  assert.equal(raw.includes('safe'), true);

  await rm(root, { recursive: true, force: true });
});

test('session store serializes appends within one instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-session-store-concurrency-'));
  const store = new SessionStore(root);

  await Promise.all([
    store.append('user', 'one'),
    store.append('tool_call', { name: 'two' }),
    store.append('tool_result', { output: 'three' }),
    store.append('user', 'four'),
  ]);

  const records = await store.readAll();
  assert.deepEqual(records.map((record) => record.sequence), [0, 1, 2, 3]);

  await rm(root, { recursive: true, force: true });
});

function summaryLabel(context) {
  return `${context.kind}:${context.startSequence}-${context.endSequence}`;
}

async function createSession(count) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-summary-dag-'));
  const store = new SessionStore(root);
  for (let index = 0; index < count; index += 1) {
    if (index === 5) {
      await store.append('user', 'The launch code is ORANGE-200.');
    } else if (index % 3 === 0) {
      await store.append('user', `turn ${index}`);
    } else if (index % 3 === 1) {
      await store.append('tool_call', { name: 'read', args: [`file-${index}`] });
    } else {
      await store.append('tool_result', { output: `result ${index}` });
    }
  }
  return { root, store };
}

test('summary DAG builds leaf and condensed nodes over old turns and protects the fresh tail', async () => {
  const { root, store } = await createSession(26);
  try {
    const rawBefore = await store.readRaw();
    const calls = [];
    const dag = await buildSummaryDagFromStore(store, {
      leafSize: 4,
      fanout: 3,
      tailCount: 6,
      summarize: async (context) => {
        calls.push(context);
        return summaryLabel(context);
      },
    });

    assert.equal(dag.summarizedRecordCount, 20);
    assert.deepEqual(dag.tail.map((record) => record.sequence), [20, 21, 22, 23, 24, 25]);
    assert.deepEqual(dag.stats, {
      leaves: 5,
      condensed: 3,
      nodes: 8,
      summarizedRecords: 20,
      tailCount: 6,
    });
    assert.equal(calls.length, 8);
    assert.equal(calls.filter((context) => context.kind === 'leaf').length, 5);
    assert.equal(calls.filter((context) => context.kind === 'condensed').length, 3);
    assert.equal(calls[0].records.length, 4);
    assert.equal(calls.at(-1).children.length, 2);

    const leaves = dag.list({ level: 0, kind: 'leaf' });
    assert.deepEqual(leaves.map((node) => node.id), [
      'summary:l0:0-3',
      'summary:l0:4-7',
      'summary:l0:8-11',
      'summary:l0:12-15',
      'summary:l0:16-19',
    ]);
    assert.equal(dag.list().length, 8);
    assert.equal(dag.list().every((node) => !Object.hasOwn(node, 'records')), true);
    assert.equal(
      dag.list().every((node) => node.sourceTrust === 'untrusted-session-content'),
      true,
    );
    assert.equal(dag.list({ offset: 3, limit: 2 }).length, 2);

    const rootInfo = dag.describe();
    assert.equal(rootInfo.kind, 'condensed');
    assert.equal(rootInfo.level, 2);
    assert.equal(rootInfo.startSequence, 0);
    assert.equal(rootInfo.endSequence, 19);
    assert.equal(rootInfo.recordCount, 20);
    assert.equal(rootInfo.summary, 'condensed:0-19');
    assert.equal(rootInfo.childIds.length, 2);
    assert.equal(Object.hasOwn(rootInfo, 'records'), false);

    const found = dag.grep('ORANGE-200');
    assert.equal(found.total, 1);
    assert.equal(found.matches[0].sequence, 5);
    assert.match(found.matches[0].snippet, /ORANGE-200/);
    assert.equal(found.matches[0].nodeId, 'summary:l0:4-7');
    assert.equal(found.matches[0].sourceTrust, 'untrusted-session-content');

    const leaf = dag.describe(found.matches[0].nodeId);
    assert.equal(leaf.kind, 'leaf');
    assert.equal(leaf.level, 0);
    assert.deepEqual([leaf.startSequence, leaf.endSequence], [4, 7]);
    assert.equal(leaf.sourceTrust, 'untrusted-session-content');

    const page = dag.expand(found.matches[0].nodeId, { offset: 1, limit: 2 });
    assert.equal(page.total, 4);
    assert.equal(page.records.length, 2);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.records.map((record) => record.sequence), [5, 6]);
    assert.equal(page.sourceTrust, 'untrusted-session-content');

    const expanded = dag.expand(found.matches[0].nodeId);
    assert.equal(expanded.records.length, 4);
    assert.equal(expanded.records.find((record) => record.sequence === 5).payload, 'The launch code is ORANGE-200.');
    const bySequence = dag.expand({ sequence: 5 });
    assert.equal(bySequence.node.id, found.matches[0].nodeId);
    assert.equal(bySequence.records.find((record) => record.sequence === 5).payload, 'The launch code is ORANGE-200.');
    assert.equal(dag.grep('orange-200').total, 1);
    assert.equal(dag.grep('ORANGE.200').total, 0);
    assert.equal(dag.grep('ORANGE.200', { regex: true }).total, 0);
    assert.equal(dag.grep('ORANGE.200', { mode: 'regex' }).total, 0);
    assert.equal(dag.grep('ORANGE[').total, 0);
    assert.equal(await store.readRaw(), rawBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a detail from 200 summarized turns is found by grep and retrieved through expand', async () => {
  const { root, store } = await createSession(210);
  try {
    const rawBefore = await store.readRaw();
    const dag = await buildSummaryDagFromStore(store, {
      leafSize: 10,
      fanout: 5,
      tailCount: 10,
      summarize: summaryLabel,
    });

    assert.equal(dag.summarizedRecordCount, 200);
    assert.deepEqual(dag.stats, {
      leaves: 20,
      condensed: 5,
      nodes: 25,
      summarizedRecords: 200,
      tailCount: 10,
    });

    const rootInfo = dag.describe();
    assert.equal(rootInfo.startSequence, 0);
    assert.equal(rootInfo.endSequence, 199);
    assert.equal(rootInfo.childIds.length, 4);
    assert.equal(JSON.stringify(rootInfo).includes('ORANGE-200'), false);

    const found = dag.grep('ORANGE-200');
    assert.equal(found.total, 1);
    assert.equal(found.matches[0].sequence, 5);
    assert.match(found.matches[0].snippet, /ORANGE-200/);

    const expanded = dag.expand(found.matches[0].nodeId);
    assert.equal(expanded.total, 10);
    assert.equal(expanded.records.find((record) => record.sequence === 5).payload, 'The launch code is ORANGE-200.');
    assert.equal(expanded.records.some((record) => record.sequence >= 200), false);
    assert.equal(await store.readRaw(), rawBefore);

    assert.equal(dag.grep('file-205').total, 0);
    const tailMatch = dag.grep('file-205', { includeTail: true });
    assert.equal(tailMatch.total, 1);
    assert.equal(tailMatch.matches[0].sequence, 205);
    assert.equal(tailMatch.matches[0].nodeId, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recall tools apply bounded defaults and literal grep matching', async () => {
  const records = Array.from({ length: 1_005 }, (_, sequence) => ({
    kind: 'user',
    payload: `needle ${sequence}`,
    sequence,
  }));
  const dag = await buildSummaryDag(records, {
    leafSize: 1,
    fanout: records.length,
    tailCount: 0,
    summarize: async () => 'summary',
  });

  assert.equal(dag.list().length, DEFAULT_LIST_LIMIT);
  assert.equal(dag.list({ offset: MAX_LIST_LIMIT, limit: MAX_LIST_LIMIT }).length, 6);

  const found = dag.grep('needle');
  assert.equal(found.total, records.length);
  assert.equal(found.matches.length, DEFAULT_EXPAND_LIMIT);
  assert.equal(
    found.matches.every((match) => match.sourceTrust === 'untrusted-session-content'),
    true,
  );

  const expanded = dag.expand(dag.root.id);
  assert.equal(expanded.total, records.length);
  assert.equal(expanded.records.length, DEFAULT_EXPAND_LIMIT);
  assert.equal(expanded.hasMore, true);
  assert.equal(expanded.sourceTrust, 'untrusted-session-content');
});

test('summary DAG rejects invalid records, summaries, and unbounded recall requests', async () => {
  const { root, store } = await createSession(12);
  try {
    await assert.rejects(buildSummaryDagFromStore(null, {}), /store must provide readAll/);
    const records = await store.readAll();
    assert.deepEqual((await buildSummaryDag([], {})).stats, {
      leaves: 0,
      condensed: 0,
      nodes: 0,
      summarizedRecords: 0,
      tailCount: 0,
    });
    assert.equal((await buildSummaryDag(records, { tailCount: 100 })).root, null);

    await assert.rejects(
      buildSummaryDag(records, { leafSize: 4 }),
      /summarize must be a function/,
    );
    await assert.rejects(
      buildSummaryDag(records, { leafSize: 1, fanout: 1, summarize: async () => 'summary' }),
      /fanout must be at least 2/,
    );
    await assert.rejects(
      buildSummaryDag(records, { leafSize: 0, summarize: async () => 'summary' }),
      /leafSize must be a positive integer/,
    );
    await assert.rejects(
      buildSummaryDag(records, { tailCount: -1, summarize: async () => 'summary' }),
      /tailCount must be a non-negative integer/,
    );
    await assert.rejects(
      buildSummaryDag(records, { tailCount: 1, leafSize: 4, summarize: async () => '' }),
      /summary must be a non-empty string/,
    );
    await assert.rejects(
      buildSummaryDag(records, {
        tailCount: 1,
        leafSize: 4,
        summarize: async () => 'x'.repeat(MAX_SUMMARY_CHARS + 1),
      }),
      /summary exceeds/,
    );
    await assert.rejects(
      buildSummaryDag([records[0], { ...records[2], sequence: 2 }], {
        tailCount: 0,
        summarize: async () => 'summary',
      }),
      /record sequences must be contiguous/,
    );
    await assert.rejects(
      buildSummaryDag([{ ...records[0], kind: 'other' }], {
        tailCount: 0,
        summarize: async () => 'summary',
      }),
      /invalid record kind/,
    );

    const dag = await buildSummaryDagFromStore(store, {
      leafSize: 4,
      fanout: 2,
      tailCount: 2,
      summarize: summaryLabel,
    });
    assert.throws(() => dag.grep(''), /query must be a non-empty string/);
    assert.throws(
      () => dag.grep('x'.repeat(MAX_QUERY_CHARS + 1)),
      /query exceeds/,
    );
    assert.throws(() => dag.grep('turn', { limit: 0 }), /limit must be between 1 and/);
    assert.throws(() => dag.grep('turn', { limit: MAX_EXPAND_LIMIT + 1 }), /limit must be between 1 and/);
    assert.throws(() => dag.grep('turn', { includeTail: 'yes' }), /includeTail must be a boolean/);
    assert.throws(() => dag.list({ offset: -1 }), /offset must be a non-negative integer/);
    assert.throws(() => dag.list({ limit: 0 }), /limit must be between 1 and/);
    assert.throws(() => dag.list({ limit: MAX_LIST_LIMIT + 1 }), /limit must be between 1 and/);
    assert.throws(() => dag.describe('missing'), /summary node not found/);
    assert.throws(() => dag.expand('missing'), /summary node not found/);
    assert.throws(() => dag.expand(dag.root.id, { offset: -1 }), /offset must be a non-negative integer/);
    assert.throws(() => dag.expand(dag.root.id, { limit: MAX_EXPAND_LIMIT + 1 }), /limit must be between 1 and/);
    assert.throws(() => dag.expand({ sequence: 999 }), /no summary node covers sequence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
