import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAX_MEMORY_DEPTH,
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_FILE_SIZE,
  MAX_MEMORY_KEY_CHARS,
  MAX_MEMORY_QUERY_CHARS,
  MAX_MEMORY_REVIEW_LIMIT,
  MAX_MEMORY_VALUE_CHARS,
  MemoryStore,
} from '../../src/stable/context-engine/memory-store.mjs';

async function createRoot(t) {
  const root = await mkdtemp(
    join(tmpdir(), 'vibe-memory-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function deeplyNested(depth) {
  let value = null;
  for (let index = 0; index < depth; index += 1) {
    value = { value };
  }
  return value;
}

test('project and user memory survive a new store instance and stay scoped', async (t) => {
  const root = await createRoot(t);
  const first = new MemoryStore({ root, projectId: 'project-alpha' });

  const userFact = await first.remember({
    scope: 'user',
    key: 'preferred.shell',
    value: 'pwsh',
    origin: 'user',
    sessionId: 'session-1',
  });
  const projectFact = await first.remember({
    scope: 'project',
    key: 'test.command',
    value: { command: 'node --test', args: ['tests/vibe/memory.test.mjs'] },
    origin: 'agent',
    sessionId: 'session-1',
  });

  assert.equal(userFact.status, 'pending');
  assert.equal(userFact.sourceTrust, 'untrusted-memory-content');
  assert.equal((await first.recall({ scope: 'user' })).total, 0);

  const pending = await first.review({ scope: 'project' });
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].id, projectFact.id);
  assert.equal(pending.items[0].sourceTrust, 'untrusted-memory-content');

  await first.approve('user', userFact.id);
  await first.approve('project', projectFact.id);

  const second = new MemoryStore({ root, projectId: 'project-alpha' });
  const userRecall = await second.recall({ scope: 'user', key: 'preferred.shell' });
  assert.equal(userRecall.total, 1);
  assert.equal(userRecall.matches[0].value, 'pwsh');
  assert.equal(userRecall.matches[0].sessionId, 'session-1');
  assert.equal(userRecall.matches[0].sourceTrust, 'untrusted-memory-content');

  const projectRecall = await second.recall({ scope: 'project', key: 'test.command' });
  assert.equal(projectRecall.total, 1);
  assert.deepEqual(projectRecall.matches[0].value, {
    command: 'node --test',
    args: ['tests/vibe/memory.test.mjs'],
  });

  const otherProject = new MemoryStore({ root, projectId: 'project-beta' });
  assert.equal((await otherProject.recall({ scope: 'user' })).total, 1);
  assert.equal((await otherProject.recall({ scope: 'project' })).total, 0);
});

test('memory review gates recall, tracks revisions, rejection and deletion', async (t) => {
  const root = await createRoot(t);
  const store = new MemoryStore({ root, projectId: 'project-alpha' });

  const first = await store.remember({
    scope: 'project',
    key: 'build.command',
    value: 'npm test',
  });
  assert.equal(first.revision, 1);
  assert.equal((await store.recall({ scope: 'project' })).total, 0);

  await store.approve('project', first.id);
  assert.equal((await store.recall({ scope: 'project' })).total, 1);

  const revised = await store.remember({
    scope: 'project',
    key: 'build.command',
    value: 'node --test',
  });
  assert.equal(revised.id, first.id);
  assert.equal(revised.revision, 2);
  assert.equal(revised.status, 'pending');
  assert.equal((await store.recall({ scope: 'project' })).total, 0);

  await store.approve('project', revised.id);
  const recalled = await store.recall({ scope: 'project', key: 'build.command' });
  assert.equal(recalled.total, 1);
  assert.equal(recalled.matches[0].value, 'node --test');

  await store.reject('project', revised.id);
  assert.equal((await store.recall({ scope: 'project' })).total, 0);
  const rejected = await store.review({ scope: 'project', status: 'rejected' });
  assert.equal(rejected.total, 1);
  assert.equal(rejected.items[0].id, revised.id);

  await store.forget('project', revised.id);
  assert.equal((await store.review({ scope: 'project' })).total, 0);
  await assert.rejects(store.approve('project', revised.id), /not found/);
});

