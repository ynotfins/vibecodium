import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cosineSimilarity } from '../../src/stable/index-engine/embedding-index.mjs';
import { LocalHashEmbeddingProvider } from '../../src/stable/index-engine/embedding-index.mjs';
import { ProjectIndex } from '../../src/stable/index-engine/index-engine.mjs';
import {
  DEFAULT_TABLE_NAME,
  LANCEDB_NODE_VERSION,
  LANCEDB_STORE_VERSION,
  LanceDbVectorStore,
  SOURCE_TRUST,
  openLanceDbVectorStore,
  validateLanceDriver,
  validateLanceVectorStore,
  validateVectorHits,
} from '../../src/stable/index-engine/lancedb-vector-store.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'repo-ts');
const HASH = 'a'.repeat(64);

function unquote(value) {
  return value.replace(/''/g, "'");
}

class FakeTable {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map((row) => ({ ...row }));
  }

  mergeInsert(field) {
    const table = this;
    const builder = {
      whenMatchedUpdateAll() {
        return builder;
      },
      whenNotMatchedInsertAll() {
        return builder;
      },
      async execute(records) {
        for (const record of records) {
          const index = table.rows.findIndex((row) => row[field] === record[field]);
          if (index >= 0) table.rows[index] = { ...record };
          else table.rows.push({ ...record });
        }
      },
    };
    return builder;
  }

  async add(records) {
    this.rows.push(...records.map((row) => ({ ...row })));
  }

  async delete(filter) {
    const ids = [];
    const inMatch = /^id IN \((.*)\)$/.exec(filter);
    if (inMatch) {
      for (const match of inMatch[1].matchAll(/'((?:[^']|'')*)'/g)) ids.push(unquote(match[1]));
    } else {
      const match = /^id = '((?:[^']|'')*)'$/.exec(filter);
      assert.ok(match, `unexpected delete filter: ${filter}`);
      ids.push(unquote(match[1]));
    }
    this.rows = this.rows.filter((row) => !ids.includes(row.id));
  }

  vectorSearch(vector) {
    const table = this;
    let take = 20;
    const request = {
      limit(value) {
        take = value;
        return request;
      },
      distanceType() {
        return request;
      },
      async toArray() {
        return table.rows
          .map((row) => ({ ...row, _distance: 1 - cosineSimilarity(vector, row.vector) }))
          .sort((left, right) => left._distance - right._distance)
          .slice(0, take);
      },
    };
    return request;
  }
}

class FakeDatabase {
  constructor() {
    this.tables = new Map();
  }

  async tableNames() {
    return [...this.tables.keys()];
  }

  async openTable(name) {
    const table = this.tables.get(name);
    if (!table) throw new Error('missing table');
    return table;
  }

  async createTable(name, rows) {
    if (this.tables.has(name)) throw new Error('table exists');
    const table = new FakeTable(name, rows);
    this.tables.set(name, table);
    return table;
  }
}

class FakeDriver {
  constructor() {
    this.databases = new Map();
  }

  async connect(uri) {
    if (!this.databases.has(uri)) this.databases.set(uri, new FakeDatabase());
    return this.databases.get(uri);
  }
}

async function tempCopy() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-lancedb-'));
  const root = path.join(dir, 'repo-ts');
  await cp(FIXTURE, root, { recursive: true, dereference: false });
  return { dir, root };
}

function makeStore(driver, provider, uri = 'fake-lance-db') {
  return openLanceDbVectorStore({ driver, uri, dimensions: provider.dimensions, provider: provider.id });
}

