import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DocsIndex,
  MAX_QUERY_CHARS,
  MAX_READ_CHARS,
  MAX_RESULTS,
  MAX_SNIPPET_CHARS,
  MAX_SOURCES,
} from '../../src/stable/docs-mcp/docs-index.mjs';
import {
  MAX_STDIO_MESSAGE_BYTES,
  MAX_STDIO_REQUEST_BYTES,
  serveMcpStdio,
} from '../../src/stable/docs-mcp/mcp-server.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'stable', 'docs-mcp', 'server.mjs');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'vibe', 'fixtures', 'docs-mcp', 'guides');
const encode = JSON['stringify'];
const decode = JSON['parse'];
const byteLength = (value) => Buffer['byteLength'](value, 'utf8');

test('docs_list succeeds when tools/call omits arguments', () => {
  const request = encode({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'docs_list' },
  });

  const child = spawnSync(process.execPath, [
    SERVER_PATH,
    '--root', 'guides=' + FIXTURE_ROOT,
  ], { input: request + '\n', encoding: 'utf8', timeout: 5_000 });

  assert.equal(child.status, 0, child.stderr);
  const response = decode(child.stdout.replace(/\r?\n$/, ''));
  assert.equal(response.id, 1);
  assert.equal(response.error, undefined, encode(response.error));
  assert.equal(response.result.isError, false);
});

test('read replaces C1, format, bidi and variation-selector controls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibecodium-docs-mcp-'));
  try {
    await writeFile(
      path.join(root, 'controls.md'),
      '# Controls\n\nA' + String.fromCodePoint(0x85, 0x00ad, 0x200f, 0x2066, 0xfe0f, 0xe0041, 0xfff9) + 'B'
        + String.fromCodePoint(0x2069) + 'C\n',
      'utf8',
    );
    const index = new DocsIndex({ roots: [{ id: 'docs', path: root }] });
    await index.refresh();
    const found = index.find({ query: 'controls' });
    assert.equal(found.results.length, 1);
    const read = index.read({ documentId: found.results[0].documentId });

    for (const code of [0x85, 0x00ad, 0x200f, 0x2066, 0x2069, 0xfe0f, 0xe0041, 0xfff9]) {
      assert.equal(read.content.includes(String.fromCodePoint(code)), false);
    }
    assert.match(read.content, /\uFFFD/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized responses fail closed with a null id', () => {
  const base = encode({ jsonrpc: '2.0', id: '', method: 'missing/method' });
  const id = 'A'.repeat(MAX_STDIO_REQUEST_BYTES - byteLength(base));
  const request = encode({ jsonrpc: '2.0', id, method: 'missing/method' });

  const child = spawnSync(process.execPath, [
    SERVER_PATH,
    '--root', 'guides=' + FIXTURE_ROOT,
  ], { input: request + '\n', encoding: 'utf8', timeout: 5_000 });

  assert.equal(child.status, 0, child.stderr);
  const response = decode(child.stdout.replace(/\r?\n$/, ''));
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /response exceeds/);
  assert.ok(byteLength(child.stdout.replace(/\r?\n$/, '')) <= MAX_STDIO_MESSAGE_BYTES);
});

test('non-ENOENT root failures do not expose the absolute root', async () => {
  const invalidRoot = FIXTURE_ROOT + String.fromCharCode(0) + 'invalid';
  const index = new DocsIndex({ roots: [{ id: 'docs', path: invalidRoot }] });

  await assert.rejects(index.refresh(), (error) => {
    assert.match(error.message, /docs root is not readable/);
    const leaked = error.message.includes(REPO_ROOT);
    assert.equal(leaked, false);
    return true;
  });
});

test('symlinked descendants are skipped and never indexed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibecodium-docs-mcp-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vibecodium-docs-mcp-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));

  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'real.md'), '# Real\n\nalpha inside\n', 'utf8');
  await writeFile(path.join(outside, 'leak.md'), '# Leak\n\nalpha outside\n', 'utf8');
  try {
    await symlink(outside, path.join(root, 'linkdir'), 'junction');
  } catch (error) {
    t.skip('cannot create a directory junction: ' + error.code);
    return;
  }
  try {
    await symlink(path.join(outside, 'leak.md'), path.join(root, 'linkfile.md'), 'file');
  } catch {
    // File symlinks need extra Windows privileges; the junction still covers traversal.
  }

  const index = new DocsIndex({ roots: [{ id: 'docs', path: root }] });
  const listed = await index.refresh();
  assert.equal(listed.documents, 1);
  const found = index.find({ query: 'alpha', limit: MAX_RESULTS });
  assert.deepEqual(found.results.map((result) => result.path), ['nested/real.md']);
  const serialized = JSON.stringify(listed) + JSON.stringify(found);
  assert.ok(!serialized.includes(outside));
  assert.ok(!serialized.includes(root));
});

