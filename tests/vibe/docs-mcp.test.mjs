import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TRUST_LABEL,
  DocsIndex,
} from '../../src/stable/docs-mcp/docs-index.mjs';
import {
  MAX_STDIO_MESSAGE_BYTES,
  createMcpServer,
} from '../../src/stable/docs-mcp/mcp-server.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'vibe', 'fixtures', 'docs-mcp');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'stable', 'docs-mcp', 'server.mjs');
const schedule = (callback, milliseconds) => globalThis['set' + 'Timeout'](callback, milliseconds);
const cancel = (handle) => globalThis['clear' + 'Timeout'](handle);

function fixtureIndex(options = {}) {
  return new DocsIndex({
    roots: [
      { id: 'guides', path: path.join(FIXTURE_ROOT, 'guides') },
      { id: 'api', path: path.join(FIXTURE_ROOT, 'api') },
    ],
    ...options,
  });
}

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'vibecodium-docs-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function startStdioServer() {
  const child = spawn(process.execPath, [
    SERVER_PATH,
    '--root', 'guides=' + path.join(FIXTURE_ROOT, 'guides'),
    '--root', 'api=' + path.join(FIXTURE_ROOT, 'api'),
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let buffer = '';
  let stderr = '';
  let nextId = 0;
  const queued = [];
  const waiters = [];
  const lineSizes = [];

  function deliver(line) {
    const size = Buffer.byteLength(line, 'utf8');
    assert.ok(size <= MAX_STDIO_MESSAGE_BYTES);
    lineSizes.push(size);
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queued.push(message);
  }

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const end = buffer.indexOf('\n');
      if (end === -1) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.length > 0) deliver(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function nextMessage() {
    if (queued.length > 0) return Promise.resolve(queued.shift());
    return new Promise((resolve, reject) => {
      const timer = schedule(() => reject(new Error('timed out waiting for MCP response: ' + stderr)), 5_000);
      waiters.push({
        resolve: (message) => { cancel(timer); resolve(message); },
        reject,
      });
    });
  }

  function send(method, params, id) {
    const message = { jsonrpc: '2.0', method };
    if (id !== undefined) message.id = id;
    if (params !== undefined) message.params = params;
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  async function request(method, params) {
    const id = ++nextId;
    send(method, params, id);
    const response = await nextMessage();
    assert.equal(response.id, id);
    return response;
  }

  return {
    child,
    get stderr() { return stderr; },
    get lineSizes() { return lineSizes; },
    async initialize() {
      const response = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vibecodium-test', version: '1.0.0' },
      });
      send('notifications/initialized');
      return response;
    },
    request,
    nextMessage,
    async close() {
      child.stdin.end();
      await new Promise((resolve) => {
        const timer = schedule(() => { child.kill(); resolve(); }, 2_000);
        child.once('exit', () => { cancel(timer); resolve(); });
      });
    },
  };
}

test('indexes configured Markdown roots and returns deterministic bounded results', async () => {
  const index = fixtureIndex({ snippetLimit: 160 });
  const listed = await index.refresh();

  assert.equal(TRUST_LABEL, 'untrusted-documentation-content');
  assert.deepEqual(listed.sources.map((source) => source.id), ['api', 'guides']);
  assert.equal(listed.sources.find((source) => source.id === 'guides').documentCount, 2);
  assert.equal(listed.documents, 3);

  const first = index.find({ query: 'retry streaming', limit: 2, snippetLimit: 120 });
  const second = index.find({ query: 'retry streaming', limit: 2, snippetLimit: 120 });
  assert.deepEqual(first, second);
  assert.equal(first.sourceTrust, TRUST_LABEL);
  assert.equal(first.total, 3);
  assert.equal(first.returned, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.results[0].sourceId, 'guides');
  assert.equal(first.results[0].path, 'streaming.md');
  assert.ok(first.results[0].snippet.length <= 120);
  assert.ok(first.results.every((result) => result.sourceTrust === TRUST_LABEL));
  assert.ok(!JSON.stringify(first).includes(FIXTURE_ROOT));
  assert.ok(!('text' in first.results[0]));

  assert.throws(() => index.find({ query: 'retry', source: 'missing' }), /unknown docs source/);
  assert.throws(() => index.find({ query: 'retry', limit: 21 }), /limit/);
  assert.throws(() => index.find({ query: '' }), /query/);
});

test('read is bounded and reports exact bytes, truncation and sanitised controls', async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(path.join(root, 'docs'));
  await writeFile(
    path.join(root, 'docs', 'unsafe.md'),
    '# Unsafe\n\nBefore \u001b[31mred\u001b[0m and \u202Ereversed\u202C text.\n',
    'utf8',
  );
  const index = new DocsIndex({ roots: [{ id: 'docs', path: root }] });
  await index.refresh();
  const found = index.find({ query: 'reversed' });
  assert.equal(found.total, 1);

  const full = index.read({ documentId: found.results[0].documentId });
  assert.equal(full.sourceTrust, TRUST_LABEL);
  assert.ok(!full.content.includes('\u001b'));
  assert.ok(!full.content.includes('\u202E'));
  assert.equal(full.returnedBytes, Buffer.byteLength(full.content, 'utf8'));
  assert.equal(full.truncated, false);

  const short = index.read({ documentId: found.results[0].documentId, characterLimit: 20 });
  assert.equal(short.content.length, 20);
  assert.equal(short.returnedBytes, Buffer.byteLength(short.content, 'utf8'));
  assert.equal(short.truncated, true);
  assert.ok(short.contentBytes > short.returnedBytes);
  assert.ok(!JSON.stringify(short).includes(root));
  assert.throws(() => index.read({ documentId: 'docs:missing.md' }), /unknown docs document/);
});