test('exposes the pinned driver contract and rejects malformed stores', async () => {
  assert.equal(LANCEDB_STORE_VERSION, 1);
  assert.equal(LANCEDB_NODE_VERSION, '0.41.0');
  assert.equal(DEFAULT_TABLE_NAME, 'vibecodium_file_vectors');
  assert.equal(SOURCE_TRUST, 'untrusted-repository-content');

  assert.throws(() => validateLanceDriver(null), /driver/);
  assert.throws(() => validateLanceDriver({}), /connect/);
  assert.equal(validateLanceDriver({ connect() {} }).connect instanceof Function, true);
  assert.throws(() => validateLanceDriver({ get connect() { throw new Error('secret text'); } }), /connect/);

  const provider = { id: 'local-hash-v1', dimensions: 8 };
  const store = { provider: 'local-hash-v1', dimensions: 8, upsert() {}, delete() {}, search() {} };
  assert.equal(validateLanceVectorStore(store, provider), store);
  assert.throws(() => validateLanceVectorStore({ provider: 'other', dimensions: 8, upsert() {}, delete() {}, search() {} }, provider), /provider/);
  assert.throws(() => validateLanceVectorStore({ provider: 'local-hash-v1', dimensions: 9, upsert() {}, delete() {}, search() {} }, provider), /dimensions/);
  assert.throws(() => validateLanceVectorStore({ provider: 'local-hash-v1', dimensions: 8, upsert() {}, delete() {} }, provider), /search/);
  assert.throws(() => validateLanceVectorStore({
    get provider() { throw new Error('secret text'); },
    dimensions: 8,
    upsert() {},
    delete() {},
    search() {},
  }, provider), /unreadable/);
  assert.throws(() => validateLanceVectorStore({
    provider: 'local-hash-v1',
    get dimensions() { throw new Error('secret text'); },
    upsert() {},
    delete() {},
    search() {},
  }, provider), /unreadable/);

  const hit = validateVectorHits([{ file: 'src/a.ts', score: 0.5, distance: 0.5, hash: HASH }], { limit: 1 })[0];
  assert.equal(hit.hash, HASH);
  assert.equal(hit.sourceTrust, SOURCE_TRUST);
  assert.throws(() => validateVectorHits([{ file: '../a.ts', score: 0.5, distance: 0.5 }]), /within/);
  assert.throws(() => validateVectorHits([{ file: 'src/a.ts', score: 2, distance: 0.5 }]), /score/);
  assert.throws(() => validateVectorHits([{ file: 'src/a.ts', score: 0.5, distance: 0.5, hash: 'nope' }]), /hash/);
  assert.throws(() => validateVectorHits([], { limit: 0 }), /limit/);
  assert.throws(() => validateVectorHits([{}], { limit: 1 }), /file/);
  assert.throws(() => validateVectorHits([
    { file: 'src/a.ts', score: 0.5, distance: 0.5 },
    { file: 'src/b.ts', score: 0.4, distance: 0.6 },
  ], { limit: 1 }), /too many/);
  assert.throws(() => validateVectorHits([
    { get file() { throw new Error('secret text'); }, score: 0.5, distance: 0.5 },
  ]), /unreadable/);

  assert.throws(() => new LanceDbVectorStore(), /driver/);
  assert.throws(() => new LanceDbVectorStore({ driver: {}, uri: 'db', dimensions: 8, provider: 'local-hash-v1' }), /connect/);
  assert.throws(() => new LanceDbVectorStore({ driver: { connect() {} }, uri: '', dimensions: 8, provider: 'local-hash-v1' }), /uri/);
  assert.throws(() => new LanceDbVectorStore({ driver: { connect() {} }, uri: 'https://example.test/db', dimensions: 8, provider: 'local-hash-v1' }), /local/);
  assert.throws(() => new LanceDbVectorStore({ driver: { connect() {} }, uri: "file:///tmp/db", dimensions: 8, provider: "local-hash-v1" }), /local/);
  assert.throws(() => new LanceDbVectorStore({ driver: { connect() {} }, uri: "\\\\server\\share", dimensions: 8, provider: "local-hash-v1" }), /local/);
  assert.throws(() => new LanceDbVectorStore({ driver: { connect() {} }, uri: 'db', dimensions: 0, provider: 'local-hash-v1' }), /dimensions/);
});

