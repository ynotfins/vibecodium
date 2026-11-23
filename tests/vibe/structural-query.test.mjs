import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProjectIndex, extractCalls } from '../../src/stable/index-engine/index-engine.mjs';
import {
  MAX_ANSWER_BYTES,
  MAX_ANSWER_NODES,
  StructuralQuery,
  StructuralQueryError,
} from '../../src/stable/index-engine/structural-query.mjs';

async function makeProject(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-structural-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return dir;
}

async function makeQuery(t, files, options) {
  const root = await makeProject(t, files);
  const index = new ProjectIndex(root);
  await index.refresh();
  return { root, index, query: new StructuralQuery(index, options) };
}

const BASE_FILES = {
  'src/lib.ts': [
    'export function helper(): number {',
    '  return 1;',
    '}',
    'export function leaf(): number {',
    '  return helper();',
    '}',
    'export function mid(): number {',
    '  return leaf();',
    '}',
    'export function top(): number {',
    '  return mid();',
    '}',
    'export function hub(): number {',
    '  return 0;',
    '}',
    '',
  ].join('\n'),
  'src/cycle.ts': [
    'export function pingA(): number {',
    '  return pingB();',
    '}',
    'export function pingB(): number {',
    '  return pingA();',
    '}',
    '',
  ].join('\n'),
  'src/shapes.ts': [
    'export function declOnly(): number {',
    '  return 1;',
    '}',
    'const handlers = {',
    '  handle() {',
    '    return 1;',
    '  },',
    '};',
    'export class Service {',
    '  run(): number {',
    '    return step();',
    '  }',
    '  step(): number {',
    '    return 1;',
    '  }',
    '}',
    'export class Thing {',
    '  constructor() {}',
    '}',
    'export function makeThing(): Thing {',
    '  return new Thing();',
    '}',
    '',
  ].join('\n'),
  'src/quiet.ts': [
    '// ghost() is only mentioned here',
    "const label = 'ghost()';",
    'const pattern = /ghost\\(\\)/;',
    'export function ghost(): number {',
    '  return 1;',
    '}',
    'export function callsExternal(): number {',
    '  return externalThing();',
    '}',
    '',
  ].join('\n'),
  'src/dup1.ts': 'export function dup(): number {\n  return 1;\n}\n',
  'src/dup2.ts': 'export function dup(): number {\n  return 2;\n}\n',
  'src/use-dup.ts': [
    "import { dup } from './dup1';",
    'export function useDup(): number {',
    '  return dup();',
    '}',
    '',
  ].join('\n'),
};

function fans(count) {
  const lines = ["import { hub } from './lib';"];
  for (let i = 0; i < count; i += 1) lines.push(`export function fan${i}(): number { return hub(); }`);
  return `${lines.join('\n')}\n`;
}

test('extractCalls records calls but not declarations, comments, strings, regex or method shorthand', () => {
  const source = [
    '// ghost()',
    "const label = 'ghost()';",
    'const pattern = /ghost\\(\\)/;',
    'export function real(): number {',
    '  return helper();',
    '}',
    'const handlers = {',
    '  handle() {',
    '    return 1;',
    '  },',
    '};',
    'export class Service {',
    '  run(): number {',
    '    return this.step();',
    '  }',
    '  step(): number {',
    '    return 1;',
    '  }',
    '}',
    '',
  ].join('\n');
  const calls = extractCalls(source);
  const names = calls.map((call) => call.name).sort();
  assert.deepEqual(names, ['helper', 'step']);
  const step = calls.find((call) => call.name === 'step');
  assert.equal(step.receiver, 'this');
  assert.equal(step.kind, 'call');
});

test('extractCalls marks constructor calls and stops at the per-file cap', () => {
  const calls = extractCalls('export function make() { return new Thing(); }\n');
  assert.deepEqual(calls.map((call) => [call.name, call.kind]), [['Thing', 'new']]);
  const capped = extractCalls(`${'a();\n'.repeat(10)}`, { maxCalls: 3 });
  assert.equal(capped.length, 3);
});

test('answers callers and callees from the index without source text', async (t) => {
  const { query } = await makeQuery(t, BASE_FILES);
  const callers = query.callers('leaf');
  assert.equal(callers.found, true);
  assert.deepEqual(callers.results.map((result) => result.name), ['mid']);
  assert.equal(callers.results[0].file, 'src/lib.ts');
  assert.deepEqual(Object.keys(callers.results[0]).sort(),
    ['at', 'column', 'file', 'kind', 'line', 'name']);

  const callees = query.callees('mid');
  assert.deepEqual(callees.results.map((result) => result.name), ['leaf']);

  const thing = query.callees('makeThing');
  assert.deepEqual(thing.results.map((result) => [result.name, result.at.kind]), [['Thing', 'new']]);

  const serialized = JSON.stringify(callers);
  assert.ok(!serialized.includes('return 1'));
  assert.ok(!('content' in callers.results[0]));
});

