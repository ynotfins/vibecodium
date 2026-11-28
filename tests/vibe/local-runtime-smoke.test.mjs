import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EMBEDDING_SERVER_ARGS } from '../../src/stable/runtime/first-run.mjs';
import {
  SMOKE_MARKER,
  parseArgs,
  prepareSmokeDirectory,
  runCli,
  runSmoke,
} from '../../vibe/tools/local-runtime-smoke.mjs';

const API_KEY = 'smoke-test-key-' + 'k'.repeat(32);

async function tempRoot(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibecodium-smoke-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeSidecar() {
  return Object.freeze({
    id: 'llama-server',
    version: 'b12426',
    targets: { [process.platform + '-' + process.arch]: { executable: 'llama-server.exe' } },
  });
}

function fakeModel(id, role) {
  return Object.freeze({ id, file: id + '.gguf', role });
}

function fakeServer(log) {
  const state = { state: 'stopped' };
  return {
    start: async () => { state.state = 'running'; log.push('start'); return { state: 'running', port: 41000, baseUrl: 'http://127.0.0.1:41000/v1' }; },
    health: async () => ({ ok: true, status: 200 }),
    auth: () => ({ apiKey: API_KEY }),
    status: () => ({ state: state.state }),
    stop: async () => { state.state = 'stopped'; log.push('stop'); return { stopped: true }; },
  };
}

function fakeClient(log) {
  return {
    chat: async (request) => {
      log.push(request.stream === true ? 'chat-stream' : request.tools ? 'chat-tools' : 'chat');
      if (request.tools) return { text: '{"name":"lookup"}', toolCalls: [] };
      return { text: 'pong', toolCalls: [] };
    },
    embeddings: async () => {
      log.push('embeddings');
      const unit = (axis) => Array.from({ length: 1024 }, (_, index) => (index === axis ? 1 : 0));
      return { vectors: [unit(0), unit(1)] };
    },
  };
}

function fakes(overrides = {}) {
  const log = [];
  const lines = [];
  const calls = { downloads: [], installs: [], servers: [] };
  const deps = {
    loadManifest: () => ({ sidecars: [fakeSidecar()] }),
    findSidecar: () => fakeSidecar(),
    verifySidecar: async () => ({ verified: false }),
    installSidecar: async () => { calls.installs.push('llama-server'); return { version: 'b12426', sizeBytes: 1 }; },
    loadCatalog: () => ({ models: [fakeModel('qwen2.5-coder-1.5b-q4-k-m', 'chat'), fakeModel('qwen3-embedding-0.6b-q8-0', 'embedding')] }),
    findModel: (catalog, id) => catalog.models.find((model) => model.id === id) ?? null,
    verifyModel: async (model) => ({ verified: false, path: path.join('models', model.file), sizeBytes: 1 }),
    downloadModel: async (model) => { calls.downloads.push(model.id); return { verified: true, path: path.join('models', model.file), sizeBytes: 1 }; },
    createServer: (options) => { calls.servers.push(options); return fakeServer(log); },
    createClient: () => fakeClient(log),
    fetchImpl: async (url, init) => ({ status: init && init.headers ? 200 : 401 }),
    remove: async (target) => { log.push('remove ' + path.basename(target)); },
    print: (line) => lines.push(line),
    ...overrides,
  };
  return { deps, log, lines, calls };
}

test('parseArgs fills defaults and resolves flags', () => {
  const defaults = parseArgs([]);
  assert.equal(path.basename(defaults.dir), 'vibecodium-local-smoke');
  assert.equal(defaults.keep, false);
  assert.equal(defaults.chatOnly, false);
  assert.equal(defaults.help, false);
  assert.equal(defaults.contextSize, 4096);
  assert.ok(defaults.threads >= 1 && defaults.threads <= 16);

  const parsed = parseArgs([
    '--dir', '.', '--keep', '--chat-only', '--threads', '3', '--context-size', '8192',
    '--sidecar', 's', '--chat-model', 'c', '--embedding-model', 'e',
  ]);
  assert.equal(parsed.dir, path.resolve('.'));
  assert.equal(parsed.keep, true);
  assert.equal(parsed.chatOnly, true);
  assert.equal(parsed.threads, 3);
  assert.equal(parsed.contextSize, 8192);
  assert.equal(parsed.sidecarId, 's');
  assert.equal(parsed.chatModelId, 'c');
  assert.equal(parsed.embeddingModelId, 'e');
  assert.equal(parseArgs(['--help']).help, true);

  for (const argv of [
    ['--bogus'], ['--dir'], ['--threads', '0'], ['--threads', '65'], ['--threads', 'two'],
    ['--context-size', '1'], ['--keep', '--nope'],
  ]) {
    assert.throws(() => parseArgs(argv), (error) => error.code === 'invalid-argument');
  }
});

test('prepareSmokeDirectory creates a marked directory and refuses a foreign one', async (t) => {
  const root = await tempRoot(t);
  const dir = path.join(root, 'smoke');
  await prepareSmokeDirectory(dir);
  assert.equal(existsSync(path.join(dir, SMOKE_MARKER)), true);
  await prepareSmokeDirectory(dir);

  const foreign = path.join(root, 'foreign');
  await mkdir(foreign);
  await writeFile(path.join(foreign, 'notes.txt'), 'not ours\n');
  await assert.rejects(prepareSmokeDirectory(foreign), (error) => error.code === 'unsafe-directory');
  assert.deepEqual(await readdir(foreign), ['notes.txt']);
  assert.equal((await readFile(path.join(foreign, 'notes.txt'), 'utf8')), 'not ours\n');

  const emptyForeign = path.join(root, 'empty-foreign');
  await mkdir(emptyForeign);
  await assert.rejects(prepareSmokeDirectory(emptyForeign), (error) => error.code === 'unsafe-directory');
  assert.deepEqual(await readdir(emptyForeign), []);

  const filePath = path.join(root, 'not-a-directory');
  await writeFile(filePath, 'x\n');
  await assert.rejects(prepareSmokeDirectory(filePath), (error) => error.code === 'unsafe-directory');
});

test('runSmoke passes the full chat and embedding flow and cleans up', async (t) => {
  const root = await tempRoot(t);
  const { deps, log, lines, calls } = fakes();
  const report = await runSmoke({ dir: path.join(root, 'smoke') }, deps);

  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((step) => step.name), [
    'directory', 'manifest', 'sidecar', 'chat-model', 'server-start', 'health', 'auth',
    'chat', 'chat-stream', 'tools-request', 'server-stop',
    'embedding-model', 'embedding-start', 'embeddings', 'embedding-stop', 'cleanup',
  ]);
  assert.ok(report.steps.every((step) => step.ok === true));
  assert.deepEqual(calls.installs, ['llama-server']);
  assert.deepEqual(calls.downloads, ['qwen2.5-coder-1.5b-q4-k-m', 'qwen3-embedding-0.6b-q8-0']);
  assert.deepEqual(log, [
    'start', 'chat', 'chat-stream', 'chat-tools', 'stop',
    'start', 'embeddings', 'stop',
    'remove runtime', 'remove models', 'remove .vibecodium-local-smoke',
  ]);

  const embedding = calls.servers[1];
  assert.deepEqual([...embedding.commandArgs], [...EMBEDDING_SERVER_ARGS]);
  assert.equal(path.basename(calls.servers[0].executablePath), 'llama-server.exe');
  assert.equal(report.artifacts.removed, true);

  assert.match(lines.at(-1), /^SMOKE_RESULT=PASS /);
  for (const line of lines) {
    assert.ok(!line.includes(API_KEY), 'the API key never reaches the output');
  }
});