test('the injected store persists, replaces, searches and deletes vectors', async () => {
  const driver = new FakeDriver();
  const store = await openLanceDbVectorStore({
    driver,
    uri: 'fake-lance-db',
    dimensions: 8,
    provider: 'local-hash-v1',
  });

  await store.upsert([
    { file: 'src/a.ts', hash: HASH, vector: [1, 0, 0, 0, 0, 0, 0, 0] },
    { file: "src/b'quote.ts", hash: 'b'.repeat(64), vector: [0, 1, 0, 0, 0, 0, 0, 0] },
  ]);
  const first = await store.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 5 });
  assert.equal(first[0].file, 'src/a.ts');
  assert.equal(first[0].sourceTrust, SOURCE_TRUST);
  assert.ok(first[0].score > 0.99);

  await store.upsert([{ file: 'src/a.ts', hash: 'c'.repeat(64), vector: [0, 0, 1, 0, 0, 0, 0, 0] }]);
  const table = driver.databases.get('fake-lance-db').tables.get(DEFAULT_TABLE_NAME);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows.find((row) => row.file === 'src/a.ts').hash, 'c'.repeat(64));

  await store.delete(["src/b'quote.ts"]);
  assert.equal(table.rows.length, 1);
  await store.delete(['src\\a.ts']);
  assert.equal(table.rows.length, 0);
  assert.deepEqual(await store.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 5 }), []);
});

test('rejects a table without mergeInsert()', async () => {
  const driver = new FakeDriver();
  const store = await makeStore(driver, { id: 'local-hash-v1', dimensions: 8 });
  await store.upsert([{ file: 'src/a.ts', hash: HASH, vector: [1, 0, 0, 0, 0, 0, 0, 0] }]);
  const table = driver.databases.get('fake-lance-db').tables.get(DEFAULT_TABLE_NAME);
  table.mergeInsert = undefined;
  await assert.rejects(
    () => store.upsert([{ file: 'src/a.ts', hash: 'c'.repeat(64), vector: [0, 1, 0, 0, 0, 0, 0, 0] }]),
    /mergeInsert/,
  );
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].hash, HASH);
});

test('a failed merge-insert keeps the previous row', async () => {
  const driver = new FakeDriver();
  const store = await makeStore(driver, { id: 'local-hash-v1', dimensions: 8 });
  await store.upsert([{ file: 'src/a.ts', hash: HASH, vector: [1, 0, 0, 0, 0, 0, 0, 0] }]);
  const table = driver.databases.get('fake-lance-db').tables.get(DEFAULT_TABLE_NAME);
  table.mergeInsert = () => {
    const builder = {
      whenMatchedUpdateAll() { return builder; },
      whenNotMatchedInsertAll() { return builder; },
      async execute() { throw new Error('nope'); },
    };
    return builder;
  };
  await assert.rejects(
    () => store.upsert([{ file: 'src/a.ts', hash: 'c'.repeat(64), vector: [0, 1, 0, 0, 0, 0, 0, 0] }]),
    /upsert failed/,
  );
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].hash, HASH);
});