test('computes transitive impact up to the requested depth', async (t) => {
  const { query } = await makeQuery(t, BASE_FILES);
  const deep = query.impact('helper', { depth: 3 });
  assert.deepEqual(deep.results.map((result) => [result.name, result.depth]),
    [['leaf', 1], ['mid', 2], ['top', 3]]);
  assert.equal(deep.counts.total, 3);
  assert.equal(deep.truncated, false);

  const shallow = query.impact('helper', { depth: 1 });
  assert.deepEqual(shallow.results.map((result) => result.name), ['leaf']);
});

test('finds the shortest path between symbols', async (t) => {
  const { query } = await makeQuery(t, BASE_FILES);
  const answer = query.path('top', 'helper');
  assert.equal(answer.found, true);
  assert.deepEqual(answer.path.map((node) => node.name), ['top', 'mid', 'leaf', 'helper']);
  assert.equal(answer.hops, 3);
  assert.equal(query.path('helper', 'top').found, false);
});

test('keeps cycles finite', async (t) => {
  const { query } = await makeQuery(t, BASE_FILES);
  const impact = query.impact('pingA', { depth: 8 });
  assert.deepEqual(impact.results.map((result) => result.name), ['pingB']);
  assert.equal(query.path('pingA', 'pingA').found, true);
});

test('bounds a large caller answer by count and bytes', async (t) => {
  const files = { ...BASE_FILES, 'src/fans.ts': fans(300) };
  const { query } = await makeQuery(t, files);
  const limited = query.callers('hub', { limit: 25 });
  assert.equal(limited.results.length, 25);
  assert.equal(limited.counts.total, 300);
  assert.equal(limited.truncated, true);
  assert.ok(limited.bytes <= MAX_ANSWER_BYTES);

  const small = await makeQuery(t, files, { maxBytes: 4_096 });
  const capped = small.query.callers('hub', { limit: MAX_ANSWER_NODES });
  assert.ok(capped.bytes <= 4_096, `bytes ${capped.bytes}`);
  assert.equal(capped.truncated, true);
  assert.equal(capped.counts.total, 300);
  assert.ok(capped.results.length < 300);
  assert.ok(!JSON.stringify(capped).includes('return hub'));
});

test('reports ambiguous names with candidates instead of guessing', async (t) => {
  const { query } = await makeQuery(t, BASE_FILES);
  const answer = query.callers('dup');
  assert.equal(answer.ambiguous, true);
  assert.equal(answer.candidates.length, 2);
  assert.deepEqual(answer.candidates.map((candidate) => candidate.file).sort(),
    ['src/dup1.ts', 'src/dup2.ts']);
  assert.equal(answer.results, undefined);

  const narrowed = query.callers({ name: 'dup', file: 'src/dup1.ts' });
  assert.equal(narrowed.ambiguous, undefined);
  assert.deepEqual(narrowed.results.map((result) => result.name), ['useDup']);
});

test('works after a persisted index reload', async (t) => {
  const { root, query } = await makeQuery(t, BASE_FILES);
  assert.equal(query.callers('leaf').results.length, 1);
  const reloaded = await new ProjectIndex(root).load();
  const after = new StructuralQuery(reloaded.index);
  assert.deepEqual(after.callees('top').results.map((result) => result.name), ['mid']);
  assert.equal(after.callers('helper').results[0].name, 'leaf');
});

test('answer() returns one bounded JSON answer and rejects unknown kinds', async (t) => {
  const { query } = await makeQuery(t, BASE_FILES);
  const answer = query.answer({ kind: 'path', from: 'top', to: 'helper', maxDepth: 6 });
  assert.equal(answer.kind, 'path');
  assert.equal(answer.found, true);
  assert.ok(JSON.stringify(answer).length > 0);
  assert.throws(() => query.answer({ kind: 'explain-everything' }), StructuralQueryError);
  assert.throws(() => query.answer({}), StructuralQueryError);
  assert.throws(() => query.callers(''), StructuralQueryError);
  assert.throws(() => query.callers('x', { limit: 0 }), StructuralQueryError);
});

test('counts unresolved calls without inventing edges', async (t) => {
  const { query } = await makeQuery(t, BASE_FILES);
  assert.ok(query.statsSnapshot().unresolvedCalls >= 1);
  assert.equal(query.callees('callsExternal').found, true);
  assert.deepEqual(query.callees('callsExternal').results, []);
  assert.equal(query.callers('ghost').found, true);
  assert.deepEqual(query.callers('ghost').results, []);
  assert.equal(query.callers('handle').found, false);
  assert.deepEqual(query.callers('handle').results, []);
});