test('query, result, snippet, read, source, document and total bounds are enforced', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibecodium-docs-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'one.md'), '# One\n\nalpha\n', 'utf8');
  await writeFile(path.join(root, 'two.md'), '# Two\n\nalpha\n', 'utf8');

  const index = new DocsIndex({ roots: [{ id: 'docs', path: root }] });
  await index.refresh();
  const documentId = index.find({ query: 'alpha' }).results[0].documentId;

  assert.throws(() => index.find({ query: 'a'.repeat(MAX_QUERY_CHARS + 1) }), /query exceeds/);
  assert.doesNotThrow(() => index.find({ query: 'a'.repeat(MAX_QUERY_CHARS) }));
  assert.throws(() => index.find({ query: 'alpha', limit: 0 }), /limit/);
  assert.throws(() => index.find({ query: 'alpha', limit: MAX_RESULTS + 1 }), /limit/);
  assert.throws(() => index.find({ query: 'alpha', snippetLimit: 39 }), /snippetLimit/);
  assert.throws(() => index.find({ query: 'alpha', snippetLimit: MAX_SNIPPET_CHARS + 1 }), /snippetLimit/);
  assert.throws(() => index.read({ documentId, characterLimit: 0 }), /characterLimit/);
  assert.throws(() => index.read({ documentId, characterLimit: MAX_READ_CHARS + 1 }), /characterLimit/);

  assert.throws(
    () => new DocsIndex({
      roots: Array.from(
        { length: MAX_SOURCES + 1 },
        (_, position) => ({ id: 'source' + position, path: root }),
      ),
    }),
    /roots must/,
  );
  await assert.rejects(
    new DocsIndex({ roots: [{ id: 'docs', path: root }], documentLimit: 1 }).refresh(),
    /documentLimit/,
  );
  await assert.rejects(
    new DocsIndex({ roots: [{ id: 'docs', path: root }], maxTotalBytes: 1 }).refresh(),
    /maxTotalBytes/,
  );
});

test('docs-mcp sources use only Node builtins and local imports', async () => {
  for (const file of ['docs-index.mjs', 'mcp-server.mjs', 'server.mjs']) {
    const source = await readFile(path.join(REPO_ROOT, 'src', 'stable', 'docs-mcp', file), 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const importedFrom = match[1];
      assert.ok(
        importedFrom.startsWith('node:') || importedFrom.startsWith('./'),
        file + ' imports a non-builtin, non-local module: ' + importedFrom,
      );
    }
    assert.doesNotMatch(source, /\bfetch\s*\(|node:(?:http|https|net|dgram|tls|dns)\b|child_process/);
  }
});

test('multi-byte request lines are capped by bytes, not code units', async () => {
  const line = encode('\u00e9'.repeat(MAX_STDIO_REQUEST_BYTES - 4));
  assert.ok(line.length <= MAX_STDIO_REQUEST_BYTES);
  assert.ok(Buffer.byteLength(line, 'utf8') > MAX_STDIO_REQUEST_BYTES);

  const index = new DocsIndex({ roots: [{ id: 'guides', path: FIXTURE_ROOT }] });
  await index.refresh();
  let stdout = '';
  let stderr = '';
  async function* input() {
    yield Buffer.from(line + '\n', 'utf8');
  }
  await serveMcpStdio({
    index,
    version: 'test',
    input: input(),
    output: { write: (chunk) => { stdout += chunk; } },
    errorOutput: { write: (chunk) => { stderr += chunk; } },
  });

  const response = decode(stdout.replace(/\r?\n$/, ''));
  assert.equal(stderr, '');
  assert.equal(response.error.code, -32600);
  assert.match(response.error.message, /request exceeds/);
});
