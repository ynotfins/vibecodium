import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INDEX_VERSION,
  IndexEngineError,
  ProjectIndex,
  extractSymbols,
} from '../../src/stable/index-engine/index-engine.mjs';

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

async function tempCopy() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-index-'));
  const root = path.join(dir, 'repo-ts');
  await cp(FIXTURE, root, { recursive: true, dereference: false });
  return { dir, root };
}

function indexedNames(report) {
  return new Set(report.index.symbols.map((symbol) => symbol.name));
}

test('indexes at least 95% of the known fixture symbols', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  const report = await index.refresh();

  assert.equal(report.index.version, INDEX_VERSION);
  assert.ok(report.stats.files >= 5);
  const names = indexedNames(report);
  const found = KNOWN_SYMBOLS.filter((name) => names.has(name));
  const ratio = found.length / KNOWN_SYMBOLS.length;
  assert.ok(
    ratio >= 0.95,
    `indexed ${found.length}/${KNOWN_SYMBOLS.length} known symbols: missing ${KNOWN_SYMBOLS.filter((n) => !names.has(n)).join(', ')}`,
  );

  const handle = report.index.symbols.find((s) => s.name === 'handle');
  assert.equal(handle.kind, 'method');
  assert.equal(handle.file, 'src/auth/middleware.ts');
  assert.equal(handle.container, 'AuthMiddleware');
  assert.ok(handle.line > 0 && handle.column > 0);

  const requireUser = report.index.symbols.find((s) => s.name === 'requireUser');
  assert.equal(requireUser.kind, 'function');
  assert.equal(requireUser.file, 'src/auth/middleware.ts');

  const size = report.index.symbols.find((s) => s.name === 'size' && s.container === 'SessionStore');
  assert.equal(size.kind, 'getter');
  assert.equal(size.file, 'src/auth/session.ts');
});

test('builds a case-insensitive token index over fixture text', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  await index.refresh();

  const hashHits = index.searchText('CREATEHASH');
  assert.equal(hashHits[0].file, 'src/auth/session.ts');
  assert.ok(hashHits[0].lines.length >= 1);

  const slugHits = index.searchText('slugify');
  assert.equal(slugHits[0].file, 'src/util/strings.ts');

  assert.deepEqual(index.searchText('not-in-this-repository-xyz'), []);
  assert.throws(() => index.searchText(''), IndexEngineError);
  assert.throws(() => index.searchText('x'.repeat(1000)), IndexEngineError);
});

test('reindexes one changed file in under 2 seconds and keeps other files intact', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  const first = await index.refresh();
  const before = new Map(Object.entries(first.index.files).map(([file, entry]) => [file, entry.hash]));

  const target = path.join(root, 'src', 'util', 'strings.ts');
  const original = await readFile(target, 'utf8');
  await writeFile(target, `${original}\nexport function addedLater(value: string): string {\n  return value.trim();\n}\n`);

  const started = process.hrtime.bigint();
  const update = await index.reindexFile('src/util/strings.ts');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(update.changed, true);
  assert.ok(elapsedMs < 2000, `reindex took ${elapsedMs.toFixed(1)} ms`);
  assert.ok(indexedNames(update).has('addedLater'));

  const after = update.index.files;
  for (const [file, hash] of before) {
    if (file === 'src/util/strings.ts') {
      assert.notEqual(after[file].hash, hash);
    } else {
      assert.equal(after[file].hash, hash);
    }
  }
});

test('an unchanged file is a no-op', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  await index.refresh();
  const update = await index.reindexFile('src/auth/session.ts');
  assert.equal(update.changed, false);
});

test('persists a valid index and reloads it', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await new ProjectIndex(root).refresh();
  const reopened = new ProjectIndex(root);
  const loaded = await reopened.load();
  assert.equal(loaded.index.version, INDEX_VERSION);
  assert.equal(loaded.index.symbols.length, first.index.symbols.length);
  assert.deepEqual(
    loaded.index.symbols.map((s) => `${s.file}:${s.line}:${s.name}`),
    first.index.symbols.map((s) => `${s.file}:${s.line}:${s.name}`),
  );
});

