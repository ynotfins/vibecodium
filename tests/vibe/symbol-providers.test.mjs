import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  IndexEngineError,
  ProjectIndex,
} from '../../src/stable/index-engine/index-engine.mjs';
import {
  MAX_SYMBOL_SOURCE_BYTES,
  SymbolProviderError,
  TREE_SITTER_VENDOR_DIR,
  createRegexSymbolProvider,
  createTreeSitterSymbolProvider,
  grammarForFile,
  validateSymbolProvider,
} from '../../src/stable/index-engine/symbol-providers.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'repo-ts');

const KNOWN_SYMBOLS = [
  'AuthContext',
  'Next',
  'AuthMiddleware',
  'handle',
  'requireUser',
  'authHeader',
  'SessionRecord',
  'MAX_SESSIONS',
  'SessionStore',
  'get',
  'put',
  'size',
  'createSession',
  'defaultPort',
  'ServerOptions',
  'createServer',
  'HttpServer',
  'start',
  'getUser',
  'userRoute',
  'slugify',
  'emptyString',
  'counter',
  'nextCounter',
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function tempCopy(t) {
  const dir = await tempDir(t, 'vibe-tree-sitter-');
  const root = path.join(dir, 'repo-ts');
  await cp(FIXTURE, root, { recursive: true, dereference: false });
  return { dir, root };
}

test('vendored tree-sitter files match SHA256SUMS and carry MIT licenses', async () => {
  const entries = (await readFile(path.join(TREE_SITTER_VENDOR_DIR, 'SHA256SUMS'), 'utf8'))
    .trim()
    .split(/\r?\n/);
  assert.ok(entries.length >= 8);
  for (const line of entries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    assert.ok(match, `malformed checksum line: ${line}`);
    const [, expected, name] = match;
    const actual = sha256(await readFile(path.join(TREE_SITTER_VENDOR_DIR, name)));
    assert.equal(actual, expected, `${name} does not match SHA256SUMS`);
  }
  for (const name of ['LICENSE-web-tree-sitter', 'LICENSE-tree-sitter-javascript', 'LICENSE-tree-sitter-typescript']) {
    const text = await readFile(path.join(TREE_SITTER_VENDOR_DIR, name), 'utf8');
    assert.match(text, /MIT License/);
  }
  const listed = new Set(entries.map((line) => line.slice(66)));
  const present = (await readdir(TREE_SITTER_VENDOR_DIR))
    .filter((name) => !['README.md', 'SHA256SUMS'].includes(name));
  for (const name of present) assert.ok(listed.has(name), `${name} is not in SHA256SUMS`);
});

test('grammar selection maps source extensions to the vendored grammars', () => {
  assert.equal(grammarForFile('src/a.js'), 'javascript');
  assert.equal(grammarForFile('src/a.jsx'), 'javascript');
  assert.equal(grammarForFile('src/a.mjs'), 'javascript');
  assert.equal(grammarForFile('src/a.ts'), 'typescript');
  assert.equal(grammarForFile('src/a.mts'), 'typescript');
  assert.equal(grammarForFile('src/a.tsx'), 'tsx');
  assert.equal(grammarForFile('src/a.py'), null);
  assert.throws(() => grammarForFile(''), SymbolProviderError);
  assert.throws(() => grammarForFile('src/a\0.ts'), SymbolProviderError);
});

test('regex provider keeps the existing extractor behind the provider interface', async () => {
  const provider = createRegexSymbolProvider();
  assert.equal(validateSymbolProvider(provider), provider);
  assert.equal(provider.supports('src/a.ts'), true);
  const symbols = await provider.extractSymbols('export function alpha(): number { return 1; }', { maxSymbols: 10 });
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.kind]), [['alpha', 'function']]);
  await assert.rejects(provider.extractSymbols('x'.repeat(MAX_SYMBOL_SOURCE_BYTES + 1)), SymbolProviderError);
});