test('memory recall filters approved facts by query and paginates results', async (t) => {
  const root = await createRoot(t);
  const store = new MemoryStore({ root, projectId: 'project-alpha' });

  const frontend = await store.remember({
    scope: 'project',
    key: 'stack.frontend',
    value: { framework: 'React', version: 19 },
    origin: 'user',
  });
  const backend = await store.remember({
    scope: 'project',
    key: 'stack.backend',
    value: { framework: 'Fastify' },
  });
  const pending = await store.remember({
    scope: 'project',
    key: 'draft.frontend',
    value: 'React draft',
  });
  await store.approve('project', frontend.id);
  await store.approve('project', backend.id);

  const caseInsensitive = await store.recall({ scope: 'project', query: 'react' });
  assert.equal(caseInsensitive.total, 1);
  assert.equal(caseInsensitive.matches[0].key, 'stack.frontend');

  const pendingIncluded = await store.recall({
    scope: 'project',
    query: 'REACT',
    includePending: true,
  });
  assert.equal(pendingIncluded.total, 2);
  assert.deepEqual(
    pendingIncluded.matches.map((entry) => entry.key).sort(),
    ['draft.frontend', 'stack.frontend'],
  );
  assert.equal(pendingIncluded.matches.some((entry) => entry.id === pending.id), true);

  const filtered = await store.recall({
    scope: 'project',
    key: 'stack.backend',
    query: 'react',
  });
  assert.equal(filtered.total, 0);

  const firstPage = await store.recall({ scope: 'project', limit: 1 });
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.matches.length, 1);
  assert.equal(firstPage.hasMore, true);

  const secondPage = await store.recall({ scope: 'project', offset: 1, limit: 1 });
  assert.equal(secondPage.matches.length, 1);
  assert.equal(secondPage.hasMore, false);
  assert.notEqual(secondPage.matches[0].id, firstPage.matches[0].id);

  const pastEnd = await store.recall({ scope: 'project', offset: 2, limit: 1 });
  assert.equal(pastEnd.total, 2);
  assert.equal(pastEnd.matches.length, 0);
  assert.equal(pastEnd.hasMore, false);

  const reviewPage = await store.review({ scope: 'project', status: 'all', limit: 1 });
  assert.equal(reviewPage.total, 3);
  assert.equal(reviewPage.items.length, 1);
  assert.equal(reviewPage.hasMore, true);
});

test('memory get returns the current entry and write queues serialize per scope', async (t) => {
  const root = await createRoot(t);
  const store = new MemoryStore({ root, projectId: 'project-alpha' });

  const [first, second] = await Promise.all([
    store.remember({ scope: 'user', key: 'concurrent.fact', value: 'first' }),
    store.remember({ scope: 'user', key: 'concurrent.fact', value: 'second' }),
  ]);
  assert.equal(first.id, second.id);
  assert.deepEqual([first.revision, second.revision], [1, 2]);

  const all = await store.review({ scope: 'user', status: 'all' });
  assert.equal(all.total, 1);
  assert.equal(all.items[0].revision, 2);
  assert.equal(all.items[0].value, 'second');

  const current = await store.get('user', first.id);
  assert.equal(current.id, first.id);
  assert.equal(current.status, 'pending');
  assert.equal(current.sourceTrust, 'untrusted-memory-content');
  assert.equal(await store.get('user', 'missing-id'), null);

  await store.approve('user', first.id);
  assert.equal((await store.get('user', first.id)).status, 'approved');
  assert.equal((await store.recall({ scope: 'user', key: 'concurrent.fact' })).total, 1);
});