test('ignores skipped directories, symlinks and oversized files', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(root, '..', 'outside.ts'), 'export const leaked = 1;\n');
  let linked = false;
  try {
    await symlink(path.join(root, '..', 'outside.ts'), path.join(root, 'src', 'linked.ts'));
    linked = true;
  } catch {
    linked = false;
  }
  await mkdir(path.join(root, 'src', 'node_modules'), { recursive: true });
  await writeFile(path.join(root, 'src', 'node_modules', 'inside.ts'), 'export const notHere = 1;\n');
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'also.ts'), 'export const alsoNotHere = 1;\n');

  const index = new ProjectIndex(root, { maxFileBytes: 64 });
  const report = await index.refresh();
  assert.ok(report.stats.skipped.oversized >= 5);
  assert.equal(report.stats.symbols, 0);
  if (linked) assert.ok(report.stats.skipped.symlinks >= 1);
  assert.ok(!indexedNames(report).has('leaked'));
  assert.ok(!indexedNames(report).has('notHere'));
  assert.ok(!indexedNames(report).has('alsoNotHere'));
});

test('rejects path traversal and absolute paths', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  await index.refresh();
  await assert.rejects(index.reindexFile('../outside.ts'), IndexEngineError);
  await assert.rejects(index.reindexFile('C:\\Windows\\win.ini'), IndexEngineError);
  await assert.rejects(index.reindexFile('/etc/passwd'), IndexEngineError);
  await assert.rejects(index.reindexFile(''), IndexEngineError);
});

test('does not index string literal or comment contents as text', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  await index.refresh();
  assert.deepEqual(index.searchText('unauthenticated'), []);
  assert.equal(index.searchText('authheader')[0].file, 'src/auth/middleware.ts');
});

test('does not create an index under a symlinked ancestor', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outside = path.join(dir, 'outside-vibe');
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, path.join(root, '.vibe'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('directory symlinks are not available on this platform');
    return;
  }

  await assert.rejects(new ProjectIndex(root).refresh(), IndexEngineError);
  await assert.rejects(access(path.join(outside, 'index')));
  await assert.rejects(readFile(path.join(outside, 'index', 'index.json'), 'utf8'));
});

test('prototype-named queries do not crash the text index', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  await index.refresh();
  for (const query of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const hits = index.searchText(query);
    assert.ok(Array.isArray(hits), query);
  }
  assert.ok(index.searchText('constructor').length > 0);
  assert.deepEqual(index.searchText('__proto__'), []);
});

test('rejects inconsistent or incomplete index metadata', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  await index.refresh();
  const parsed = JSON.parse(await readFile(index.indexPath, 'utf8'));
  parsed.fileCount = 999;
  await writeFile(index.indexPath, JSON.stringify(parsed));
  await assert.rejects(new ProjectIndex(root).load(), IndexEngineError);

  delete parsed.fileCount;
  parsed.fileCount = Object.keys(parsed.files).length;
  delete parsed.text;
  await writeFile(index.indexPath, JSON.stringify(parsed));
  await assert.rejects(new ProjectIndex(root).load(), IndexEngineError);
});

test('refuses an index directory symlinked outside the project root', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outside = path.join(dir, 'outside-index');
  await mkdir(outside, { recursive: true });
  await mkdir(path.join(root, '.vibe'), { recursive: true });
  try {
    await symlink(outside, path.join(root, '.vibe', 'index'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('directory symlinks are not available on this platform');
    return;
  }

  const index = new ProjectIndex(root);
  await assert.rejects(index.refresh(), IndexEngineError);
  await assert.rejects(readFile(path.join(outside, 'index.json'), 'utf8'));
});

test('excludes regex literal bodies from the identifier index', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(root, 'src', 'regex.ts'), "if (ok) /supersecretvalue/.test(value);\n");
  const index = new ProjectIndex(root);
  await index.refresh();
  assert.deepEqual(index.searchText('supersecretvalue'), []);
});

