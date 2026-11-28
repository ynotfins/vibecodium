import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_CATALOG_MODELS,
  MODEL_CATALOG_VERSION,
  ModelDownloadError,
  downloadModel,
  findCatalogModel,
  loadCatalog,
  loadCatalogFile,
  validateCatalog,
  verifyInstalledModel,
} from '../../src/stable/runtime/model-downloader.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CATALOG_FILE = path.join(REPO_ROOT, 'vibe', 'models', 'catalog.json');
const MIB = 1024 * 1024;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function modelFor(content, overrides = {}) {
  return {
    id: 'test-chat',
    label: 'Test chat model',
    repo: 'example/test-model',
    revision: '0123456789abcdef0123456789abcdef01234567',
    file: 'test-chat-q4_k_m.gguf',
    url: 'https://example.com/models/test-chat-q4_k_m.gguf',
    sha256: sha256(content),
    sizeBytes: content.length,
    license: 'apache-2.0',
    quantization: 'q4_k_m',
    contextTokens: 8192,
    role: 'chat',
    ...overrides,
  };
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-models-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startServer(t, { content, mode = 'ok', chunkSize, delayMs = 0 }) {
  const state = { requests: 0, ranges: [], bytesSent: 0, secret: 'server-body-secret' };
  const server = http.createServer(async (request, response) => {
    state.requests += 1;
    state.ranges.push(request.headers.range ?? null);
    const finish = (status, headers, body) => {
      response.writeHead(status, headers);
      response.end(body);
    };
    if (mode === 'status') return finish(500, { 'content-type': 'text/plain' }, state.secret);
    if (mode === 'not-found') return finish(404, { 'content-type': 'text/plain' }, state.secret);
    if (mode === 'redirect' && request.url === '/model.gguf') return finish(302, { location: '/real' }, '');
    if (mode === 'reject-range') return finish(416, { 'content-range': `bytes */${content.length}` }, '');
    if (mode === 'excess') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(content.length + 1000),
      });
      response.end(Buffer.concat([content, Buffer.alloc(1000, 1)]));
      return;
    }

    const total = content.length;
    let start = 0;
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    if (match && mode !== 'ignore-range') {
      start = Number(match[1]);
      if (start >= total) return finish(416, { 'content-range': `bytes */${total}` }, '');
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': String(total - start),
        'content-range': `bytes ${start}-${total - 1}/${total}`,
        'accept-ranges': 'bytes',
      });
    } else {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(total),
        'accept-ranges': 'bytes',
      });
    }

    let body = content.subarray(start);
    if (mode === 'corrupt') {
      body = Buffer.from(body);
      body[0] = body[0] ^ 0xff;
    }
    if (mode === 'truncate' || mode === 'reset' || mode === 'stall') {
      body = body.subarray(0, Math.floor(body.length / 2));
    }
    const step = chunkSize ?? body.length;
    for (let offset = 0; offset < body.length; offset += step) {
      if (response.destroyed) return;
      const chunk = body.subarray(offset, offset + step);
      response.write(chunk);
      state.bytesSent += chunk.length;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (mode === 'reset') {
      setTimeout(() => { try { response.socket.destroy(); } catch { /* the socket is gone */ } }, 50);
      return;
    }
    if (mode === 'stall') return;
    response.end();
  });
  server.on('clientError', (error, socket) => { socket.destroy(); });
  server.keepAliveTimeout = 200;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { state, url: `http://127.0.0.1:${port}/model.gguf` };
}

function catalogOf(models) {
  return { version: MODEL_CATALOG_VERSION, models };
}

