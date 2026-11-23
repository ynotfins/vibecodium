import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { INDEX_VERSION, ProjectIndex } from '../../src/stable/index-engine/index-engine.mjs';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  EMBEDDING_INDEX_VERSION,
  LocalHashEmbeddingProvider,
  MAX_EMBEDDING_VALUE,
  cosineSimilarity,
  validateEmbeddingVector,
} from '../../src/stable/index-engine/embedding-index.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'repo-ts');

async function tempCopy() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-embedding-'));
  const root = path.join(dir, 'repo-ts');
  await cp(FIXTURE, root, { recursive: true, dereference: false });
  return { dir, root };
}

test('local embeddings are deterministic, normalized and provider-checked', async () => {
  const provider = new LocalHashEmbeddingProvider({ dimensions: 128 });
  const [first, repeated, different] = await provider.embed([
    'auth middleware',
    'auth middleware',
    'session store',
  ]);

  assert.equal(provider.id, 'local-hash-v1');
  assert.equal(provider.dimensions, 128);
  assert.equal(provider.allowsVectorOnly, false);
  assert.equal(EMBEDDING_INDEX_VERSION, 1);
  assert.equal(DEFAULT_EMBEDDING_DIMENSIONS, 256);
  assert.throws(() => new LocalHashEmbeddingProvider(null), /options/);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, different);
  assert.equal(first.length, 128);
  assert.ok(Math.abs(Math.hypot(...first) - 1) < 1e-9);
  assert.ok(cosineSimilarity(first, repeated) > 0.999);
  assert.ok(cosineSimilarity(first, different) < 0.999);
  const sourceVector = [0.5, -0.5];
  assert.equal(validateEmbeddingVector(sourceVector, 2), sourceVector);
  assert.throws(() => validateEmbeddingVector([1e308, 0], 2), /within/);
  assert.ok(
    cosineSimilarity([MAX_EMBEDDING_VALUE, MAX_EMBEDDING_VALUE], [MAX_EMBEDDING_VALUE, MAX_EMBEDDING_VALUE]) >
      0.999999999,
  );
  assert.throws(() => cosineSimilarity([1e308, 0], [1, 0]), /bounded/);

  assert.throws(() => new LocalHashEmbeddingProvider({ dimensions: 0 }), /dimensions/);
  assert.throws(() => new LocalHashEmbeddingProvider({ dimensions: 1.5 }), /dimensions/);
  assert.throws(() => new LocalHashEmbeddingProvider({ dimensions: 4097 }), /dimensions/);
  assert.throws(() => cosineSimilarity([1, 2], [1]), /length/);
});

test('persists embeddings and returns auth middleware in the top 3 for a natural-language query', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const provider = new LocalHashEmbeddingProvider({ dimensions: 128 });
  const index = new ProjectIndex(root, { embeddingProvider: provider });
  const report = await index.refresh();

  assert.equal(report.index.version, INDEX_VERSION);
  assert.deepEqual(report.index.embedding, { provider: 'local-hash-v1', dimensions: 128, version: 1 });
  const middleware = report.index.files['src/auth/middleware.ts'];
  assert.ok(Array.isArray(middleware.embedding));
  assert.equal(middleware.embedding.length, 128);
  assert.ok(middleware.embedding.every((value) => Number.isFinite(value)));

  const hits = await index.searchHybrid('where is auth middleware');
  assert.ok(hits.length > 0);
  assert.ok(
    hits.slice(0, 3).some((hit) => hit.file === 'src/auth/middleware.ts'),
    JSON.stringify(hits.slice(0, 3)),
  );
  assert.ok(hits[0].score > 0);
  assert.ok(hits.every((hit) => hit.score >= 0 && hit.score <= 1));
  assert.ok(hits.every((hit) => Number.isFinite(hit.lexicalScore) && Number.isFinite(hit.vectorScore)));
  assert.ok(hits.every((hit) => hit.lexicalScore >= 0 && hit.lexicalScore <= 1));
  assert.ok(hits.every((hit) => hit.vectorScore >= 0 && hit.vectorScore <= 1));

  const loaded = new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 128 }) });
  const reloaded = await loaded.load();
  assert.deepEqual(reloaded.index.embedding, { provider: 'local-hash-v1', dimensions: 128, version: 1 });
  const reloadedHits = await loaded.searchHybrid('where is auth middleware');
  assert.ok(reloadedHits.slice(0, 3).some((hit) => hit.file === 'src/auth/middleware.ts'));

  const parsed = JSON.parse(await readFile(index.indexPath, 'utf8'));
  assert.equal(parsed.version, 4);
  assert.equal(parsed.embedding.provider, 'local-hash-v1');
  assert.equal(parsed.embedding.dimensions, 128);
  assert.equal(parsed.embedding.version, 1);
  assert.equal(parsed.files['src/auth/middleware.ts'].embedding.length, 128);
});