test('runSmoke stops after a failed model download, keeps artifacts and skips cleanup', async (t) => {
  const root = await tempRoot(t);
  const { deps, log } = fakes({
    downloadModel: async () => { const error = new Error('the download did not end on a validated URL'); error.code = 'insecure-redirect'; throw error; },
  });
  const report = await runSmoke({ dir: path.join(root, 'smoke') }, deps);

  assert.equal(report.ok, false);
  const failed = report.steps.filter((step) => step.ok === false);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, 'chat-model');
  assert.equal(failed[0].detail.code, 'insecure-redirect');
  assert.ok(report.steps.every((step) => ['directory', 'manifest', 'sidecar', 'chat-model'].includes(step.name)));
  assert.deepEqual(log, [], 'the server is never created and nothing is removed');
  assert.equal(report.artifacts.dir, path.join(root, 'smoke'));
});

test('runSmoke reports a refused directory as the failing step', async (t) => {
  const root = await tempRoot(t);
  const foreign = path.join(root, 'foreign');
  await mkdir(foreign);
  await writeFile(path.join(foreign, 'keep.txt'), 'keep\n');
  const { deps } = fakes();
  const report = await runSmoke({ dir: foreign }, deps);

  assert.equal(report.ok, false);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].name, 'directory');
  assert.equal(report.steps[0].detail.code, 'unsafe-directory');
  assert.equal((await readFile(path.join(foreign, 'keep.txt'), 'utf8')), 'keep\n');
});

