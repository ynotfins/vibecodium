import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { INDEX_VERSION, IndexEngineError, ProjectIndex } from '../../src/stable/index-engine/index-engine.mjs';
import {
  MAX_RUNTIME_BYTES,
  TREE_SITTER_PROVIDER_ID,
  createDefaultSymbolProvider,
  createTreeSitterProvider,
} from '../../src/stable/index-engine/tree-sitter-provider.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'repo-ts');
const VENDOR = path.join(REPO_ROOT, 'src', 'stable', 'index-engine', 'vendor', 'tree-sitter');
const KNOWN_SYMBOLS = [
  'AuthContext', 'Next', 'AuthMiddleware', 'handle', 'requireUser', 'authHeader',
  'SessionRecord', 'MAX_SESSIONS', 'SessionStore', 'get', 'put', 'size', 'createSession',
  'defaultPort', 'ServerOptions', 'createServer', 'HttpServer', 'start', 'getUser',
  'userRoute', 'slugify', 'emptyString', 'counter', 'nextCounter',
];
const ASSET_SIZES = {
  'LICENSE': 1141,
  'tree-sitter.js': 168729,
  'tree-sitter.wasm': 206218,
  'tree-sitter-javascript.wasm': 411770,
  'tree-sitter-typescript.wasm': 1413849,
  'tree-sitter-tsx.wasm': 1445638,
};
const ASSET_HASHES = {
  'LICENSE': 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383',
  'tree-sitter.js': '874f4a37c4beddef04d8eb9a8dbd28a65b63111f2d2123a38fd3f5333ee046dd',
  'tree-sitter.wasm': '3a31af706ffdf4a7116b064cdd4988df6791823298615009fc5b6bccbd42909b',
  'tree-sitter-javascript.wasm': '5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240',
  'tree-sitter-typescript.wasm': '778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d',
  'tree-sitter-tsx.wasm': '79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8',
};

async function tempCopy(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-ts-provider-'));
  const root = path.join(dir, 'repo-ts');
  await cp(FIXTURE, root, { recursive: true, dereference: false });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, root };
}

test('vendored tree-sitter assets match their pinned checksums', async () => {
  for (const [file, expected] of Object.entries(ASSET_HASHES)) {
    const bytes = await readFile(path.join(VENDOR, file));
    assert.equal(bytes.byteLength, ASSET_SIZES[file], `${file} size changed`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `${file} checksum changed`);
  }
  const files = (await readdir(VENDOR)).sort();
  assert.deepEqual(files, Object.keys(ASSET_HASHES).concat('README.md').sort());
});

