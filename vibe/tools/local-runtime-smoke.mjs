#!/usr/bin/env node
// M3 live local-runtime smoke.
//
// Opt-in, not part of `verify.mjs`: it needs the network, about 1.8 GB of free disk and a few
// minutes. It proves the shipped local-runtime path end to end on the machine it runs on:
//
//   1. the pinned `llama-server` sidecar installs from its pinned archive and verifies by digest;
//   2. the chat model downloads from its pinned catalog URL and verifies by size and SHA-256;
//   3. the supervisor starts the real binary on loopback, answers health, and the `LLAMA_API_KEY`
//      the supervisor generates is enforced (401 without it, 200 with it);
//   4. the B1 `llama-cpp` client can chat, stream and send a tool definition;
//   5. the embedding model downloads, and the embedding server tuple from `first-run.mjs` serves
//      unit-length vectors.
//
//   node vibe/tools/local-runtime-smoke.mjs [--dir <path>] [--keep] [--chat-only] [--threads <n>]
//
// The working directory must be missing or a directory a previous smoke created (it carries a marker
// file); an existing unmarked directory is refused even when empty, so a mistyped `--dir` can never be
// adopted or deleted. Artifacts are removed after a PASS
// unless `--keep` is given; a FAIL keeps them for inspection. Secrets are never printed: the model
// API key and the signed CDN URL stay out of the report.

import { lstat, mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createProviderClient } from '../../src/stable/gateway/provider-client.mjs';
import { EMBEDDING_SERVER_ARGS } from '../../src/stable/runtime/first-run.mjs';
import { createLlamaServer } from '../../src/stable/runtime/llama-server.mjs';
import {
  downloadModel,
  findCatalogModel,
  loadCatalogFile,
  verifyInstalledModel,
} from '../../src/stable/runtime/model-downloader.mjs';
import {
  findSidecar,
  installSidecar,
  loadSidecarManifestFile,
  verifySidecarInstall,
} from '../../src/stable/runtime/sidecar.mjs';

export const SMOKE_MARKER = '.vibecodium-local-smoke';
export const DEFAULT_SIDECAR_ID = 'llama-server';
export const DEFAULT_CHAT_MODEL_ID = 'qwen2.5-coder-1.5b-q4-k-m';
export const DEFAULT_EMBEDDING_MODEL_ID = 'qwen3-embedding-0.6b-q8-0';
export const DEFAULT_CONTEXT_SIZE = 4096;
export const MIN_THREADS = 1;
export const MAX_THREADS = 64;
export const MIN_CONTEXT_SIZE = 128;
export const MAX_CONTEXT_SIZE = 1_048_576;
export const MAX_STEP_DETAIL_CHARS = 240;
export const AUTH_PATH = '/props';
export const CHAT_MESSAGES = Object.freeze([{ role: 'user', content: 'Reply with the single word: pong' }]);
export const TOOL_DEFINITIONS = Object.freeze([Object.freeze({
  type: 'function',
  function: Object.freeze({
    name: 'lookup',
    description: 'Look up a fact',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({ q: Object.freeze({ type: 'string' }) }),
      required: Object.freeze(['q']),
    }),
  }),
})]);

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MANIFEST_FILE = path.join(REPO_ROOT, 'vibe', 'sidecars.json');
const CATALOG_FILE = path.join(REPO_ROOT, 'vibe', 'models', 'catalog.json');

class SmokeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SmokeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SmokeError(code, message);
}

function expect(condition, code, message) {
  if (!condition) fail(code, message);
}

function integerFlag(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('invalid-argument', `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function summarize(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'failed';
  const message = String(error && error.message ? error.message : error);
  return { code, message: message.slice(0, MAX_STEP_DETAIL_CHARS) };
}

export function parseArgs(argv) {
  const options = {
    dir: path.join(os.tmpdir(), 'vibecodium-local-smoke'),
    keep: false,
    chatOnly: false,
    help: false,
    threads: Math.min(16, Math.max(MIN_THREADS, os.cpus().length - 2)),
    contextSize: DEFAULT_CONTEXT_SIZE,
    sidecarId: DEFAULT_SIDECAR_ID,
    chatModelId: DEFAULT_CHAT_MODEL_ID,
    embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
  };
  const withValue = new Set(['--dir', '--threads', '--context-size', '--sidecar', '--chat-model', '--embedding-model']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') { options.keep = true; continue; }
    if (flag === '--chat-only') { options.chatOnly = true; continue; }
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!withValue.has(flag)) fail('invalid-argument', `unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('invalid-argument', `${flag} needs a value`);
    index += 1;
    if (flag === '--dir') options.dir = path.resolve(value);
    if (flag === '--threads') options.threads = integerFlag(value, 'threads', MIN_THREADS, MAX_THREADS);
    if (flag === '--context-size') options.contextSize = integerFlag(value, 'contextSize', MIN_CONTEXT_SIZE, MAX_CONTEXT_SIZE);
    if (flag === '--sidecar') options.sidecarId = value;
    if (flag === '--chat-model') options.chatModelId = value;
    if (flag === '--embedding-model') options.embeddingModelId = value;
  }
  return Object.freeze(options);
}