test('tree-sitter provider extracts TypeScript declarations, members and containers', async () => {
  const provider = createTreeSitterSymbolProvider();
  const source = [
    'export interface Shape { area: number; scale(by: number): void }',
    'export type Point = { x: number; y: number };',
    'export enum Color { Red, Green }',
    'export namespace Geometry { export const unit = 1; }',
    'export abstract class Base {',
    '  #secret = 1;',
    '  static count = 0;',
    '  constructor(private readonly name: string) {}',
    '  get label(): string { return this.name; }',
    '  set label(value: string) {}',
    '  async run<U>(value: U): Promise<U> { return value; }',
    '}',
    'export function helper(value: number): number { return value; }',
    'export const arrow = (value: number) => value;',
    'export const plain = 42;',
    'export default class Defaulted {}',
    'function* stream() { yield 1; }',
  ].join('\n');

  const symbols = await provider.extractSymbols(source, { filePath: 'src/example.ts' });
  const byName = new Map(symbols.map((symbol) => [`${symbol.name}:${symbol.kind}:${symbol.container ?? ''}`, symbol]));

  assert.equal(byName.get('Shape:interface:')?.line, 1);
  assert.equal(byName.get('area:variable:Shape')?.kind, 'variable');
  assert.equal(byName.get('scale:method:Shape')?.kind, 'method');
  assert.equal(byName.get('Point:type:')?.kind, 'type');
  assert.equal(byName.get('x:variable:Point')?.kind, 'variable');
  assert.equal(byName.get('Color:enum:')?.kind, 'enum');
  assert.equal(byName.get('Geometry:namespace:')?.kind, 'namespace');
  assert.equal(byName.get('unit:variable:Geometry')?.kind, 'variable');
  assert.equal(byName.get('Base:class:')?.kind, 'class');
  assert.equal(byName.get('#secret:variable:Base')?.kind, 'variable');
  assert.equal(byName.get('count:variable:Base')?.kind, 'variable');
  assert.equal(byName.get('constructor:constructor:Base')?.kind, 'constructor');
  assert.equal(byName.get('label:getter:Base')?.kind, 'getter');
  assert.equal(byName.get('label:setter:Base')?.kind, 'setter');
  assert.equal(byName.get('run:method:Base')?.kind, 'method');
  assert.equal(byName.get('helper:function:')?.kind, 'function');
  assert.equal(byName.get('arrow:function:')?.kind, 'function');
  assert.equal(byName.get('plain:variable:')?.kind, 'variable');
  assert.equal(byName.get('Defaulted:class:')?.kind, 'class');
  assert.equal(byName.get('stream:function:')?.kind, 'function');
  assert.equal(byName.get('area:variable:Shape')?.line, 1);
  assert.ok(byName.get('area:variable:Shape').column > 0);
});