test('incremental reindex refreshes only the changed file embedding', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const base = new LocalHashEmbeddingProvider({ dimensions: 64 });
  let embeddedTexts = 0;
  const provider = {
    id: base.id,
    dimensions: base.dimensions,
    embed: async (texts) => {
      embeddedTexts += texts.length;
      return base.embed(texts);
    },
  };
  const index = new ProjectIndex(root, { embeddingProvider: provider });
  const first = await index.refresh();
  const afterRefresh = embeddedTexts;
  assert.ok(afterRefresh >= 5);
  const unchanged = await index.reindexFile('src/auth/session.ts');
  assert.equal(unchanged.changed, false);
  assert.equal(embeddedTexts, afterRefresh);
  const before = new Map(Object.entries(first.index.files).map(([file, entry]) => [file, entry.embedding]));

  const target = path.join(root, 'src', 'util', 'strings.ts');
  const original = await readFile(target, 'utf8');
  await writeFile(target, `${original}\nexport function authenticationMiddleware(): string {\n  return 'auth middleware';\n}\n`);

  const started = process.hrtime.bigint();
  const update = await index.reindexFile('src/util/strings.ts');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(update.changed, true);
  assert.ok(elapsedMs < 2000, `reindex took ${elapsedMs.toFixed(1)} ms`);
  assert.equal(embeddedTexts, afterRefresh + 1);
  assert.notDeepEqual(update.index.files['src/util/strings.ts'].embedding, before.get('src/util/strings.ts'));
  for (const [file, embedding] of before) {
    if (file !== 'src/util/strings.ts') assert.deepEqual(update.index.files[file].embedding, embedding);
  }
});

test('rejects a persisted index built with another embedding provider or dimensions', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 64 }) });
  await index.refresh();

  const differentProvider = new ProjectIndex(root, {
    embeddingProvider: { id: 'other-hash', dimensions: 64, embed: () => [Array(64).fill(0)] },
  });
  await assert.rejects(differentProvider.load(), /different embedding provider/);

  const differentDimensions = new ProjectIndex(root, {
    embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 128 }),
  });
  await assert.rejects(differentDimensions.load(), /embedding provider|embedding dimensions/);
  const rebuilt = await differentDimensions.refresh();
  assert.equal(rebuilt.index.embedding.dimensions, 128);

  const parsed = JSON.parse(await readFile(index.indexPath, 'utf8'));
  parsed.files['src/auth/middleware.ts'].embedding = [1, 2, 3];
  await writeFile(index.indexPath, `${JSON.stringify(parsed)}\n`);
  await assert.rejects(
    new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 128 }) }).load(),
    /embedding/,
  );
});