export async function prepareSmokeDirectory(dir) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stat = await lstat(dir).catch(() => null);
    if (stat === null) {
      try {
        await mkdir(dir);
      } catch (error) {
        if (error.code !== 'EEXIST') fail('unsafe-directory', 'the working directory could not be created');
        continue;
      }
      try {
        await writeFile(path.join(dir, SMOKE_MARKER), 'created by vibe/tools/local-runtime-smoke.mjs\n');
      } catch {
        await rmdir(dir).catch(() => undefined);
        fail('unsafe-directory', 'the working directory could not be marked');
      }
      return dir;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('unsafe-directory', 'the working directory must be a real directory, not a link or a file');
    }
    const entries = await readdir(dir);
    if (!entries.includes(SMOKE_MARKER)) {
      fail('unsafe-directory', 'refusing to use a directory this smoke did not create; pass a missing --dir or one carrying ' + SMOKE_MARKER);
    }
    return dir;
  }
  fail('unsafe-directory', 'the working directory could not be created');
}

function defaultDependencies() {
  return {
    loadManifest: loadSidecarManifestFile,
    findSidecar,
    verifySidecar: verifySidecarInstall,
    installSidecar,
    loadCatalog: loadCatalogFile,
    findModel: findCatalogModel,
    verifyModel: verifyInstalledModel,
    downloadModel,
    createServer: createLlamaServer,
    createClient: createProviderClient,
    fetchImpl: globalThis.fetch,
    remove: rm,
    print: (line) => console.log(line),
  };
}