test('memory store enforces review limits and resource caps', async (t) => {
  const root = await createRoot(t);
  const store = new MemoryStore({ root, projectId: 'safe' });

  await assert.rejects(store.review({ scope: 'user', offset: -1 }), /offset/);
  await assert.rejects(store.review({ scope: 'user', limit: 0 }), /limit/);
  await assert.rejects(store.review({ scope: 'user', limit: MAX_MEMORY_REVIEW_LIMIT + 1 }), /limit/);
  await assert.rejects(store.recall({ scope: 'user', offset: -1 }), /offset/);
  await assert.rejects(store.recall({ scope: 'user', limit: MAX_MEMORY_REVIEW_LIMIT + 1 }), /limit/);
  await assert.rejects(store.recall({ scope: 'user', includePending: 'yes' }), /includePending/);
  await assert.rejects(
    store.remember({ scope: 'user', key: 'key', value: 'value', sessionId: '' }),
    /sessionId/,
  );

  const oversizedRecord = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`key${index}`, 'x'.repeat(MAX_MEMORY_VALUE_CHARS)]),
  );
  await assert.rejects(
    store.remember({ scope: 'user', key: 'too.large', value: oversizedRecord }),
    /memory event exceeds/,
  );

  const oversizedRoot = await createRoot(t);
  const oversizedUserDir = join(oversizedRoot, 'user');
  await mkdir(oversizedUserDir, { recursive: true });
  await writeFile(join(oversizedUserDir, 'memory.jsonl'), Buffer.alloc(MAX_MEMORY_FILE_SIZE + 1));
  await assert.rejects(
    new MemoryStore({ root: oversizedRoot }).review({ scope: 'user' }),
    /memory file exceeds/,
  );

  const entriesRoot = await createRoot(t);
  const entriesProjectDir = join(entriesRoot, 'projects', 'safe');
  await mkdir(entriesProjectDir, { recursive: true });
  const now = new Date().toISOString();
  const records = Array.from({ length: MAX_MEMORY_ENTRIES + 1 }, (_, index) => JSON.stringify({
    type: 'put',
    id: randomUUID(),
    scope: 'project',
    key: `key-${index}`,
    value: 'value',
    status: 'approved',
    revision: 1,
    origin: 'agent',
    createdAt: now,
    updatedAt: now,
  }));
  await writeFile(join(entriesProjectDir, 'memory.jsonl'), `${records.join('\n')}\n`, 'utf8');
  await assert.rejects(
    new MemoryStore({ root: entriesRoot, projectId: 'safe' }).review({ scope: 'project' }),
    /memory exceeds .* entries/,
  );
});

test('memory store rejects unsafe input and corrupt logs', async (t) => {
  const root = await createRoot(t);

  assert.throws(() => new MemoryStore({ root, projectId: '../escape' }), /projectId/);
  assert.throws(() => new MemoryStore({ root, projectId: '.' }), /projectId/);
  assert.throws(() => new MemoryStore({ root, projectId: '' }), /projectId/);

  const noProject = new MemoryStore({ root });
  await assert.rejects(
    noProject.remember({ scope: 'project', key: 'key', value: 'value' }),
    /projectId/,
  );

  const store = new MemoryStore({ root, projectId: 'safe' });
  await assert.rejects(
    store.remember({ scope: 'global', key: 'key', value: 'value' }),
    /scope/,
  );
  await assert.rejects(store.remember({ scope: 'user', key: '', value: 'value' }), /key/);
  await assert.rejects(
    store.remember({ scope: 'user', key: 'k'.repeat(MAX_MEMORY_KEY_CHARS + 1), value: 'value' }),
    /key/,
  );
  await assert.rejects(
    store.remember({ scope: 'user', key: 'key', value: 'v'.repeat(MAX_MEMORY_VALUE_CHARS + 1) }),
    /value/,
  );
  await assert.rejects(
    store.remember({ scope: 'user', key: 'key', value: new Date('2026-11-22') }),
    /value/,
  );
  await assert.rejects(
    store.remember({ scope: 'user', key: 'key', value: new Map([['key', 'value']]) }),
    /value/,
  );
  await assert.rejects(
    store.remember({ scope: 'user', key: 'key', value: { nested: undefined } }),
    /value/,
  );
  await assert.rejects(
    store.remember({ scope: 'user', key: 'key', value: Number.NaN }),
    /value/,
  );
  await assert.rejects(
    store.remember({ scope: 'user', key: 'key', value: { toJSON: () => ({}) } }),
    /value/,
  );
  await assert.rejects(
    store.remember({
      scope: 'user',
      key: 'key',
      value: deeplyNested(MAX_MEMORY_DEPTH + 1),
    }),
    /depth/,
  );
  await assert.rejects(
    store.remember({ scope: 'user', key: 'key', value: 'value', origin: 'system' }),
    /origin/,
  );
  await assert.rejects(
    store.review({ scope: 'user', status: 'unknown' }),
    /status/,
  );
  await assert.rejects(
    store.recall({ scope: 'user', query: 'q'.repeat(MAX_MEMORY_QUERY_CHARS + 1) }),
    /query/,
  );

  const corruptRoot = await createRoot(t);
  const projectDir = join(corruptRoot, 'projects', 'safe');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'memory.jsonl'), '{"type":"put"}\n', 'utf8');
  const corrupt = new MemoryStore({ root: corruptRoot, projectId: 'safe' });
  await assert.rejects(corrupt.review({ scope: 'project' }), /invalid memory/);
});