test('rejects malformed rows, vectors and search results', async () => {
  const driver = new FakeDriver();
  const store = await makeStore(driver, { id: 'local-hash-v1', dimensions: 8 });
  await assert.rejects(() => store.upsert([]), /between/);
  await assert.rejects(() => store.upsert([{ file: 'src/a.ts', hash: 'nope', vector: [1, 0, 0, 0, 0, 0, 0, 0] }]), /hash/);
  await assert.rejects(() => store.upsert([{ file: 'src/a.ts', hash: HASH, vector: [1, 0] }]), /exactly 8/);
  await assert.rejects(() => store.upsert([{ file: 'bad\u0000path', hash: HASH, vector: new Array(8).fill(0) }]), /file/);
  await assert.rejects(() => store.upsert([{ file: '../escape.ts', hash: HASH, vector: new Array(8).fill(0) }]), /within/);
  await assert.rejects(() => store.upsert([{ file: 'src/\u202Eevil.ts', hash: HASH, vector: new Array(8).fill(0) }]), /file/);
  await assert.rejects(() => store.upsert([{ file: 'src/a.ts:stream', hash: HASH, vector: new Array(8).fill(0) }]), /file/);
  await assert.rejects(() => store.upsert([{ file: 'src/<evil>.ts', hash: HASH, vector: new Array(8).fill(0) }]), /file/);
  await assert.rejects(() => store.upsert([{ file: 'src/trailing.ts.', hash: HASH, vector: new Array(8).fill(0) }]), /portable/);
  await assert.rejects(() => store.upsert([{ file: 'src/trailing.ts ', hash: HASH, vector: new Array(8).fill(0) }]), /portable/);
  await assert.rejects(() => store.upsert([{ file: 'src/NUL.ts', hash: HASH, vector: new Array(8).fill(0) }]), /portable/);
  await assert.rejects(() => store.upsert([{ file: 'src/a.ts', get hash() { throw new Error('secret text'); }, vector: new Array(8).fill(0) }]), /unreadable/);
  await assert.rejects(() => store.upsert([{ file: 'src/a.ts', hash: HASH, get vector() { throw new Error('secret text'); } }]), /unreadable/);
  await assert.rejects(() => store.upsert([
    { file: 'src/a.ts', hash: HASH, vector: new Array(8).fill(0) },
    { file: 'src/a.ts', hash: 'b'.repeat(64), vector: new Array(8).fill(0) },
  ]), /unique/);
  await assert.rejects(() => store.upsert([
    { file: 'src/a.ts', hash: HASH, vector: new Array(8).fill(0) },
    { file: 'src\\a.ts', hash: 'b'.repeat(64), vector: new Array(8).fill(0) },
  ]), /unique/);
  const unreadable = Object.defineProperty({}, 'file', { get() { throw new Error('secret text'); } });
  await assert.rejects(() => store.upsert([unreadable]), /unreadable/);
  await assert.rejects(() => store.upsert([{ file: 'C:\\escape.ts', hash: HASH, vector: new Array(8).fill(0) }]), /relative/);
  await assert.rejects(() => store.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 0 }), /limit/);
  await assert.rejects(() => store.search([1, 0], { limit: 1 }), /exactly 8/);

  await store.upsert([{ file: 'src/a.ts', hash: HASH, vector: [1, 0, 0, 0, 0, 0, 0, 0] }]);
  const table = driver.databases.get('fake-lance-db').tables.get(DEFAULT_TABLE_NAME);
  const original = table.vectorSearch.bind(table);
  table.vectorSearch = () => null;
  await assert.rejects(() => store.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 1 }), /query is invalid/);
  table.vectorSearch = () => ({ limit() { return this; }, async toArray() { return 'nope'; } });
  await assert.rejects(() => store.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 1 }), /result is invalid/);
  table.vectorSearch = () => ({
    limit() { return this; },
    async toArray() { return [{ file: 'src/a.ts', _distance: 0.1 }, { file: 'src/b.ts', _distance: 0.2 }]; },
  });
  await assert.rejects(() => store.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 1 }), /too many rows/);
  table.vectorSearch = () => ({
    limit() { return this; },
    async toArray() { return [{ get file() { throw new Error('secret text'); }, _distance: 0.1 }]; },
  });
  await assert.rejects(() => store.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 1 }), /unreadable/);
  table.vectorSearch = () => ({
    limit() { return this; },
    async toArray() { return [{ file: 'src/a.ts', _distance: -1 }]; },
  });
  await assert.rejects(() => store.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 1 }), /distance/);
  table.vectorSearch = () => ({
    limit() { return this; },
    async toArray() { return [{ file: 'src/a.ts', _distance: Number.NaN }]; },
  });
  await assert.rejects(() => store.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 1 }), /distance/);
  table.vectorSearch = original;
});