export async function runSmoke(options = {}, overrides = {}) {
  // Direct callers (tests, other tools) may pass a partial object; fill the same defaults the CLI uses.
  options = Object.freeze({ ...parseArgs([]), ...options });
  const deps = { ...defaultDependencies(), ...overrides };
  const startedAt = Date.now();
  const steps = [];
  const runtimeDir = path.join(options.dir, 'runtime');
  const modelsDir = path.join(options.dir, 'models');
  let ok = true;

  const run = async (name, fn) => {
    const begin = Date.now();
    try {
      const value = await fn();
      const detail = value === undefined ? {} : value;
      steps.push(Object.freeze({ name, ok: true, detail: Object.freeze(detail), seconds: ((Date.now() - begin) / 1000).toFixed(1) }));
      deps.print(`PASS ${name} ${((Date.now() - begin) / 1000).toFixed(1)}s ${JSON.stringify(detail)}`);
      return value;
    } catch (error) {
      steps.push(Object.freeze({ name, ok: false, detail: Object.freeze(summarize(error)), seconds: ((Date.now() - begin) / 1000).toFixed(1) }));
      deps.print(`FAIL ${name} ${((Date.now() - begin) / 1000).toFixed(1)}s ${JSON.stringify(summarize(error))}`);
      throw error;
    }
  };

  const settle = (promise) => promise.then(() => true, () => false);

  try {
    await run('directory', async () => {
      await prepareSmokeDirectory(options.dir);
      return { dir: options.dir };
    });

    let selection = null;
    await run('manifest', async () => {
      const sidecar = deps.findSidecar(deps.loadManifest(MANIFEST_FILE), options.sidecarId);
      expect(sidecar !== null && sidecar !== undefined, 'missing-sidecar', `${options.sidecarId} is not in the manifest`);
      const platformKey = process.platform + '-' + process.arch;
      const target = sidecar.targets ? sidecar.targets[platformKey] : null;
      expect(target !== null && target !== undefined, 'unsupported-platform', `the sidecar has no ${platformKey} target`);
      selection = { sidecar, executablePath: path.join(runtimeDir, target.executable), version: sidecar.version };
      return { sidecarId: sidecar.id, version: sidecar.version, platform: platformKey, executable: target.executable };
    });

    await run('sidecar', async () => {
      const verified = await deps.verifySidecar(selection.sidecar, { targetDir: runtimeDir });
      if (verified.verified === true) return { verified: true, installed: false, version: selection.version };
      const installed = await deps.installSidecar(selection.sidecar, { targetDir: runtimeDir });
      return { verified: true, installed: true, version: installed.version ?? selection.version, sizeBytes: installed.sizeBytes };
    });

    const chatModel = await run('chat-model', async () => {
      const model = deps.findModel(deps.loadCatalog(CATALOG_FILE), options.chatModelId);
      expect(model !== null && model !== undefined, 'missing-model', `${options.chatModelId} is not in the catalog`);
      const verified = await deps.verifyModel(model, { destinationDir: modelsDir });
      if (verified.verified === true) return { verified: true, downloaded: false, path: verified.path, sizeBytes: verified.sizeBytes };
      const downloaded = await deps.downloadModel(model, { destinationDir: modelsDir });
      expect(downloaded.verified === true, 'model-not-verified', 'the chat model did not verify after the download');
      return { verified: true, downloaded: true, path: downloaded.path, sizeBytes: downloaded.sizeBytes };
    });

    const serverOptions = (modelPath, extra = {}) => ({
      executablePath: selection.executablePath,
      modelPath,
      threads: options.threads,
      gpuLayers: 0,
      startupTimeoutMs: 120000,
      stopTimeoutMs: 10000,
      ...extra,
    });

    const server = deps.createServer(serverOptions(chatModel.path, { contextSize: options.contextSize }));
    try {
      const running = await run('server-start', async () => {
        const status = await server.start();
        expect(status.state === 'running', 'server-not-running', 'the supervisor did not reach the running state');
        return { state: status.state, port: status.port, baseUrl: status.baseUrl };
      });
      await run('health', () => server.health());
      const apiKey = server.auth().apiKey;
      await run('auth', async () => {
        const root = running.baseUrl.replace(/\/v1$/, '');
        const denied = await deps.fetchImpl(root + AUTH_PATH, { redirect: 'error' });
        const allowed = await deps.fetchImpl(root + AUTH_PATH, { redirect: 'error', headers: { authorization: 'Bearer ' + apiKey } });
        expect(denied.status === 401, 'auth-not-enforced', 'the server answered without the supervisor key');
        expect(allowed.status === 200, 'auth-rejected', 'the server rejected the supervisor key');
        return { withoutKey: denied.status, withKey: allowed.status };
      });
      const client = deps.createClient('llama-cpp', {
        baseUrl: running.baseUrl, model: options.chatModelId, apiKey, env: {},
      });
      const plain = await run('chat', async () => {
        const answer = await client.chat({ messages: CHAT_MESSAGES, maxTokens: 16 });
        const text = answer.text.trim();
        expect(text.length > 0, 'empty-chat', 'the model returned no text');
        return { textChars: text.length, sample: text.slice(0, 32) };
      });
      await run('chat-stream', async () => {
        const answer = await client.chat({ messages: CHAT_MESSAGES, maxTokens: 16, stream: true });
        const text = answer.text.trim();
        expect(text.length > 0, 'empty-stream', 'the streamed answer was empty');
        return { textChars: text.length, sameAsPlain: text === plain.sample };
      });
      await run('tools-request', async () => {
        const answer = await client.chat({
          messages: [{ role: 'user', content: 'Use the lookup tool to find x.' }],
          tools: TOOL_DEFINITIONS,
          maxTokens: 64,
        });
        // A 1.5B model may describe the call in prose instead of emitting `tool_calls`. The smoke
        // proves the request shape is accepted on the real server and reports what came back.
        expect(answer.text.trim().length > 0 || answer.toolCalls.length > 0, 'empty-tool-answer', 'the tool request returned nothing');
        return { toolCalls: answer.toolCalls.length, textChars: answer.text.trim().length };
      });
    } finally {
      if ((await settle(run('server-stop', async () => {
        const stopped = await server.stop();
        expect(stopped.stopped === true, 'server-not-stopped', 'the supervisor did not stop the server');
        return { stopped: true, state: server.status().state };
      }))) === false) ok = false;
    }

    if (options.chatOnly !== true) {
      const embeddingModel = await run('embedding-model', async () => {
        const model = deps.findModel(deps.loadCatalog(CATALOG_FILE), options.embeddingModelId);
        expect(model !== null && model !== undefined, 'missing-model', `${options.embeddingModelId} is not in the catalog`);
        const verified = await deps.verifyModel(model, { destinationDir: modelsDir });
        if (verified.verified === true) return { verified: true, downloaded: false, path: verified.path, sizeBytes: verified.sizeBytes };
        const downloaded = await deps.downloadModel(model, { destinationDir: modelsDir });
        expect(downloaded.verified === true, 'model-not-verified', 'the embedding model did not verify after the download');
        return { verified: true, downloaded: true, path: downloaded.path, sizeBytes: downloaded.sizeBytes };
      });
      const embeddingServer = deps.createServer(serverOptions(embeddingModel.path, { commandArgs: EMBEDDING_SERVER_ARGS }));
      try {
        const running = await run('embedding-start', async () => {
          const status = await embeddingServer.start();
          expect(status.state === 'running', 'server-not-running', 'the embedding server did not start');
          return { state: status.state, port: status.port, baseUrl: status.baseUrl };
        });
        const client = deps.createClient('llama-cpp', {
          baseUrl: running.baseUrl, model: options.embeddingModelId, apiKey: embeddingServer.auth().apiKey, env: {},
        });
        await run('embeddings', async () => {
          const answer = await client.embeddings({ input: ['hello world', 'second text'] });
          expect(answer.vectors.length === 2, 'embedding-count', 'expected one vector per input');
          const dims = answer.vectors[0].length;
          // Qwen3-Embedding-0.6B-Q8_0, the pinned catalog entry, is a 1024-dimension model.
          expect(dims === 1024, 'embedding-dims', 'expected 1024-dimensional vectors for the pinned embedding model');
          const norm = Math.hypot(...answer.vectors[0]);
          expect(Math.abs(norm - 1) < 1e-3, 'embedding-norm', 'the vectors are not unit length');
          return { vectors: answer.vectors.length, dims, norm: Number(norm.toFixed(4)) };
        });
      } finally {
        if ((await settle(run('embedding-stop', async () => {
          const stopped = await embeddingServer.stop();
          expect(stopped.stopped === true, 'server-not-stopped', 'the embedding server did not stop');
          return { stopped: true };
        }))) === false) ok = false;
      }
    }
  } catch {
    ok = false;
  } finally {
    if (ok === true && options.keep !== true) {
      ok = await settle(run('cleanup', async () => {
        for (const owned of [runtimeDir, modelsDir, path.join(options.dir, SMOKE_MARKER)]) {
          await deps.remove(owned, { recursive: true, force: true, maxRetries: 2 });
        }
        await rmdir(options.dir).catch(() => undefined);
        return { removed: true };
      }));
    }
  }

  const elapsedMs = Date.now() - startedAt;
  deps.print(`SMOKE_RESULT=${ok === true ? 'PASS' : 'FAIL'} ${(elapsedMs / 1000).toFixed(1)}s`);
  return Object.freeze({
    ok: ok === true,
    elapsedMs,
    steps: Object.freeze(steps),
    artifacts: ok === true && options.keep !== true
      ? Object.freeze({ removed: true })
      : Object.freeze({ dir: options.dir, runtimeDir, modelsDir }),
  });
}

const USAGE = [
  'usage: node vibe/tools/local-runtime-smoke.mjs [options]',
  '',
  '  --dir <path>            working directory (default: <tmp>/vibecodium-local-smoke)',
  '  --keep                  keep the installed sidecar and models after a PASS',
  '  --chat-only             skip the embedding model and embedding server',
  '  --threads <n>           llama-server threads (default: cores - 2, capped at 16)',
  '  --context-size <n>      chat context in tokens (default: 4096)',
  '  --sidecar <id>          sidecar id from vibe/sidecars.json',
  '  --chat-model <id>       chat model id from vibe/models/catalog.json',
  '  --embedding-model <id>  embedding model id from vibe/models/catalog.json',
].join('\n');

export async function runCli(argv = process.argv.slice(2), overrides = {}) {
  const options = parseArgs(argv);
  if (options.help === true) {
    console.log(USAGE);
    return Object.freeze({ ok: true, help: true });
  }
  return runSmoke(options, overrides);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runCli();
    if (report.help !== true && report.ok !== true) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