test('runSmoke fails the auth step when the real server accepts a keyless request', async (t) => {
  const root = await tempRoot(t);
  const { deps } = fakes({ fetchImpl: async () => ({ status: 200 }) });
  const report = await runSmoke({ dir: path.join(root, 'smoke'), keep: true, chatOnly: true }, deps);

  assert.equal(report.ok, false);
  const auth = report.steps.find((step) => step.name === 'auth');
  assert.equal(auth.ok, false);
  assert.equal(auth.detail.code, 'auth-not-enforced');
  assert.equal(report.steps.some((step) => step.name === 'chat'), false);
  assert.equal(report.artifacts.dir, path.join(root, 'smoke'));
});

test('runSmoke skips the embedding flow with chatOnly and keeps artifacts when asked', async (t) => {
  const root = await tempRoot(t);
  const { deps, log } = fakes();
  const report = await runSmoke({ dir: path.join(root, 'smoke'), chatOnly: true, keep: true }, deps);

  assert.equal(report.ok, true);
  assert.equal(report.steps.some((step) => step.name.startsWith('embedding')), false);
  assert.deepEqual(log, ['start', 'chat', 'chat-stream', 'chat-tools', 'stop']);
  assert.equal(report.artifacts.dir, path.join(root, 'smoke'));
  assert.equal(existsSync(path.join(root, 'smoke', SMOKE_MARKER)), true);
});

test('runSmoke attributes a stop failure and reports FAIL', async (t) => {
  const root = await tempRoot(t);
  const server = { ...fakeServer([]), stop: async () => ({ stopped: false }) };
  const { deps } = fakes({ createServer: () => server });
  const report = await runSmoke({ dir: path.join(root, 'smoke'), keep: true, chatOnly: true }, deps);

  assert.equal(report.ok, false);
  const stop = report.steps.find((step) => step.name === 'server-stop');
  assert.equal(stop.ok, false);
  assert.equal(stop.detail.code, 'server-not-stopped');
});

test('runCli prints usage for --help and returns a passing report', async (t) => {
  const root = await tempRoot(t);
  const lines = [];
  const help = await runCli(['--help'], { print: (line) => lines.push(line) });
  assert.equal(help.help, true);
  assert.equal(help.ok, true);

  const { deps } = fakes();
  const report = await runCli(['--dir', path.join(root, 'smoke'), '--chat-only'], deps);
  assert.equal(report.ok, true);
  await assert.rejects(runCli(['--nope'], deps), (error) => error.code === 'invalid-argument');
});