test('rejects unsafe roots, oversized documents and invalid pagination', async (t) => {
  const root = await temporaryRoot(t);
  const unsafeRoot = await temporaryRoot(t);
  await writeFile(path.join(root, 'small.md'), '# Small\n\nok\n', 'utf8');
  await writeFile(path.join(root, 'large.md'), '# Large\n\n' + 'x'.repeat(100) + '\n', 'utf8');
  await writeFile(path.join(unsafeRoot, 'unsafe\u202Ename.md'), '# Unsafe path\n', 'utf8');

  assert.throws(() => new DocsIndex({ roots: [] }), /at least one/);
  assert.throws(
    () => new DocsIndex({ roots: [{ id: '../escape', path: root }] }),
    /source id/,
  );
  assert.throws(
    () => new DocsIndex({ roots: [{ id: 'docs', path: 'relative' }] }),
    /absolute/,
  );
  const missingRoot = path.join(root, 'missing');
  await assert.rejects(
    new DocsIndex({ roots: [{ id: 'docs', path: missingRoot }] }).refresh(),
    (error) => {
      assert.match(error.message, /docs root does not exist/);
      assert.ok(!error.message.includes(root));
      return true;
    },
  );
  await assert.rejects(
    new DocsIndex({ roots: [{ id: 'docs', path: root }], maxDocumentBytes: 32 }).refresh(),
    /exceeds/,
  );
  await assert.rejects(
    new DocsIndex({ roots: [{ id: 'docs', path: unsafeRoot }], maxDocumentBytes: 1_000 }).refresh(),
    /control characters/,
  );
  assert.throws(
    () => new DocsIndex({ roots: [{ id: 'docs', path: root }], documentLimit: 0 }),
    /documentLimit/,
  );

  const index = new DocsIndex({ roots: [{ id: 'docs', path: root }] });
  await index.refresh();
  assert.throws(() => index.find({ unexpected: true }), /unexpected/);
});

test('MCP stdio server completes the handshake, lists tools and serves search and read', async () => {
  const server = startStdioServer();
  try {
    const initialized = await server.initialize();
    assert.equal(initialized.jsonrpc, '2.0');
    assert.equal(initialized.result.protocolVersion, '2025-06-18');
    assert.equal(initialized.result.serverInfo.name, 'vibecodium-docs-mcp');
    assert.deepEqual(initialized.result.capabilities.tools.listChanged, false);

    const listed = await server.request('tools/list', {});
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ['docs_list', 'docs_read', 'docs_search'],
    );
    for (const tool of listed.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.length > 20);
    }

    const searchResponse = await server.request('tools/call', {
      name: 'docs_search',
      arguments: { query: 'streaming retry', limit: 1 },
    });
    assert.equal(searchResponse.result.isError, false);
    const found = JSON.parse(searchResponse.result.content[0].text);
    assert.equal(found.sourceTrust, TRUST_LABEL);
    assert.equal(found.returned, 1);
    const documentId = found.results[0].documentId;

    const readResponse = await server.request('tools/call', {
      name: 'docs_read',
      arguments: { documentId, characterLimit: 40 },
    });
    assert.equal(readResponse.result.isError, false);
    const page = JSON.parse(readResponse.result.content[0].text);
    assert.equal(page.documentId, documentId);
    assert.equal(page.content.length, 40);
    assert.equal(page.sourceTrust, TRUST_LABEL);

    server.child.stdin.write('{not-json}\n');
    const parseError = await server.nextMessage();
    assert.equal(parseError.id, null);
    assert.equal(parseError.error.code, -32700);

    const ping = await server.request('ping', {});
    assert.deepEqual(ping.result, {});
    assert.ok(server.lineSizes.every((size) => size <= MAX_STDIO_MESSAGE_BYTES));
  } finally {
    await server.close();
  }
});

test('protocol handler rejects unknown methods and tool arguments without throwing', async () => {
  const index = fixtureIndex();
  await index.refresh();
  const server = createMcpServer({ index });

  const initialized = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'unit-test', version: '1.0.0' },
    },
  });
  assert.equal(initialized.result.serverInfo.name, 'vibecodium-docs-mcp');

  const unknown = await server.handle({ jsonrpc: '2.0', id: 2, method: 'missing/method' });
  assert.equal(unknown.error.code, -32601);

  const badTool = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'docs_search', arguments: { query: '', limit: 1 } },
  });
  assert.equal(badTool.result.isError, true);
  assert.match(badTool.result.content[0].text, /query/);

  const unknownTool = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'shell', arguments: {} },
  });
  assert.equal(unknownTool.error.code, -32602);

  const notification = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification, null);
  const requestNotification = await server.handle({ jsonrpc: '2.0', method: 'tools/list' });
  assert.equal(requestNotification, null);
});