test('rejects malformed providers and vectors before they reach the index', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.throws(
    () => new ProjectIndex(root, { embeddingProvider: { id: 'Bad', dimensions: 64, embed: () => [] } }),
    /embeddingProvider.id/,
  );
  assert.throws(
    () => new ProjectIndex(root, { embeddingProvider: { id: 'bad', dimensions: 0, embed: () => [] } }),
    /dimensions/,
  );
  assert.throws(
    () => new ProjectIndex(root, { embeddingProvider: { id: 'bad', dimensions: 64, embed: 'nope' } }),
    /embed/,
  );
  assert.throws(
    () => new ProjectIndex(root, {
      embeddingProvider: { id: 'bad', dimensions: 64, allowsVectorOnly: 'yes', embed: () => [] },
    }),
    /allowsVectorOnly/,
  );

  const bad = new ProjectIndex(root, {
    persist: false,
    embeddingProvider: { id: 'bad-vector', dimensions: 64, embed: () => [[1, 2]] },
  });
  await assert.rejects(bad.refresh(), /embedding/);
});

test('hybrid search validates queries and returns no invented hits', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 64 }) });
  await index.refresh();
  await assert.rejects(index.searchHybrid(''), /query/);
  await assert.rejects(index.searchHybrid('x'.repeat(201)), /query/);
  assert.deepEqual(await index.searchHybrid('not-in-this-repository-xyz'), []);
  assert.deepEqual(await index.searchHybrid('how do I bake sourdough bread'), []);
  for (const query of [
    'guitar chord progression',
    'blockchain consensus',
    'vue component props',
    'angular service injector',
    'rainforest canopy',
  ]) {
    assert.deepEqual(await index.searchHybrid(query), [], `unrelated query ${JSON.stringify(query)} returned invented hits`);
  }
});

test('hybrid search enforces its own load and limit guards', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 64 }) });
  await assert.rejects(index.searchHybrid('auth'), /index not loaded/);

  await index.refresh();
  await assert.rejects(index.searchHybrid('auth', { limit: 0 }), /limit/);
  await assert.rejects(index.searchHybrid('auth', { limit: 101 }), /limit/);
  await assert.rejects(index.searchHybrid('auth', { limit: 1.5 }), /limit/);
  const bounded = await index.searchHybrid('auth', { limit: 1 });
  assert.ok(bounded.length <= 1);
});

test('rejects persisted embedding metadata and vectors that are missing or non-finite', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 64 }) });
  await index.refresh();
  const original = JSON.parse(await readFile(index.indexPath, 'utf8'));

  const withoutMetadata = { ...original };
  delete withoutMetadata.embedding;
  await writeFile(index.indexPath, `${JSON.stringify(withoutMetadata)}\n`);
  await assert.rejects(
    new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 64 }) }).load(),
    /embedding metadata/,
  );

  const wrongEmbeddingVersion = { ...original, embedding: { ...original.embedding, version: 2 } };
  await writeFile(index.indexPath, `${JSON.stringify(wrongEmbeddingVersion)}\n`);
  await assert.rejects(
    new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 64 }) }).load(),
    /embedding format/,
  );

  const nonFinite = { ...original, files: { ...original.files } };
  nonFinite.files['src/auth/middleware.ts'] = {
    ...nonFinite.files['src/auth/middleware.ts'],
    embedding: [...original.files['src/auth/middleware.ts'].embedding],
  };
  nonFinite.files['src/auth/middleware.ts'].embedding[0] = null;
  await writeFile(index.indexPath, `${JSON.stringify(nonFinite)}\n`);
  await assert.rejects(
    new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 64 }) }).load(),
    /embedding/,
  );
});

test('rejects a persisted vector with a huge finite value on load', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 64 }) });
  await index.refresh();
  const parsed = JSON.parse(await readFile(index.indexPath, 'utf8'));
  parsed.files['src/auth/middleware.ts'].embedding[0] = 1e308;
  await writeFile(index.indexPath, `${JSON.stringify(parsed)}\n`);

  await assert.rejects(
    new ProjectIndex(root, { embeddingProvider: new LocalHashEmbeddingProvider({ dimensions: 64 }) }).load(),
    /embedding/,
  );
});