function rejectsWith(code) {
  return (error) => {
    assert.ok(error instanceof ModelDownloadError, `expected ModelDownloadError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('the shipped catalog pins every model by revision, digest and byte size', () => {
  const catalog = loadCatalogFile(CATALOG_FILE);
  assert.equal(catalog.version, MODEL_CATALOG_VERSION);
  assert.ok(catalog.models.length >= 2);
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.models));
  assert.ok(Object.isFrozen(catalog.models[0]));
  for (const model of catalog.models) {
    assert.match(model.revision, /^[0-9a-f]{40}$/);
    assert.match(model.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(model.sizeBytes) && model.sizeBytes > 0);
    assert.ok(model.url.startsWith('https://'));
    assert.ok(model.url.includes('/resolve/' + model.revision + '/'));
    assert.ok(model.url.endsWith('/' + model.file));
    assert.ok(['chat', 'embedding', 'code', 'edit'].includes(model.role));
  }
  const chat = findCatalogModel(catalog, 'qwen2.5-coder-1.5b-q4-k-m');
  const embedding = findCatalogModel(catalog, 'qwen3-embedding-0.6b-q8-0');
  assert.equal(chat.role, 'chat');
  assert.equal(chat.license, 'apache-2.0');
  assert.equal(chat.sizeBytes, 1117320768);
  assert.equal(chat.sha256, 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046');
  assert.equal(embedding.role, 'embedding');
  assert.equal(embedding.sizeBytes, 639150592);
  assert.equal(embedding.sha256, '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439');
  assert.throws(() => findCatalogModel(catalog, 'not-a-model'), rejectsWith('unknown-model'));
});

test('loadCatalog rejects invalid JSON and non-objects', () => {
  assert.throws(() => loadCatalog('{'), rejectsWith('invalid-catalog'));
  assert.throws(() => loadCatalog('[]'), rejectsWith('invalid-catalog'));
  assert.throws(() => loadCatalog('null'), rejectsWith('invalid-catalog'));
});

test('catalog validation fails closed on malformed entries', () => {
  const content = Buffer.from('abc');
  const good = modelFor(content);
  const accessor = { ...good };
  Object.defineProperty(accessor, 'file', { enumerable: true, get() { throw new Error('accessor must not run'); } });
  const holes = [good];
  holes.length = 2;
  const cases = [
    ['unknown version', () => ({ version: 2, models: [good] })],
    ['missing models', () => ({ version: 1 })],
    ['extra root key', () => ({ version: 1, models: [good], extra: true })],
    ['empty models', () => ({ version: 1, models: [] })],
    ['too many models', () => catalogOf(Array.from({ length: MAX_CATALOG_MODELS + 1 }, (_, index) => modelFor(content, { id: 'model-' + index, file: 'model-' + index + '.gguf' })))],
    ['duplicate id', () => catalogOf([good, { ...good, file: 'other.gguf' }])],
    ['duplicate file', () => catalogOf([good, { ...good, id: 'other' }])],
    ['uppercase id', () => catalogOf([modelFor(content, { id: 'Model' })])],
    ['path traversal file', () => catalogOf([modelFor(content, { file: '../evil.gguf' })])],
    ['nested file', () => catalogOf([modelFor(content, { file: 'sub/evil.gguf' })])],
    ['non-gguf file', () => catalogOf([modelFor(content, { file: 'model.bin' })])],
    ['reserved device file', () => catalogOf([modelFor(content, { file: 'nul.gguf' })])],
    ['branch revision', () => catalogOf([modelFor(content, { revision: 'main' })])],
    ['short digest', () => catalogOf([modelFor(content, { sha256: 'abcd' })])],
    ['zero size', () => catalogOf([modelFor(content, { sizeBytes: 0 })])],
    ['fractional size', () => catalogOf([modelFor(content, { sizeBytes: 1.5 })])],
    ['disallowed license', () => catalogOf([modelFor(content, { license: 'gpl-3.0' })])],
    ['http url off loopback', () => catalogOf([modelFor(content, { url: 'http://example.com/model.gguf' })])],
    ['url with userinfo', () => catalogOf([modelFor(content, { url: 'https://user:secret@example.com/model.gguf' })])],
    ['url with query', () => catalogOf([modelFor(content, { url: 'https://example.com/model.gguf?token=abc' })])],
    ['url with fragment', () => catalogOf([modelFor(content, { url: 'https://example.com/model.gguf#access_token=abc' })])],
    ['unknown entry key', () => catalogOf([{ ...good, checksum: 'x' }])],
    ['accessor entry', () => catalogOf([accessor])],
    ['array hole', () => ({ version: 1, models: holes })],
    ['null prototype entry', () => catalogOf([Object.assign(Object.create(null), good)])],
    ['class instance entry', () => catalogOf([new (class Model { constructor() { Object.assign(this, good); } })()])],
    ['prototype key', () => JSON.parse('{"version":1,"models":[{"__proto__":{"id":"x"}}]}')],
  ];
  for (const [name, build] of cases) {
    assert.throws(() => validateCatalog(build()), rejectsWith('invalid-catalog'), name);
  }
});

test('a completed download installs verified bytes and reports progress', async (t) => {
  const content = Buffer.alloc(300 * 1024);
  for (let index = 0; index < content.length; index++) content[index] = index % 251;
  const server = await startServer(t, { content });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  const events = [];
  const result = await downloadModel(model, {
    destinationDir: dir,
    onProgress: (progress) => events.push(progress),
  });
  assert.equal(result.verified, true);
  assert.equal(result.skipped, false);
  assert.equal(result.resumed, false);
  assert.equal(result.resumedFrom, 0);
  assert.equal(result.replacedInvalid, false);
  assert.equal(result.sizeBytes, content.length);
  assert.equal(result.sha256, model.sha256);
  assert.equal(result.path, path.join(dir, model.file));
  assert.deepEqual(await readFile(result.path), content);
  assert.deepEqual((await readdir(dir)).sort(), [model.file]);
  assert.ok(events.length >= 2);
  for (let index = 1; index < events.length; index++) {
    assert.ok(events[index].received >= events[index - 1].received);
    assert.equal(events[index].total, content.length);
  }
  assert.equal(events.at(-1).received, content.length);
  assert.equal(events[0].resumedFrom, 0);
  assert.equal(server.state.requests, 1);
  assert.equal(server.state.ranges[0], null);
});

test('an interrupted download resumes with a Range request for the remainder only', async (t) => {
  const content = Buffer.alloc(300 * 1024, 7);
  const server = await startServer(t, { content });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  const partial = content.subarray(0, 100 * 1024);
  await writeFile(path.join(dir, model.file + '.part'), partial);
  const result = await downloadModel(model, { destinationDir: dir });
  assert.equal(server.state.ranges[0], `bytes=${partial.length}-`);
  assert.equal(server.state.bytesSent, content.length - partial.length);
  assert.equal(result.resumed, true);
  assert.equal(result.resumedFrom, partial.length);
  assert.deepEqual(await readFile(result.path), content);
  assert.deepEqual((await readdir(dir)).sort(), [model.file]);
});

test('a server that ignores Range restarts the transfer from zero', async (t) => {
  const content = Buffer.alloc(200 * 1024, 3);
  const server = await startServer(t, { content, mode: 'ignore-range' });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await writeFile(path.join(dir, model.file + '.part'), Buffer.alloc(50 * 1024, 9));
  const result = await downloadModel(model, { destinationDir: dir });
  assert.equal(result.resumed, false);
  assert.equal(result.restarted, true);
  assert.equal(server.state.bytesSent, content.length);
  assert.deepEqual(await readFile(result.path), content);
  assert.deepEqual((await readdir(dir)).sort(), [model.file]);
});

test('a checksum mismatch installs nothing and removes the partial file', async (t) => {
  const content = Buffer.alloc(120 * 1024, 5);
  const server = await startServer(t, { content, mode: 'corrupt' });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await assert.rejects(downloadModel(model, { destinationDir: dir }), rejectsWith('checksum-mismatch'));
  assert.deepEqual(await readdir(dir), []);
});

test('a short body fails as a transport error and keeps the partial file', async (t) => {
  const content = Buffer.alloc(120 * 1024, 11);
  const server = await startServer(t, { content, mode: 'truncate' });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await assert.rejects(downloadModel(model, { destinationDir: dir }), rejectsWith('network-error'));
  const part = await stat(path.join(dir, model.file + '.part'));
  assert.ok(part.size > 0 && part.size < content.length);
  assert.equal(existsSync(path.join(dir, model.file)), false);
});

test('an already verified file is returned without a request', async (t) => {
  const content = Buffer.alloc(64 * 1024, 13);
  const server = await startServer(t, { content });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await writeFile(path.join(dir, model.file), content);
  const result = await downloadModel(model, { destinationDir: dir });
  assert.equal(result.skipped, true);
  assert.equal(result.verified, true);
  assert.equal(server.state.requests, 0);
  assert.deepEqual((await readdir(dir)).sort(), [model.file]);
});

test('an existing invalid file is replaced by a verified download', async (t) => {
  const content = Buffer.alloc(64 * 1024, 17);
  const server = await startServer(t, { content });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await writeFile(path.join(dir, model.file), Buffer.alloc(content.length, 1));
  const result = await downloadModel(model, { destinationDir: dir });
  assert.equal(result.replacedInvalid, true);
  assert.equal(result.skipped, false);
  assert.deepEqual(await readFile(result.path), content);
});

test('caller cancellation keeps the partial file so the next call can resume', async (t) => {
  const content = Buffer.alloc(300 * 1024, 19);
  const slow = await startServer(t, { content, chunkSize: 16 * 1024, delayMs: 10 });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: slow.url });
  const controller = new AbortController();
  await assert.rejects(
    downloadModel(model, {
      destinationDir: dir,
      signal: controller.signal,
      onProgress: (progress) => { if (progress.received >= 32 * 1024) controller.abort(); },
    }),
    rejectsWith('aborted'),
  );
  const partPath = path.join(dir, model.file + '.part');
  const part = await stat(partPath);
  assert.ok(part.size > 0 && part.size < content.length);
  assert.equal(existsSync(path.join(dir, model.file)), false);

  const fast = await startServer(t, { content });
  const result = await downloadModel(modelFor(content, { url: fast.url }), { destinationDir: dir });
  assert.equal(result.resumed, true);
  assert.deepEqual(await readFile(result.path), content);
  assert.deepEqual((await readdir(dir)).sort(), [model.file]);
});

test('HTTP failures report a bounded status and never leak the response body', async (t) => {
  const content = Buffer.alloc(1024, 23);
  for (const [mode, status] of [['status', 500], ['not-found', 404]]) {
    const server = await startServer(t, { content, mode });
    const dir = await tempDir(t);
    const model = modelFor(content, { url: server.url });
    const error = await downloadModel(model, { destinationDir: dir }).then(() => null, (caught) => caught);
    assert.ok(error instanceof ModelDownloadError, mode);
    assert.equal(error.code, 'http-status', mode);
    assert.equal(error.status, status, mode);
    assert.ok(!error.message.includes(server.state.secret), mode);
    assert.deepEqual(await readdir(dir), [], mode);
  }
});

test('a complete partial file plus HTTP 416 still verifies and installs', async (t) => {
  const content = Buffer.alloc(48 * 1024, 29);
  const server = await startServer(t, { content, mode: 'reject-range' });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await writeFile(path.join(dir, model.file + '.part'), content);
  const result = await downloadModel(model, { destinationDir: dir });
  assert.equal(result.resumed, true);
  assert.equal(result.resumedFrom, content.length);
  assert.deepEqual(await readFile(result.path), content);
});

test('HTTP 416 with an incomplete partial file fails and keeps the partial', async (t) => {
  const content = Buffer.alloc(48 * 1024, 31);
  const server = await startServer(t, { content, mode: 'reject-range' });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await writeFile(path.join(dir, model.file + '.part'), Buffer.alloc(1024, 1));
  await assert.rejects(downloadModel(model, { destinationDir: dir }), rejectsWith('range-not-satisfiable'));
  assert.equal((await stat(path.join(dir, model.file + '.part'))).size, 1024);
  assert.equal(existsSync(path.join(dir, model.file)), false);
});

test('a dropped connection keeps the partial file for a later resume', async (t) => {
  const content = Buffer.alloc(200 * 1024, 37);
  const server = await startServer(t, { content, mode: 'reset' });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await assert.rejects(downloadModel(model, { destinationDir: dir }), rejectsWith('network-error'));
  const part = await stat(path.join(dir, model.file + '.part'));
  assert.ok(part.size > 0 && part.size < content.length);
  assert.equal(existsSync(path.join(dir, model.file)), false);
});

test('an insufficient disk space check fails before any request', async (t) => {
  const content = Buffer.alloc(4096, 41);
  const server = await startServer(t, { content });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await assert.rejects(
    downloadModel(model, { destinationDir: dir, statfsImpl: async () => ({ bavail: 0, bsize: 4096 }) }),
    rejectsWith('insufficient-space'),
  );
  assert.equal(server.state.requests, 0);
  assert.deepEqual(await readdir(dir), []);
});

test('invalid destinations and options are refused', async (t) => {
  const content = Buffer.alloc(1024, 43);
  const dir = await tempDir(t);
  const model = modelFor(content);
  await assert.rejects(downloadModel(model, { destinationDir: 'relative/dir' }), rejectsWith('invalid-destination'));
  const file = path.join(dir, 'not-a-dir');
  await writeFile(file, 'x');
  await assert.rejects(downloadModel(model, { destinationDir: file }), rejectsWith('invalid-destination'));
  await assert.rejects(downloadModel(model, { destinationDir: dir, extra: true }), rejectsWith('invalid-options'));
  const accessor = {};
  Object.defineProperty(accessor, 'destinationDir', { enumerable: true, get() { throw new Error('must not run'); } });
  await assert.rejects(downloadModel(model, accessor), rejectsWith('invalid-options'));
});

test('two downloads of the same target cannot run at once', async (t) => {
  const content = Buffer.alloc(300 * 1024, 47);
  const server = await startServer(t, { content, chunkSize: 8 * 1024, delayMs: 10 });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  const first = downloadModel(model, { destinationDir: dir });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(downloadModel(model, { destinationDir: dir }), rejectsWith('busy'));
  const result = await first;
  assert.deepEqual(await readFile(result.path), content);
});

test('a redirect to a real file is followed and verified', async (t) => {
  const content = Buffer.alloc(32 * 1024, 53);
  const server = await startServer(t, { content, mode: 'redirect' });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  const result = await downloadModel(model, { destinationDir: dir });
  assert.equal(server.state.requests, 2);
  assert.deepEqual(await readFile(result.path), content);
});

test('a final response URL that is not https or loopback is refused', async (t) => {
  const content = Buffer.from('payload');
  const dir = await tempDir(t);
  const model = modelFor(content);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: 'http://example.com/model.gguf',
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      },
    }),
  });
  await assert.rejects(downloadModel(model, { destinationDir: dir, fetchImpl }), rejectsWith('insecure-redirect'));
  assert.deepEqual(await readdir(dir), []);
});

test('verifyInstalledModel reports the state of a file without a request', async (t) => {
  const content = Buffer.alloc(8192, 59);
  const dir = await tempDir(t);
  const model = modelFor(content);
  await writeFile(path.join(dir, model.file), content);
  assert.deepEqual(await verifyInstalledModel(model, { destinationDir: dir }), {
    verified: true,
    path: path.join(dir, model.file),
    sizeBytes: content.length,
  });
  await writeFile(path.join(dir, model.file), Buffer.alloc(content.length, 61));
  assert.equal((await verifyInstalledModel(model, { destinationDir: dir })).verified, false);
});

test('errors never contain a credential from a refused URL', async (t) => {
  const content = Buffer.from('payload');
  const dir = await tempDir(t);
  const model = modelFor(content, { url: 'https://user:supersecret@example.com/x.gguf' });
    const error = await downloadModel(model, { destinationDir: dir }).then(() => null, (caught) => caught);
  assert.equal(error.code, 'invalid-model');
  assert.ok(!error.message.includes('supersecret'));
  assert.ok(!error.message.includes('user:'));
});

test('downloads require the destination directory to exist or be creatable', async (t) => {
  const content = Buffer.alloc(1024, 67);
  const server = await startServer(t, { content });
  const base = await tempDir(t);
  const dir = path.join(base, 'nested', 'models');
  const model = modelFor(content, { url: server.url });
  const result = await downloadModel(model, { destinationDir: dir });
  assert.deepEqual(await readFile(result.path), content);
  assert.ok((await stat(dir)).isDirectory());
});

test('an aborted signal is refused before any request', async (t) => {
  const content = Buffer.alloc(1024, 21);
  const server = await startServer(t, { content });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    downloadModel(model, { destinationDir: dir, signal: controller.signal }),
    rejectsWith('aborted'),
  );
  assert.equal(server.state.requests, 0);
  assert.deepEqual(await readdir(dir), []);
});

test('a stalled connection is timed out and keeps the partial file', async (t) => {
  const content = Buffer.alloc(64 * 1024, 22);
  const server = await startServer(t, { content, mode: 'stall' });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await assert.rejects(
    downloadModel(model, { destinationDir: dir, idleTimeoutMs: 200 }),
    rejectsWith('stalled'),
  );
  const part = await stat(path.join(dir, model.file + '.part'));
  assert.ok(part.size > 0 && part.size < content.length);
  assert.equal(existsSync(path.join(dir, model.file)), false);
});

test('an oversized response body fails with a size mismatch and installs nothing', async (t) => {
  const content = Buffer.alloc(32 * 1024, 23);
  const server = await startServer(t, { content, mode: 'excess' });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await assert.rejects(downloadModel(model, { destinationDir: dir }), rejectsWith('size-mismatch'));
  assert.deepEqual(await readdir(dir), []);
});

test('a progress callback that throws does not break the download', async (t) => {
  const content = Buffer.alloc(64 * 1024, 24);
  const server = await startServer(t, { content, chunkSize: 8 * 1024 });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  const result = await downloadModel(model, {
    destinationDir: dir,
    onProgress: () => { throw new Error('a panel redraw failed'); },
  });
  assert.equal(result.verified, true);
  assert.deepEqual(await readFile(result.path), content);
});

test('a final URL with a fragment or userinfo is refused', async (t) => {
  const content = Buffer.from('payload');
  const dir = await tempDir(t);
  const model = modelFor(content);
  const cases = [
    'https://example.com/model.gguf' + '#' + 'access_token=abc',
    'https://' + 'user' + ':' + 'pw' + '@example.com/model.gguf',
  ];
  for (const url of cases) {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      url,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(content);
          controller.close();
        },
      }),
    });
    const error = await downloadModel(model, { destinationDir: dir, fetchImpl }).then(() => null, (caught) => caught);
    assert.equal(error.code, 'insecure-redirect');
    assert.ok(!error.message.includes('abc'));
    assert.ok(!error.message.includes('user') && !error.message.includes('example.com'));
  }
  assert.deepEqual(await readdir(dir), []);
});

test('a signed CDN query on the final URL is accepted', async (t) => {
  const content = Buffer.from('payload');
  const dir = await tempDir(t);
  const model = modelFor(content);
  // Hugging Face redirects `resolve/` to `*.cdn.hf.co?Policy=...&Signature=...`; the bytes still have to
  // match the pinned digest, so the signature in the final URL is not a trust decision.
  const finalUrl = 'https://us.aws.cdn.hf.co/models/model.gguf' + '?Policy=p&Signature=s&Key-Pair-Id=k';
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: finalUrl,
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      },
    }),
  });
  const events = [];
  const result = await downloadModel(model, { destinationDir: dir, fetchImpl, onProgress: (event) => events.push(event) });
  assert.deepEqual(await readFile(result.path), content);
  assert.equal(result.verified, true);
  assert.ok(events.length > 0);
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['received', 'resumedFrom', 'total']);
  const serialized = JSON.stringify(result) + JSON.stringify(events);
  assert.ok(!serialized.includes('us.aws.cdn.hf.co') && !serialized.includes('Signature'));
});

test('a symlinked destination or partial file is refused', async (t) => {
  const content = Buffer.alloc(1024, 25);
  const server = await startServer(t, { content });
  const base = await tempDir(t);
  const real = path.join(base, 'real-models');
  mkdirSync(real);
  const link = path.join(base, 'link-models');
  try {
    symlinkSync(real, link, 'junction');
  } catch {
    t.skip('this host does not allow creating a junction without elevation');
    return;
  }
  const model = modelFor(content, { url: server.url });
  await assert.rejects(downloadModel(model, { destinationDir: link }), rejectsWith('invalid-destination'));
  const outside = path.join(base, 'outside.gguf.part');
  await writeFile(outside, Buffer.from('not ours'));
  symlinkSync(outside, path.join(real, model.file + '.part'));
  await assert.rejects(downloadModel(model, { destinationDir: real }), rejectsWith('unsafe-path'));
});

test('a symlinked final file is refused', async (t) => {
  const content = Buffer.alloc(1024, 26);
  const server = await startServer(t, { content });
  const base = await tempDir(t);
  const dir = path.join(base, 'models');
  mkdirSync(dir);
  const outside = path.join(base, 'outside.gguf');
  await writeFile(outside, content);
  const model = modelFor(content, { url: server.url });
  try {
    symlinkSync(outside, path.join(dir, model.file), 'file');
  } catch {
    t.skip('this host does not allow creating a file symlink without elevation');
    return;
  }
  await assert.rejects(downloadModel(model, { destinationDir: dir }), rejectsWith('unsafe-path'));
  assert.equal(server.state.requests, 0);
});

test('a transfer that outlives the total deadline fails as timeout', async (t) => {
  const content = Buffer.alloc(64 * 1024, 27);
  const server = await startServer(t, { content, chunkSize: 8 * 1024, delayMs: 250 });
  const dir = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  await assert.rejects(
    downloadModel(model, { destinationDir: dir, totalTimeoutMs: 1000 }),
    rejectsWith('timeout'),
  );
  assert.equal(existsSync(path.join(dir, model.file)), false);
});

test('a loopback plain-http final URL is refused when the pinned URL is https', async (t) => {
  const content = Buffer.from('payload');
  const dir = await tempDir(t);
  const model = modelFor(content);
  const loopbackUrl = 'http://' + ['127', '0', '0', '1'].join('.') + ':9/model.gguf';
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: loopbackUrl,
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      },
    }),
  });
  await assert.rejects(downloadModel(model, { destinationDir: dir, fetchImpl }), rejectsWith('insecure-redirect'));
  assert.deepEqual(await readdir(dir), []);
});

test('a junction above a missing destination is refused', async (t) => {
  const content = Buffer.alloc(1024, 28);
  const server = await startServer(t, { content });
  const base = await tempDir(t);
  const real = path.join(base, 'real');
  mkdirSync(real);
  const link = path.join(base, 'link');
  try {
    symlinkSync(real, link, 'junction');
  } catch {
    t.skip('this host does not allow creating a junction without elevation');
    return;
  }
  const model = modelFor(content, { url: server.url });
  await assert.rejects(
    downloadModel(model, { destinationDir: path.join(link, 'new', 'models') }),
    rejectsWith('invalid-destination'),
  );
  assert.equal(existsSync(path.join(real, 'new')), false);
  assert.equal(server.state.requests, 0);
});

test('a reserved Win32 destination name is refused', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the reserved-name rule is Win32-only');
    return;
  }
  const content = Buffer.alloc(1024, 29);
  const server = await startServer(t, { content });
  const base = await tempDir(t);
  const model = modelFor(content, { url: server.url });
  for (const name of ['CON', 'nul', 'com1']) {
    await assert.rejects(
      downloadModel(model, { destinationDir: path.join(base, name) }),
      rejectsWith('invalid-destination'),
    );
  }
  assert.equal(server.state.requests, 0);
});