test('ProjectIndex mirrors embeddings into the store and removes deleted files', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = new LocalHashEmbeddingProvider({ dimensions: 32 });
  const driver = new FakeDriver();
  const store = await makeStore(driver, provider);
  const index = new ProjectIndex(root, { embeddingProvider: provider, vectorStore: store });

  const report = await index.refresh();
  const table = driver.databases.get('fake-lance-db').tables.get(DEFAULT_TABLE_NAME);
  assert.equal(table.rows.length, report.stats.files);
  for (const row of table.rows) {
    assert.equal(row.provider, 'local-hash-v1');
    assert.equal(row.dimensions, 32);
    assert.equal(row.vector.length, 32);
    assert.equal(row.hash, report.index.files[row.file].hash);
    assert.equal(row.sourceTrust, SOURCE_TRUST);
  }

  const hits = await index.searchVectors('where is auth middleware');
  assert.ok(hits.slice(0, 3).some((hit) => hit.file === 'src/auth/middleware.ts'), JSON.stringify(hits.slice(0, 3)));

  const changed = path.join(root, 'src', 'util', 'strings.ts');
  await writeFile(changed, `${await readFile(changed, 'utf8')}\nexport const addedSymbol = 1;\n`);
  const reindexed = await index.reindexFile('src/util/strings.ts');
  assert.equal(reindexed.changed, true);
  const changedRows = table.rows.filter((row) => row.file === 'src/util/strings.ts');
  assert.equal(changedRows.length, 1);
  assert.equal(changedRows[0].hash, reindexed.index.files['src/util/strings.ts'].hash);

  await rm(changed);
  await index.refresh({ full: true });
  assert.equal(table.rows.some((row) => row.file === 'src/util/strings.ts'), false);
  assert.equal(table.rows.length, Object.keys(index.current.files).length);
});

test('full refresh backfills a newly configured store', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = new LocalHashEmbeddingProvider({ dimensions: 20 });
  const seeded = new ProjectIndex(root, { embeddingProvider: provider });
  const base = await seeded.refresh();

  const driver = new FakeDriver();
  const store = await makeStore(driver, provider);
  const index = new ProjectIndex(root, {
    embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 20 }),
    vectorStore: store,
  });
  await index.refresh({ full: true });
  const table = driver.databases.get('fake-lance-db').tables.get(DEFAULT_TABLE_NAME);
  assert.equal(table.rows.length, base.stats.files);
  for (const file of Object.keys(index.current.files)) {
    assert.ok(table.rows.some((row) => row.file === file), file);
  }
});

test('a store failure rejects refresh and leaves the committed index untouched', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = new LocalHashEmbeddingProvider({ dimensions: 16 });
  const index = new ProjectIndex(root, {
    embeddingProvider: provider,
    vectorStore: {
      provider: 'local-hash-v1',
      dimensions: 16,
      upsert: async () => { throw new Error('boom'); },
      delete: async () => {},
      search: async () => [],
    },
  });
  await assert.rejects(() => index.refresh(), /boom/);
  assert.equal(index.current, null);
  await assert.rejects(() => readFile(index.indexPath, 'utf8'), /ENOENT/);
});

test('searchVectors requires a configured store and a loaded index', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plain = new ProjectIndex(root);
  await plain.refresh();
  await assert.rejects(() => plain.searchVectors('auth'), /vectorStore/);

  const provider = new LocalHashEmbeddingProvider({ dimensions: 8 });
  const store = await makeStore(new FakeDriver(), provider);
  const index = new ProjectIndex(root, { embeddingProvider: provider, vectorStore: store });
  await assert.rejects(() => index.searchVectors('auth'), /not loaded/);
  await index.refresh();
  await assert.rejects(() => index.searchVectors(''), /query/);
  await assert.rejects(() => index.searchVectors('auth', { limit: 0 }), /limit/);

  assert.throws(() => new ProjectIndex(root, {
    embeddingProvider: provider,
    vectorStore: { provider: 'other', dimensions: 8, upsert() {}, delete() {}, search() {} },
  }), /provider/);

  const faultyIndex = new ProjectIndex(root, {
    embeddingProvider: provider,
    vectorStore: {
      provider: 'local-hash-v1',
      dimensions: 8,
      upsert: async () => {},
      delete: async () => {},
      search: async () => [{ file: '../escape.ts', score: 0.5, distance: 0.5 }],
    },
  });
  await faultyIndex.refresh();
  await assert.rejects(() => faultyIndex.searchVectors('auth'), /within/);
});