test('masks regex literals longer than the scan bound', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const longBody = 'a'.repeat(5000);
  await writeFile(path.join(root, 'src', 'long.ts'), `if (ok) /${longBody}-supersecretvalue-x/.test(value);\n`);
  const index = new ProjectIndex(root);
  await index.refresh();
  assert.deepEqual(index.searchText('supersecretvalue'), []);
});

test('division after a close paren does not hide identifiers', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(
    path.join(root, 'src', 'division.ts'),
    'const ratio = (counter) / divisor;\nconst other = (counter) / 2 + denominator;\nconst postInc = counter++ / postIncDivisor;\nconst postDec = counter-- / postDecDivisor;\n',
  );
  const index = new ProjectIndex(root);
  await index.refresh();
  assert.equal(index.searchText('ratio')[0].file, 'src/division.ts');
  assert.equal(index.searchText('divisor')[0].file, 'src/division.ts');
  assert.equal(index.searchText('other')[0].file, 'src/division.ts');
  assert.equal(index.searchText('denominator')[0].file, 'src/division.ts');
  assert.equal(index.searchText('postIncDivisor')[0].file, 'src/division.ts');
  assert.equal(index.searchText('postDecDivisor')[0].file, 'src/division.ts');
  assert.deepEqual(index.searchText('supersecretvalue'), []);
});

test('nested parens followed by division stay linear', () => {
  const depth = 50_000;
  const source = `${'('.repeat(depth)}base${') / divisor'.repeat(depth)};\nconst afterParens = base / divisor;\n`;
  const start = performance.now();
  const symbols = extractSymbols(source);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2000, `extraction took ${elapsed.toFixed(0)}ms`);
  assert.ok(symbols.some((symbol) => symbol.name === 'afterParens'));
});

test('control-flow regex context survives comments and for await', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(root, 'src', 'comments.ts'), [
    'if (ok) /* c */ /supersecretvalue/.test(x);',
    'if /* c */ (ok) /supersecretvalue/.test(x);',
    'if (ok) // c',
    '/supersecretvalue/.test(x);',
    'while /* c */ (ok) /supersecretvalue/.test(x);',
    'for /* c */ (const x of y) /supersecretvalue/.test(x);',
    'for await (const x of y) /supersecretvalue/.test(x);',
    'const keep = 1;',
    '',
  ].join('\n'));
  const index = new ProjectIndex(root);
  await index.refresh();
  assert.deepEqual(index.searchText('supersecretvalue'), []);
  assert.equal(index.searchText('keep')[0].file, 'src/comments.ts');
});

test('a regex after a division operator is still masked', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(root, 'src', 'divisionRegex.ts'),
    'const x = a / /supersecretvalue/.source;\nconst after = x / divisor;\n');
  const index = new ProjectIndex(root);
  await index.refresh();
  assert.deepEqual(index.searchText('supersecretvalue'), []);
  assert.equal(index.searchText('after')[0].file, 'src/divisionRegex.ts');
  assert.equal(index.searchText('divisor')[0].file, 'src/divisionRegex.ts');
});

test('member calls named like control words do not hide division', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(root, 'src', 'member.ts'), [
    'const a = obj.if(ok) / ifDivisor;',
    'const b = obj?.while(ok) / whileDivisor;',
    'const c = obj.for(ok) / forDivisor;',
    'const d = obj.with(ok) / withDivisor;',
    '',
  ].join('\n'));
  const index = new ProjectIndex(root);
  await index.refresh();
  for (const name of ['ifDivisor', 'whileDivisor', 'forDivisor', 'withDivisor']) {
    assert.equal(index.searchText(name)[0]?.file, 'src/member.ts', name);
  }
});