test('tree-sitter provider handles JavaScript, TSX and non-ASCII columns', async () => {
  const provider = createTreeSitterSymbolProvider();
  const js = await provider.extractSymbols('export class A { run() {} }\nexport function f() {}\n', { filePath: 'src/a.js' });
  assert.deepEqual(js.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.container ?? ''}`), [
    'class:A:', 'method:run:A', 'function:f:',
  ]);

  const tsx = await provider.extractSymbols('export function App() { return <div />; }\n', { filePath: 'src/App.tsx' });
  assert.deepEqual(tsx.map((symbol) => `${symbol.kind}:${symbol.name}`), ['function:App']);

  const line = 'const café = 1; export function après() {}';
  const source = `${line}\n`;
  const unicode = await provider.extractSymbols(source, { filePath: 'src/u.ts' });
  const found = unicode.find((symbol) => symbol.name === 'après');
  assert.equal(found, undefined, 'non-ASCII identifiers stay out of the index, like the regex extractor');
  const ascii = await provider.extractSymbols('const café = 1; export function after() {}\n', { filePath: 'src/u.ts' });
  const after = ascii.find((symbol) => symbol.name === 'after');
  assert.equal(after.column, 'const café = 1; export function after() {}'.indexOf('after') + 1);
});

test('tree-sitter provider skips function-local declarations and recovers from syntax errors', async () => {
  const provider = createTreeSitterSymbolProvider();
  const source = [
    'export function outer() {',
    '  const inner = 1;',
    '  const fn = () => 2;',
    '  function nested() {}',
    '}',
    'export class Box {',
    '  method() {',
    '    const hidden = 3;',
    '  }',
    '}',
  ].join('\n');
  const symbols = await provider.extractSymbols(source, { filePath: 'src/local.ts' });
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['outer', 'Box', 'method']);

  const broken = await provider.extractSymbols('export function broken( {\n', { filePath: 'src/broken.ts' });
  assert.ok(Array.isArray(broken));
  assert.ok(broken.every((symbol) => symbol.name === 'broken'));
});

test('tree-sitter provider is deterministic and respects maxSymbols', async () => {
  const provider = createTreeSitterSymbolProvider();
  const source = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';
  const first = await provider.extractSymbols(source, { filePath: 'src/x.ts', maxSymbols: 2 });
  const second = await provider.extractSymbols(source, { filePath: 'src/x.ts', maxSymbols: 2 });
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  await assert.rejects(provider.extractSymbols(source, { filePath: 'src/x.ts', maxSymbols: 0 }), SymbolProviderError);
  await assert.rejects(provider.extractSymbols(source, { filePath: 'src/x.py' }), SymbolProviderError);
  await assert.rejects(provider.extractSymbols(42, { filePath: 'src/x.ts' }), SymbolProviderError);
});

test('tree-sitter provider reports missing runtime or grammar assets clearly', async (t) => {
  const empty = await tempDir(t, 'vibe-tree-sitter-empty-');
  const missingRuntime = createTreeSitterSymbolProvider({ wasmDir: empty });
  await assert.rejects(
    missingRuntime.extractSymbols('export const a = 1;\n', { filePath: 'src/x.ts' }),
    (error) => error instanceof SymbolProviderError && /runtime is unavailable/.test(error.message),
  );

  const runtimeOnly = await tempDir(t, 'vibe-tree-sitter-runtime-');
  for (const name of ['web-tree-sitter.js', 'web-tree-sitter.wasm', 'package.json']) {
    await cp(path.join(TREE_SITTER_VENDOR_DIR, name), path.join(runtimeOnly, name));
  }
  const missingGrammar = createTreeSitterSymbolProvider({ wasmDir: runtimeOnly });
  await assert.rejects(
    missingGrammar.extractSymbols('export const a = 1;\n', { filePath: 'src/x.ts' }),
    (error) => error instanceof SymbolProviderError && /grammar typescript is unavailable/.test(error.message),
  );
});

test('provider concurrency shares the runtime and grammar loads', async () => {
  const provider = createTreeSitterSymbolProvider();
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    provider.extractSymbols(`export function f${index}() {}\n`, { filePath: `src/f${index}.ts` })));
  assert.deepEqual(results.map((symbols) => symbols[0].name), ['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
});

test('ProjectIndex accepts a tree-sitter provider and indexes at least 95% of the fixture symbols', async (t) => {
  const { dir, root } = await tempCopy(t);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = createTreeSitterSymbolProvider();
  const index = new ProjectIndex(root, { symbolProvider: provider });
  const report = await index.refresh();
  assert.equal(report.stats.files, 5);
  assert.equal(report.stats.changed, 5);
  const names = new Set(report.index.symbols.map((symbol) => symbol.name));
  const missing = KNOWN_SYMBOLS.filter((name) => !names.has(name));
  assert.equal(missing.length, 0, `missing symbols: ${missing.join(', ')}`);
  const found = KNOWN_SYMBOLS.length - missing.length;
  assert.ok(found / KNOWN_SYMBOLS.length >= 0.95, `indexed ${found}/${KNOWN_SYMBOLS.length} fixture symbols`);

  const handle = report.index.symbols.find((symbol) => symbol.name === 'handle');
  assert.equal(handle.kind, 'method');
  assert.equal(handle.container, 'AuthMiddleware');
  assert.equal(handle.file, 'src/auth/middleware.ts');
  const size = report.index.symbols.find((symbol) => symbol.name === 'size' && symbol.container === 'SessionStore');
  assert.equal(size.kind, 'getter');
  const localId = report.index.symbols.find((symbol) =>
    symbol.name === 'id' && symbol.file === 'src/auth/session.ts' && symbol.container === undefined);
  assert.equal(localId, undefined, 'function-local declarations are not indexed');

  const target = path.join(root, 'src', 'util', 'strings.ts');
  const original = await readFile(target, 'utf8');
  await writeFile(target, `${original}\nexport function addedLater(value: string): string {\n  return value.trim();\n}\n`);
  const started = process.hrtime.bigint();
  const update = await index.reindexFile('src/util/strings.ts');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(update.changed, true);
  assert.ok(elapsedMs < 2000, `reindex took ${elapsedMs.toFixed(1)} ms`);
  assert.ok(update.index.symbols.some((symbol) => symbol.name === 'addedLater'));
});

test('ProjectIndex indexes provider output instead of falling back to the regex extractor', async (t) => {
  const root = await tempDir(t, 'vibe-tree-sitter-provider-used-');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export function regexVisible() {}\n');

  const provider = {
    id: 'synthetic',
    async extractSymbols() {
      return [{ name: 'providerOnly', kind: 'function', line: 1, column: 1 }];
    },
  };
  const index = new ProjectIndex(root, { symbolProvider: provider, persist: false });
  const report = await index.refresh();
  assert.deepEqual(report.index.symbols.map((symbol) => symbol.name), ['providerOnly']);
});

test('ProjectIndex re-extracts unchanged files when a custom provider is configured', async (t) => {
  const root = await tempDir(t, 'vibe-tree-sitter-provider-reuse-');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');

  let calls = 0;
  const provider = {
    id: 'counter',
    async extractSymbols() {
      calls += 1;
      return [{ name: 'a', kind: 'variable', line: 1, column: 1 }];
    },
  };
  const index = new ProjectIndex(root, { symbolProvider: provider, persist: false });
  await index.refresh();
  assert.equal(calls, 1);
  await index.refresh();
  assert.equal(calls, 2, 'an unchanged file must be re-extracted for a custom provider');
});

test('ProjectIndex rejects malformed providers and malformed provider output', async (t) => {
  const root = await tempDir(t, 'vibe-tree-sitter-bad-');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');

  assert.throws(() => new ProjectIndex(root, { symbolProvider: null }), IndexEngineError);
  assert.throws(() => new ProjectIndex(root, { symbolProvider: { id: '', extractSymbols() {} } }), IndexEngineError);
  assert.throws(() => new ProjectIndex(root, { symbolProvider: { id: 'bad' } }), IndexEngineError);

  const cases = [
    [{ id: 'bad', async extractSymbols() { return {}; } }, /non-array/],
    [{ id: 'bad', async extractSymbols() { return [{ name: 'a', kind: 'bogus', line: 1, column: 1 }]; } }, /unknown symbol kind/],
    [{ id: 'bad', async extractSymbols() { return [{ name: 'bad name', kind: 'function', line: 1, column: 1 }]; } }, /invalid symbol name/],
    [{ id: 'bad', async extractSymbols() { return [{ name: 'a', kind: 'function', line: 0, column: 1 }]; } }, /invalid symbol line/],
    [{ id: 'bad', async extractSymbols() { return [{ name: 'a', kind: 'function', line: 1, column: 1, extra: true }]; } }, /unknown symbol field/],
    [{ id: 'bad', async extractSymbols() { return [{ name: 'a', kind: 'function', line: 1, column: 1, container: 'bad name' }]; } }, /invalid symbol container/],
  ];
  for (const [symbolProvider, expected] of cases) {
    const index = new ProjectIndex(root, { symbolProvider, persist: false });
    await assert.rejects(index.refresh(), expected);
  }
});