test('rejects a malformed or oversized index snapshot', () => {
  const good = { symbols: [{ name: 'a', kind: 'function', line: 1, column: 1 }], files: {} };
  assert.ok(new StructuralQuery(good));
  assert.throws(() => new StructuralQuery({ files: { 'a.ts': { symbols: [null] } } }), StructuralQueryError);
  assert.throws(() => new StructuralQuery({ files: { 'a.ts': { symbols: [], calls: 'nope' } } }), StructuralQueryError);
  assert.throws(() => new StructuralQuery({ files: { 'a.ts': { symbols: [], calls: [{ name: 'x', kind: 'bogus', line: 1, column: 1 }] } } }), StructuralQueryError);
  assert.throws(() => new StructuralQuery({ files: {} }), StructuralQueryError);
});

test('keeps counts, bytes and paths truthful when an answer is trimmed', async (t) => {
  const files = { ...BASE_FILES, 'src/fans.ts': fans(300) };
  const { query } = await makeQuery(t, files);
  const capped = query.callers('hub', { limit: MAX_ANSWER_NODES });
  assert.ok(capped.results.length > 0);
  assert.ok(capped.results.length < 300);
  assert.equal(capped.counts.returned, capped.results.length);
  assert.equal(capped.counts.total, 300);
  assert.equal(capped.truncated, true);
  assert.ok(capped.bytes <= MAX_ANSWER_BYTES);
  assert.equal(Buffer.byteLength(JSON.stringify(capped)), capped.bytes);

  const impact = query.impact('hub', { limit: 25 });
  assert.equal(impact.results.length, 25);
  assert.equal(impact.counts.returned, 25);
  assert.equal(impact.counts.total, 300);
  assert.equal(impact.truncated, true);

  const found = query.path('top', 'helper');
  assert.equal(found.hops, found.path.length - 1);
  assert.equal(found.truncated, false);

  const long = 'a'.repeat(1_000);
  const snapshot = {
    symbols: [],
    files: {
      [`${long}1.ts`]: {
        symbols: [{ name: 'a', kind: 'function', line: 1, column: 1, endLine: 2 }],
        calls: [{ name: 'b', line: 2, column: 1, endLine: 2, depth: 1, kind: 'call' }],
      },
      [`${long}2.ts`]: {
        symbols: [{ name: 'b', kind: 'function', line: 1, column: 1, endLine: 2 }],
        calls: [],
      },
    },
  };
  const tight = new StructuralQuery(snapshot, { maxBytes: 8_192 });
  assert.equal(tight.path('a', 'b').found, true);
  const atomic = new StructuralQuery(snapshot, { maxBytes: 4_096 });
  assert.throws(() => atomic.path('a', 'b'), StructuralQueryError);
  assert.throws(() => new StructuralQuery(snapshot, { maxBytes: 256 }).describe('a'), StructuralQueryError);
});

test('attributes top-level calls to the module, not the preceding function', async (t) => {
  const files = {
    'src/top.ts': [
      'export function helper(): number {',
      '  return 1;',
      '}',
      'export function first(): number {',
      '  return 1;',
      '}',
      'helper();',
      '',
    ].join('\n'),
  };
  const { query } = await makeQuery(t, files);
  const callers = query.callers('helper');
  assert.deepEqual(callers.results.map((result) => result.name), ['<module>']);
  assert.equal(callers.results[0].kind, 'module');
  assert.equal(query.callers('first').results.length, 0);
});

test('ambiguous and missing answers keep a complete counts contract', async (t) => {
  const { index, query } = await makeQuery(t, BASE_FILES);
  const ambiguous = query.callers('dup');
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.counts.candidates, 2);
  assert.equal(ambiguous.counts.returned, ambiguous.candidates.length);

  const long = 'a'.repeat(500);
  const wide = { symbols: [], files: {} };
  for (let i = 0; i < 5; i += 1) {
    wide.files[`${long}${i}.ts`] = {
      symbols: [{ name: 'dup', kind: 'function', line: 1, column: 1 }],
      calls: [],
    };
  }
  const trimmed = new StructuralQuery(wide, { maxBytes: 256 }).callers('dup');
  assert.ok(trimmed.candidates.length < 5);
  assert.equal(trimmed.counts.candidates, 5);
  assert.equal(trimmed.counts.returned, trimmed.candidates.length);

  for (const [kind, answer] of [
    ['callers', query.callers('notDeclaredAnywhere')],
    ['callees', query.callees('notDeclaredAnywhere')],
    ['impact', query.impact('notDeclaredAnywhere')],
  ]) {
    assert.equal(answer.kind, kind);
    assert.equal(answer.found, false);
    assert.equal(answer.counts.total, 0);
    assert.equal(answer.counts.returned, 0);
  }
});