test('rejects a persisted index above the total token cap', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const files = {};
  for (let fileIndex = 0; fileIndex < 501; fileIndex += 1) {
    const tokens = {};
    for (let tokenIndex = 0; tokenIndex < 4000; tokenIndex += 1) tokens[`t${tokenIndex}`] = [1];
    files[`src/f${fileIndex}.ts`] = { hash: 'a'.repeat(64), bytes: 0, symbols: [], tokens };
  }
  const index = new ProjectIndex(root);
  await mkdir(path.dirname(index.indexPath), { recursive: true });
  const value = {
    version: INDEX_VERSION,
    files,
    text: { tokenCount: 2_004_000, fileCount: 501 },
    fileCount: 501,
  };
  await writeFile(index.indexPath, JSON.stringify(value));
  await assert.rejects(new ProjectIndex(root).load(), IndexEngineError);
});

test('rejects a legacy or malformed derived symbol array', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  await index.refresh();
  const parsed = JSON.parse(await readFile(index.indexPath, 'utf8'));
  parsed.symbols = [null, 42, { kind: 'bogus' }];
  await writeFile(index.indexPath, JSON.stringify(parsed));
  await assert.rejects(new ProjectIndex(root).load(), IndexEngineError);
});

test('rejects a malformed persisted index instead of trusting it', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  await index.refresh();
  const parsed = JSON.parse(await readFile(index.indexPath, 'utf8'));
  parsed.files['src/auth/session.ts'].hash = 'not-a-hash';
  await writeFile(index.indexPath, JSON.stringify(parsed));

  await assert.rejects(new ProjectIndex(root).load(), IndexEngineError);
});

test('rejects unsafe index options', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.throws(() => new ProjectIndex(root, { indexFile: '../escape.json' }), IndexEngineError);
  assert.throws(() => new ProjectIndex(root, { indexFile: 'notes.txt' }), IndexEngineError);
  assert.throws(() => new ProjectIndex(root, { indexDir: '../outside' }), IndexEngineError);
  assert.throws(() => new ProjectIndex(root, { maxFiles: 0 }), IndexEngineError);
  assert.throws(() => new ProjectIndex(root, { maxDirs: 0 }), IndexEngineError);
  assert.throws(() => new ProjectIndex(root, { indexDir: 'C:foo' }), IndexEngineError);
  assert.throws(() => new ProjectIndex(root, { indexFile: 'CON.json' }), IndexEngineError);
  assert.throws(() => new ProjectIndex(root, { indexDir: 'foo/../bar' }), IndexEngineError);
});

test('handles a UTF-8 BOM without losing the first declaration', () => {
  const bom = String.fromCharCode(0xfeff);
  const symbols = extractSymbols(`${bom}export function firstSymbol() {}\n`);
  assert.ok(symbols.some((symbol) => symbol.name === 'firstSymbol'));
});

test('extracts declarations without matching comments or string literals', () => {
  const source = `
    // function fakeComment() {}
    /* class FakeBlock { } */
    const text = "function fakeString() {}";
    const template = \`class FakeTemplate { }\`;
    export function realFunction() {}
    export class RealClass {}
  `;
  const symbols = extractSymbols(source);
  const names = symbols.map((symbol) => symbol.name);
  assert.ok(names.includes('realFunction'));
  assert.ok(names.includes('RealClass'));
  assert.ok(!names.includes('fakeComment'));
  assert.ok(!names.includes('FakeBlock'));
  assert.ok(!names.includes('fakeString'));
  assert.ok(!names.includes('FakeTemplate'));
});


test('persists call sites and rejects a previous index version', async (t) => {
  const { dir, root } = await tempCopy();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const index = new ProjectIndex(root);
  const report = await index.refresh();
  const entry = report.index.files['src/server.ts'];
  assert.ok(Array.isArray(entry.calls));
  assert.ok(entry.calls.some((call) => call.name === 'createServer'));
  assert.ok(entry.calls.some((call) => call.name === 'AuthMiddleware' && call.kind === 'new'));

  const parsed = JSON.parse(await readFile(index.indexPath, 'utf8'));
  parsed.version = 1;
  await writeFile(index.indexPath, JSON.stringify(parsed));
  await assert.rejects(new ProjectIndex(root).load(), /unsupported format/);
});
