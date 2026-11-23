import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AST_GREP_LANGUAGES,
  AST_GREP_PROVIDER_ID,
  AstGrepProviderError,
  MAX_AST_GREP_MATCH_TEXT,
  MAX_AST_GREP_SOURCE_BYTES,
  createAstGrepProvider,
  sanitizeAstGrepEnvironment,
} from '../../src/stable/index-engine/ast-grep-provider.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'mock-ast-grep.mjs');
const SOURCE = 'export const handler = (request) => request.url;';

function createProvider(mode = 'matches', options = {}) {
  return createAstGrepProvider({
    command: process.execPath,
    args: [FIXTURE],
    env: { MOCK_SG_MODE: mode },
    ...options,
  });
}

test('provider identity, languages and option validation', () => {
  const provider = createProvider();
  assert.equal(provider.id, AST_GREP_PROVIDER_ID);
  assert.deepEqual([...provider.languages], [...AST_GREP_LANGUAGES]);
  assert.equal(typeof provider.query, 'function');

  assert.throws(() => createAstGrepProvider(null), /options must be an object/);
  assert.throws(() => createAstGrepProvider({}), /command/);
  assert.throws(() => createAstGrepProvider({ command: '   ' }), /command/);
  assert.throws(() => createAstGrepProvider({ command: 'sg.cmd' }), /shell script/);
  assert.throws(() => createAstGrepProvider({ command: 'sg.BAT' }), /shell script/);
  assert.throws(() => createAstGrepProvider({ command: 'sg.cmd ' }), /shell script/);
  assert.throws(() => createAstGrepProvider({ command: 'sg.bat.' }), /shell script/);
  assert.throws(() => createAstGrepProvider({ command: 'sg', args: 'nope' }), /args/);
  assert.throws(() => createAstGrepProvider({ command: 'sg', id: 'Bad ID' }), /id/);
  assert.throws(() => createAstGrepProvider({ command: 'sg', timeoutMs: 1 }), /timeoutMs/);
  assert.throws(() => createAstGrepProvider({ command: 'sg', maxOutputBytes: 10 }), /maxOutputBytes/);
});

test('query validates source, pattern, language and caps', async () => {
  const provider = createProvider();
  await assert.rejects(provider.query(42, { pattern: 'const $N = $V', language: 'javascript' }), /source/);
  await assert.rejects(provider.query(SOURCE, {}), /pattern/);
  await assert.rejects(provider.query(SOURCE, { pattern: '', language: 'javascript' }), /pattern/);
  await assert.rejects(provider.query(SOURCE, { pattern: 'const $N', language: 'python' }), /language/);
  await assert.rejects(provider.query(SOURCE, { pattern: 'const $N', language: 'javascript', maxMatches: 0 }), /maxMatches/);
  await assert.rejects(provider.query('x'.repeat(MAX_AST_GREP_SOURCE_BYTES + 1), { pattern: 'const $N', language: 'javascript' }), /source/);
  await assert.rejects(provider.query('e'.repeat(MAX_AST_GREP_SOURCE_BYTES - 10) + String.fromCharCode(0xe9).repeat(8), { pattern: 'const $N', language: 'javascript' }), /source/);
  await assert.rejects(provider.query(SOURCE, { pattern: 'const $N', filePath: 'src/a.cobol' }), /extension/);
  await assert.rejects(provider.query(SOURCE, { pattern: 'const $N', language: 'javascript', filePath: 'src/a.tsx' }), /language/);
});

test('infers the language from the file extension', async () => {
  const provider = createProvider();
  const ts = await provider.query(SOURCE, { pattern: 'const $N = $V', filePath: 'src/handler.ts' });
  assert.equal(ts.language, 'typescript');
  const tsx = await provider.query(SOURCE, { pattern: 'const $N = $V', filePath: 'src/handler.tsx' });
  assert.equal(tsx.language, 'tsx');
  const js = await provider.query(SOURCE, { pattern: 'const $N = $V', filePath: 'src/handler.mjs' });
  assert.equal(js.language, 'javascript');
});

test('parses streamed matches into one-based positions and bounded meta variables', async () => {
  const provider = createProvider();
  const result = await provider.query(SOURCE, { pattern: 'const $N = $V', language: 'javascript' });
  assert.equal(result.pattern, 'const $N = $V');
  assert.equal(result.language, 'javascript');
  assert.equal(result.truncated, false);
  assert.equal(result.sourceTrust, 'untrusted-source-content');
  assert.equal(result.matches.length, 2);

  const [first, second] = result.matches;
  assert.equal(first.text, 'first:const $N = $V');
  assert.equal(first.textTruncated, false);
  assert.equal(first.line, 2);
  assert.equal(first.column, 3);
  assert.equal(first.endLine, 2);
  assert.ok(first.endColumn > first.column);
  assert.deepEqual(first.byteOffset, { start: 0, end: Buffer.byteLength(first.text) });
  assert.deepEqual(first.metaVariables.single.NAME, {
    text: 'handler', line: 2, column: 3, endLine: 2, endColumn: 10,
  });
  assert.deepEqual(first.metaVariables.multi.ARGS, [
    { text: 'a', line: 2, column: 10, endLine: 2, endColumn: 11 },
  ]);
  assert.deepEqual(first.metaVariables.transformed, { UPPER: 'HANDLER' });

  assert.equal(second.line, 5);
  assert.equal(second.column, 1);
  assert.deepEqual(second.metaVariables, { single: {}, multi: {}, transformed: {} });
});