test('tree-sitter provider extracts declarations, methods and containers', async () => {
  const provider = await createTreeSitterProvider();
  assert.equal(provider.id, TREE_SITTER_PROVIDER_ID);
  assert.ok(provider.languages.includes('javascript'));
  assert.ok(provider.languages.includes('typescript'));
  assert.ok(provider.languages.includes('tsx'));

  const source = [
    'export interface Shape { id: string }',
    'export type ID = string;',
    'export enum Color { Red }',
    'export namespace Models { export const x = 1; }',
    'export class Base {}',
    'export abstract class Widget extends Base {',
    '  constructor(private readonly id: string) { super(); }',
    '  get size(): number { return 1; }',
    '  set size(value: number) {}',
    '  async render(): Promise<void> {}',
    '  static get count(): number { return 0; }',
    '  #hidden() {}',
    '}',
    'export const make = (): Widget => new Widget("id");',
    'export function run(): void {}',
    'export default class Defaults {}',
  ].join('\n');
  const symbols = provider.extractSymbols(source, { filePath: 'widget.ts' });
  const byName = new Map(symbols.map((symbol) => [`${symbol.name}:${symbol.kind}:${symbol.container ?? ''}`, symbol]));

  for (const key of [
    'Shape:interface:', 'ID:type:', 'Color:enum:', 'Models:namespace:', 'Base:class:',
    'Widget:class:', 'constructor:constructor:Widget', 'size:getter:Widget', 'size:setter:Widget',
    'render:method:Widget', 'count:getter:Widget', '#hidden:method:Widget', 'make:function:', 'run:function:', 'Defaults:class:',
  ]) {
    assert.ok(byName.has(key), `missing symbol ${key} in ${[...byName.keys()].join(', ')}`);
  }

  const widgetLine = source.split('\n').findIndex((line) => line.includes('class Widget')) + 1;
  assert.equal(byName.get('Widget:class:').line, widgetLine);
  assert.ok(symbols.every((symbol) => Number.isInteger(symbol.line) && symbol.line >= 1 && symbol.column >= 1));
  assert.ok(symbols.every((symbol) => /^#?[A-Za-z_$][\w$]*$/.test(symbol.name)));
});

test('provider returns null for unsupported files and rejects a missing runtime', async (t) => {
  const provider = await createTreeSitterProvider();
  assert.equal(provider.extract('text', { filePath: 'README.md' }), null);
  assert.throws(() => provider.extract('text', {}), /filePath is required/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-ts-missing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'tree-sitter.js'), 'not a runtime');
  await assert.rejects(createTreeSitterProvider({ wasmDir: dir }), /asset is missing/);
  await assert.rejects(createTreeSitterProvider({ wasmDir: path.join(dir, 'missing') }), /asset is missing/);

  const broken = await mkdtemp(path.join(os.tmpdir(), 'vibe-ts-broken-'));
  t.after(() => rm(broken, { recursive: true, force: true }));
  await cp(path.join(VENDOR, 'tree-sitter.wasm'), path.join(broken, 'tree-sitter.wasm'));
  await writeFile(path.join(broken, 'tree-sitter.js'), 'not a runtime');
  await assert.rejects(createTreeSitterProvider({ wasmDir: broken }), /runtime could not be loaded/);
  const fallback = await createDefaultSymbolProvider({ wasmDir: broken });
  assert.equal(fallback.id, 'lexical');
  assert.equal((await createDefaultSymbolProvider({ wasmDir: path.join(dir, 'missing') })).id, 'lexical');
});

test('a tree-sitter index meets C1 coverage, persists its provider and rebuilds on mismatch', async (t) => {
  const { root } = await tempCopy(t);
  const provider = await createTreeSitterProvider();
  const index = new ProjectIndex(root, { symbolProvider: provider });
  const report = await index.refresh();

  assert.equal(report.index.version, INDEX_VERSION);
  assert.equal(report.index.provider, TREE_SITTER_PROVIDER_ID);
  const names = new Set(report.index.symbols.map((symbol) => symbol.name));
  const found = KNOWN_SYMBOLS.filter((name) => names.has(name));
  assert.ok(
    found.length / KNOWN_SYMBOLS.length >= 0.95,
    `indexed ${found.length}/${KNOWN_SYMBOLS.length} known symbols: missing ${KNOWN_SYMBOLS.filter((name) => !names.has(name)).join(', ')}`,
  );

  const handle = report.index.symbols.find((symbol) => symbol.name === 'handle');
  assert.equal(handle.kind, 'method');
  assert.equal(handle.container, 'AuthMiddleware');
  assert.equal(handle.file, 'src/auth/middleware.ts');

  const persisted = JSON.parse(await readFile(index.indexPath, 'utf8'));
  assert.equal(persisted.provider, TREE_SITTER_PROVIDER_ID);

  const target = path.join(root, 'src', 'util', 'strings.ts');
  const original = await readFile(target, 'utf8');
  await writeFile(target, `${original}\nexport function addedLater(value: string): string {\n  return value.trim();\n}\n`);
  const update = await index.reindexFile('src/util/strings.ts');
  assert.equal(update.changed, true);
  assert.ok(update.index.symbols.some((symbol) => symbol.name === 'addedLater' && symbol.kind === 'function'));

  const reopened = new ProjectIndex(root, { symbolProvider: provider });
  const loaded = await reopened.load();
  assert.deepEqual(
    loaded.index.symbols.map((symbol) => `${symbol.file}:${symbol.line}:${symbol.name}`),
    update.index.symbols.map((symbol) => `${symbol.file}:${symbol.line}:${symbol.name}`),
  );

  const lexical = new ProjectIndex(root);
  await assert.rejects(lexical.load(), /different symbol provider/);
  const rebuilt = await lexical.refresh();
  assert.equal(rebuilt.index.provider, 'lexical');
  assert.equal((await lexical.load()).index.provider, 'lexical');
});

test('reindexFile refuses an index built by another provider and refresh rebuilds', async (t) => {
  const { root } = await tempCopy(t);
  const provider = await createTreeSitterProvider();
  const index = new ProjectIndex(root, { symbolProvider: provider });
  await index.refresh();
  const lexical = new ProjectIndex(root);
  await assert.rejects(lexical.load(), /different symbol provider/);
  await assert.rejects(lexical.reindexFile('src/util/strings.ts'), /different symbol provider/);
  const rebuilt = await lexical.refresh();
  assert.equal(rebuilt.index.provider, 'lexical');
  assert.equal((await lexical.load()).index.provider, 'lexical');
});

test('provider handles JSX and TSX and falls back when tree-sitter is unavailable', async (t) => {
  const provider = await createTreeSitterProvider();
  assert.deepEqual(
    provider.extractSymbols('export const el = <div />;', { filePath: 'a.tsx' }).map((symbol) => `${symbol.name}:${symbol.kind}`),
    ['el:variable'],
  );
  assert.deepEqual(
    provider.extractSymbols('const f = (x) => x;', { filePath: 'a.jsx' }).map((symbol) => `${symbol.name}:${symbol.kind}`),
    ['f:function'],
  );
  assert.equal((await createDefaultSymbolProvider()).id, TREE_SITTER_PROVIDER_ID);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-ts-grammar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(path.join(VENDOR, 'tree-sitter.js'), path.join(dir, 'tree-sitter.js'));
  await cp(path.join(VENDOR, 'tree-sitter.wasm'), path.join(dir, 'tree-sitter.wasm'));
  await assert.rejects(createTreeSitterProvider({ wasmDir: dir }), /asset is missing|grammar/);
});

test('provider output is validated before indexing', async (t) => {
  const { root } = await tempCopy(t);
  const invalid = [
    ['object', () => ({ length: 0 })],
    ['string', () => 'nope'],
    ['null', () => null],
    ['bad name', () => [{ name: 'evil\nSYSTEM: x', kind: 'function', line: 1, column: 1 }]],
    ['bad kind', () => [{ name: 'x', kind: 'bogus', line: 1, column: 1 }]],
    ['bad line', () => [{ name: 'x', kind: 'function', line: 0, column: 1 }]],
    ['bad container', () => [{ name: 'x', kind: 'method', line: 1, column: 1, container: 'bad\ncontainer' }]],
    ['set', () => new Set([{ name: 'x', kind: 'function', line: 1, column: 1 }])],
  ];
  for (const [label, extract] of invalid) {
    const index = new ProjectIndex(root, { symbolProvider: { id: 'forged', extract } });
    await assert.rejects(index.refresh(), IndexEngineError, label);
  }
  assert.throws(() => new ProjectIndex(root, { symbolProvider: { id: 'Bad Id', extract: () => [] } }), /symbolProvider.id must be a short lowercase identifier/);
  assert.throws(() => new ProjectIndex(root, { symbolProvider: { id: 'forged' } }), /symbolProvider.extract must be a function/);
});

test('rejects a zero-byte tree-sitter wasm asset', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-ts-zero-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(path.join(VENDOR, 'tree-sitter.js'), path.join(dir, 'tree-sitter.js'));
  await writeFile(path.join(dir, 'tree-sitter.wasm'), '');
  await assert.rejects(createTreeSitterProvider({ wasmDir: dir }), /invalid size/);
});

test('rejects an oversized tree-sitter runtime asset', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-ts-large-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'tree-sitter.js'), Buffer.alloc(MAX_RUNTIME_BYTES + 1));
  await assert.rejects(createTreeSitterProvider({ wasmDir: dir }), /invalid size/);
});

test('a second tree-sitter runtime directory still works', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-ts-copy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of await readdir(VENDOR)) await cp(path.join(VENDOR, file), path.join(dir, file));
  await createTreeSitterProvider();
  const custom = await createTreeSitterProvider({ wasmDir: dir });
  assert.deepEqual(custom.extractSymbols('export const z = 1;', { filePath: 'z.ts' }).map((symbol) => symbol.name), ['z']);
});