test('a second index can search vectors persisted by an earlier index', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = new LocalHashEmbeddingProvider({ dimensions: 24 });
  const driver = new FakeDriver();
  const first = await makeStore(driver, provider);
  const writer = new ProjectIndex(root, { embeddingProvider: provider, vectorStore: first });
  await writer.refresh();
  await first.open();

  const second = await makeStore(driver, provider);
  const reader = new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 24 }), vectorStore: second });
  await reader.load();
  const hits = await reader.searchVectors('where is auth middleware', { limit: 3 });
  assert.ok(hits.some((hit) => hit.file === 'src/auth/middleware.ts'), JSON.stringify(hits));
});

test('validates the connection, table list and merge-insert builder', async () => {
  const provider = { id: 'local-hash-v1', dimensions: 8 };
  const openWith = (db) => openLanceDbVectorStore({
    driver: { connect: async () => db },
    uri: 'fake-lance-db',
    dimensions: 8,
    provider: 'local-hash-v1',
  });

  await assert.rejects(() => openWith(null), /unsupported shape/);
  await assert.rejects(() => openWith({
    createTable() {},
    openTable() {},
    tableNames: async () => { throw new Error('secret text'); },
  }), /table list failed/);
  await assert.rejects(() => openWith({
    createTable() {},
    openTable() {},
    tableNames: async () => 'nope',
  }), /table list is invalid/);
  await assert.rejects(() => openWith({
    createTable() {},
    openTable() {},
    tableNames: async () => ['ok', 7],
  }), /table list is invalid/);
  await assert.rejects(() => openWith({
    createTable() {},
    openTable: async () => { throw new Error('secret text'); },
    tableNames: async () => [DEFAULT_TABLE_NAME],
  }), /could not be opened/);
  await assert.rejects(() => openWith({
    createTable() {},
    openTable: async () => ({
      get vectorSearch() { throw new Error('secret text'); },
      delete() {},
      mergeInsert() {},
    }),
    tableNames: async () => [DEFAULT_TABLE_NAME],
  }), /table is invalid/);

  const driver = new FakeDriver();
  const store = await makeStore(driver, provider);
  await store.upsert([{ file: 'src/a.ts', hash: HASH, vector: [1, 0, 0, 0, 0, 0, 0, 0] }]);
  const table = driver.databases.get('fake-lance-db').tables.get(DEFAULT_TABLE_NAME);
  table.mergeInsert = () => ({
    whenMatchedUpdateAll() { return this; },
    whenNotMatchedInsertAll() { return this; },
  });
  await assert.rejects(
    () => store.upsert([{ file: 'src/a.ts', hash: 'c'.repeat(64), vector: [0, 1, 0, 0, 0, 0, 0, 0] }]),
    /builder is invalid/,
  );
});

test('refresh verifies the snapshot before syncing the store and writing the index', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const real = await realpath(root);
  const info = await stat(real);
  const identity = {
    rootKey: process.platform === 'win32' ? real.toLowerCase() : real,
    rootDev: info.dev,
    rootIno: info.ino,
  };
  const provider = new LocalHashEmbeddingProvider({ dimensions: 8 });
  const events = [];
  let index;
  const store = {
    provider: provider.id,
    dimensions: provider.dimensions,
    async upsert(rows) {
      let persisted = null;
      try {
        persisted = JSON.parse(await readFile(index.indexPath, 'utf8'));
      } catch {
        persisted = null;
      }
      events.push({ op: 'upsert', rows: rows.length, indexExists: persisted !== null });
    },
    async delete() { events.push({ op: 'delete' }); },
    async search() { return []; },
  };
  index = new ProjectIndex(root, { embeddingProvider: provider, vectorStore: store });
  const verify = index.verifySnapshot.bind(index);
  index.verifySnapshot = async (snapshot, expectedRoot) => {
    events.push({ op: 'verify' });
    return verify(snapshot, expectedRoot);
  };

  await index.refresh({ expectedRoot: identity });
  assert.deepEqual(events.map((event) => event.op), ['verify', 'upsert']);
  assert.equal(events[1].indexExists, false);
});