test('passes the pattern literally and never through a shell', async () => {
  const provider = createProvider();
  const pattern = 'route($PATH) && $(touch /tmp/never)';
  const result = await provider.query(SOURCE, { pattern, language: 'javascript' });
  assert.equal(result.matches[0].text, `first:${pattern}`);
});

test('exit code 1 means no matches, not a failure', async () => {
  const provider = createProvider('none');
  const result = await provider.query(SOURCE, { pattern: 'NoSuchCall($$$)', language: 'javascript' });
  assert.deepEqual(result.matches, []);
  assert.equal(result.truncated, false);
});

test('non-zero exit codes, malformed JSON and malformed matches fail closed', async () => {
  await assert.rejects(
    createProvider('fail').query(SOURCE, { pattern: 'const $N', language: 'javascript' }),
    (error) => error instanceof AstGrepProviderError && /code 2/.test(error.message),
  );
  await assert.rejects(
    createProvider('malformed').query(SOURCE, { pattern: 'const $N', language: 'javascript' }),
    /valid JSON/,
  );
  await assert.rejects(
    createProvider('badschema').query(SOURCE, { pattern: 'const $N', language: 'javascript' }),
    /invalid match/,
  );
});

test('bounds stdout, runtime and match text', async () => {
  await assert.rejects(
    createProvider('huge', { maxOutputBytes: 1_024 }).query(SOURCE, { pattern: 'const $N', language: 'javascript' }),
    /output exceeds/,
  );
  await assert.rejects(
    createProvider('slow', { timeoutMs: 200 }).query(SOURCE, { pattern: 'const $N', language: 'javascript' }),
    /timed out/,
  );
  const huge = await createProvider('huge-text').query(SOURCE, { pattern: 'route($P)', language: 'javascript' });
  assert.equal(huge.matches.length, 1);
  assert.equal(huge.matches[0].textTruncated, true);
  assert.equal(huge.matches[0].text.length, MAX_AST_GREP_MATCH_TEXT);
});

test('rejects prototype-polluting meta variable names from the tool stream', async () => {
  await assert.rejects(
    createProvider('proto-meta').query(SOURCE, { pattern: 'const $N', language: 'javascript' }),
    /meta variable name/,
  );
});

test('rejects a match whose reported language is not one we asked for', async () => {
  await assert.rejects(
    createProvider('bad-language').query(SOURCE, { pattern: 'const $N', language: 'javascript' }),
    /invalid match language/,
  );
  await assert.rejects(
    createProvider('wrong-language').query(SOURCE, { pattern: 'const $N', language: 'javascript' }),
    /different language/,
  );
});

test('strips terminal and bidi controls from returned text', async () => {
  const result = await createProvider('control-text').query(SOURCE, { pattern: 'const $N', language: 'javascript' });
  const match = result.matches[0];
  assert.equal(match.text, 'safe:\uFFFD[31mred\uFFFD[0m:\uFFFDevil');
  assert.equal(match.metaVariables.single.NAME.text, 'a\uFFFDb\uFFFDc');
  assert.equal(match.metaVariables.transformed.T, 'x\uFFFDy');
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(match.text));
  assert.equal(result.sourceTrust, 'untrusted-source-content');
});

test('caps the number of returned matches and reports truncation', async () => {
  const result = await createProvider('many').query(SOURCE, {
    pattern: 'const $N', language: 'javascript', maxMatches: 10,
  });
  assert.equal(result.matches.length, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.matches.at(-1).text, 'hit-9');
});

test('concurrent queries keep their own pattern, language and limits', async () => {
  const provider = createProvider();
  const patterns = ['alpha($A)', 'beta($B)', 'gamma($C)', 'delta($D)'];
  const results = await Promise.all(patterns.map((pattern, index) => provider.query(SOURCE, {
    pattern,
    language: index % 2 === 0 ? 'javascript' : 'typescript',
  })));
  for (const [index, result] of results.entries()) {
    assert.equal(result.pattern, patterns[index]);
    assert.equal(result.language, index % 2 === 0 ? 'javascript' : 'typescript');
    assert.equal(result.matches[0].text, `first:${patterns[index]}`);
  }
});

test('sanitizes the child environment and rejects unsafe override names', () => {
  const output = sanitizeAstGrepEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/user',
    API_KEY: 'fake-api-key',
    GITHUB_TOKEN: 'fake-token',
    NODE_OPTIONS: '--require evil',
    LD_PRELOAD: '/tmp/evil.so',
    KEEP: 'yes',
    REDIS_URL: 'redis://fake',
    MONGODB_URI: 'mongodb://fake',
    SENTRY_DSN: 'https://fake',
    NODE_DEBUG: '1',
    NODE_REPL_EXTERNAL_MODULE: '/tmp/evil.js',
    ELECTRON_RUN_AS_NODE: '1',
    BASH_FUNC_demo: '() { :; }',
  }, {
    MOCK_SG_MODE: 'none',
    SECRET_VALUE: 'fake-secret',
  });
  assert.equal(output.KEEP, 'yes');
  assert.equal(output.MOCK_SG_MODE, 'none');
  assert.equal(output.PATH, '/usr/bin');
  for (const name of ['API_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'NODE_DEBUG', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD', 'REDIS_URL', 'MONGODB_URI', 'SENTRY_DSN', 'ELECTRON_RUN_AS_NODE', 'BASH_FUNC_demo', 'SECRET_VALUE']) {
    assert.equal(Object.hasOwn(output, name), false, `${name} must be dropped`);
  }
  assert.throws(
    () => sanitizeAstGrepEnvironment({}, { 'BAD-NAME': 'x' }),
    /safe identifiers/,
  );
});
