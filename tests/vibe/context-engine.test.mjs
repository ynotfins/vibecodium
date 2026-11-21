import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MAX_NESTING_DEPTH, MAX_RECORD_SIZE, SessionStore } from '../../src/stable/context-engine/session-store.mjs';

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