test('rejects bidi and format characters in the database uri', () => {
  const driver = { connect() {} };
  for (const uri of ['db\u202Eevil', 'db\u200Eevil', 'db\u2066evil', 'db\u200Bevil', 'db<>evil']) {
    assert.throws(
      () => new LanceDbVectorStore({ driver, uri, dimensions: 8, provider: 'local-hash-v1' }),
      /unsupported/,
      uri,
    );
  }
  assert.equal(new LanceDbVectorStore({ driver, uri: 'D:\\vibe-lance-db', dimensions: 8, provider: 'local-hash-v1' }).uri, 'D:\\vibe-lance-db');
});

test('turns throwing merge-insert accessors into fixed errors', async () => {
  const driver = new FakeDriver();
  const store = await makeStore(driver, { id: 'local-hash-v1', dimensions: 8 });
  await store.upsert([{ file: 'src/a.ts', hash: HASH, vector: [1, 0, 0, 0, 0, 0, 0, 0] }]);
  const table = driver.databases.get('fake-lance-db').tables.get(DEFAULT_TABLE_NAME);
  Object.defineProperty(table, 'mergeInsert', { get() { throw new Error('secret text'); }, configurable: true });
  await assert.rejects(
    () => store.upsert([{ file: 'src/a.ts', hash: 'c'.repeat(64), vector: [0, 1, 0, 0, 0, 0, 0, 0] }]),
    /upsert failed/,
  );
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].hash, HASH);

  Object.defineProperty(table, 'mergeInsert', {
    configurable: true,
    value: () => {
      const builder = {
        get whenMatchedUpdateAll() { throw new Error('secret text'); },
        whenNotMatchedInsertAll() { return builder; },
        async execute() {},
      };
      return builder;
    },
  });
  await assert.rejects(
    () => store.upsert([{ file: 'src/a.ts', hash: 'c'.repeat(64), vector: [0, 1, 0, 0, 0, 0, 0, 0] }]),
    /upsert failed/,
  );
  assert.equal(table.rows.length, 1);
});

test('bounds cosine distance to the plausible range', () => {
  const hit = validateVectorHits([{ file: 'src/a.ts', score: 0, distance: 2 }], { limit: 1 })[0];
  assert.equal(hit.distance, 2);
  assert.throws(() => validateVectorHits([{ file: 'src/a.ts', score: 0, distance: 2.5 }]), /distance/);
});

test('chunks large deletes into bounded filters', async () => {
  const driver = new FakeDriver();
  const store = await makeStore(driver, { id: 'local-hash-v1', dimensions: 8 });
  await store.upsert([{ file: 'src/seed.ts', hash: HASH, vector: [1, 0, 0, 0, 0, 0, 0, 0] }]);
  const table = driver.databases.get('fake-lance-db').tables.get(DEFAULT_TABLE_NAME);
  const filters = [];
  const original = table.delete.bind(table);
  table.delete = (filter) => {
    filters.push(filter);
    return original(filter);
  };
  const files = Array.from({ length: 450 }, (_, index) => `src/f${String(index).padStart(4, '0')}.ts`);
  assert.equal(await store.delete(files), 450);
  assert.equal(filters.length, 3);
  for (const filter of filters) {
    assert.ok(filter.startsWith('id IN ('), filter);
    assert.ok(filter.match(/'/g).length / 2 <= 200, filter);
  }
});
test('rejects file keys that alias on Windows', async () => {
  const driver = new FakeDriver();
  const store = await makeStore(driver, { id: 'local-hash-v1', dimensions: 8 });
  for (const file of ['src/trailing.ts.', 'src/trailing.ts ', 'src/NUL.ts', 'src/com1.log', 'src/LPT9']) {
    await assert.rejects(
      () => store.upsert([{ file, hash: HASH, vector: new Array(8).fill(0) }]),
      /portable/,
      file,
    );
  }
  assert.equal((await store.upsert([{ file: 'src/console.ts', hash: HASH, vector: new Array(8).fill(0) }])), 1);
});
