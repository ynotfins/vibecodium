import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ProjectIndex } from '../../src/stable/index-engine/index-engine.mjs';
import {
  DEFAULT_LSP_TIMEOUT_MS,
  LSP_PROVIDER_ID,
  MAX_LSP_MESSAGE_BYTES,
  createLspSymbolProvider,
  sanitizeLspEnvironment,
} from '../../src/stable/index-engine/lsp-provider.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'repo-ts');
const MOCK = path.join(REPO_ROOT, 'tests', 'fixtures', 'mock-lsp-server.mjs');
const MIDDLEWARE = 'src/auth/middleware.ts';

const performanceNow = () => Number(process.hrtime.bigint()) / 1e6;
async function copyFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-lsp-'));
  const root = path.join(dir, 'repo-ts');
  await cp(FIXTURE, root, { recursive: true, dereference: false });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, root };
}

function mockProvider(root, mode = 'document-symbols', options = {}) {
  const { env: envOverrides, ...rest } = options;
  return createLspSymbolProvider({
    command: process.execPath,
    args: [MOCK],
    cwd: root,
    rootUri: pathToFileURL(root).href,
    timeoutMs: 3_000,
    env: { VIBE_MOCK_MODE: mode, ...(envOverrides ?? {}) },
    ...rest,
  });
}

function byKey(symbols) {
  return new Map(symbols.map((symbol) => [`${symbol.name}:${symbol.kind}:${symbol.container ?? ''}`, symbol]));
}

test('extracts document symbols and nested containers from a stdio language server', async (t) => {
  const { root } = await copyFixture(t);
  const provider = mockProvider(root);
  t.after(() => provider.close());

  assert.equal(provider.id, LSP_PROVIDER_ID);
  assert.equal(DEFAULT_LSP_TIMEOUT_MS, 5_000);
  assert.equal(MAX_LSP_MESSAGE_BYTES, 8_000_000);

  const symbols = await provider.extract('', { filePath: MIDDLEWARE, maxSymbols: 100 });
  const found = byKey(symbols);
  assert.ok(found.has('AuthContext:interface:'), [...found.keys()].join(', '));
  assert.ok(found.has('AuthMiddleware:class:'), [...found.keys()].join(', '));
  assert.ok(found.has('constructor:constructor:AuthMiddleware'), [...found.keys()].join(', '));
  assert.ok(found.has('handle:method:AuthMiddleware'), [...found.keys()].join(', '));
  assert.ok(found.has('size:getter:AuthMiddleware'), [...found.keys()].join(', '));
  assert.ok(found.has('requireUser:function:'), [...found.keys()].join(', '));
  assert.ok(found.has('authHeader:variable:'), [...found.keys()].join(', '));
  assert.equal(found.get('AuthMiddleware:class:').line, 5);
  assert.equal(found.get('AuthMiddleware:class:').column, 1);
  assert.deepEqual(symbols, [...symbols].sort((left, right) =>
    left.line - right.line || left.column - right.column || left.name.localeCompare(right.name)));
  await provider.close();
});

test('accepts SymbolInformation arrays and carries containerName', async (t) => {
  const { root } = await copyFixture(t);
  const provider = mockProvider(root, 'symbol-information');
  t.after(() => provider.close());

  const symbols = await provider.extract('', { filePath: MIDDLEWARE, maxSymbols: 100 });
  const found = byKey(symbols);
  assert.ok(found.has('AuthMiddleware:class:'), [...found.keys()].join(', '));
  assert.ok(found.has('handle:method:AuthMiddleware'), [...found.keys()].join(', '));
  assert.ok(found.has('requireUser:function:'), [...found.keys()].join(', '));
  await provider.close();
});

test('ProjectIndex consumes an asynchronous provider and persists its id', async (t) => {
  const { root } = await copyFixture(t);
  const provider = mockProvider(root);
  t.after(() => provider.close());

  const index = new ProjectIndex(root, { symbolProvider: provider, persist: false });
  const report = await index.refresh();
  assert.equal(report.index.provider, LSP_PROVIDER_ID);
  assert.ok(report.index.symbols.some((symbol) => symbol.name === 'AuthMiddleware' && symbol.kind === 'class'));
  assert.ok(report.index.symbols.some((symbol) =>
    symbol.name === 'handle' && symbol.kind === 'method' && symbol.container === 'AuthMiddleware'));
  assert.ok(report.index.symbols.some((symbol) => symbol.name === 'slugify' && symbol.kind === 'function'));
  assert.ok(index.searchText('authheader').length > 0);
  await provider.close();
});

test('filters secret-looking environment variables from the server process', async (t) => {
  const { dir, root } = await copyFixture(t);
  const probe = path.join(dir, 'env-probe.txt');
  const saved = process.env.VIBE_TEST_SECRET;
  process.env.VIBE_TEST_SECRET = 'test-marker-not-a-real-secret';
  const provider = mockProvider(root, 'symbol-information', {
    env: {
      VIBE_MOCK_ENV_FILE: probe,
      VIBE_TEST_SECRET: 'explicit-attempt',
    },
  });
  t.after(async () => {
    if (saved === undefined) delete process.env.VIBE_TEST_SECRET;
    else process.env.VIBE_TEST_SECRET = saved;
    await provider.close();
  });

  await provider.extract('', { filePath: MIDDLEWARE, maxSymbols: 100 });
  assert.equal((await readFile(probe, 'utf8')).trim(), 'clean');
  const filtered = sanitizeLspEnvironment(process.env, { VIBE_TEST_SECRET: 'explicit-attempt', SAFE_SETTING: 'kept' });
  assert.equal(filtered.VIBE_TEST_SECRET, undefined);
  assert.equal(filtered.SAFE_SETTING, 'kept');
  const loaderFiltered = sanitizeLspEnvironment({
    PATH: '/usr/bin',
    SAFE_SETTING: 'kept',
    NODE_OPTIONS: '--require ./evil.js',
    NODE_PATH: '/evil',
    LD_PRELOAD: '/evil.so',
    LD_LIBRARY_PATH: '/evil',
    DYLD_INSERT_LIBRARIES: '/evil.dylib',
    PYTHONPATH: '/evil',
    PYTHONSTARTUP: '/evil.py',
    RUBYOPT: '-revil',
    PERL5OPT: '-Mevil',
    BASH_ENV: '/evil',
    SHELLOPTS: 'xtrace',
    ENV: '/evil',
    PROMPT_COMMAND: 'evil',
    AWS_ACCESS_KEY_ID: 'AKIA-not-real',
    GITHUB_PAT: 'not-real',
    CI_JOB_JWT: 'not-real',
    PIP_INDEX_URL: 'https://user:pass@example.invalid/simple',
    OPENAI_KEY: 'not-real',
    KEYBOARD_LAYOUT: 'us',
  });
  assert.equal(loaderFiltered.PATH, '/usr/bin');
  assert.equal(loaderFiltered.SAFE_SETTING, 'kept');
  assert.equal(loaderFiltered.KEYBOARD_LAYOUT, 'us');
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
    'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'PERL5OPT', 'BASH_ENV', 'SHELLOPTS', 'ENV', 'PROMPT_COMMAND', 'AWS_ACCESS_KEY_ID', 'GITHUB_PAT', 'CI_JOB_JWT', 'PIP_INDEX_URL', 'OPENAI_KEY']) {
    assert.equal(loaderFiltered[name], undefined, name);
  }
  await provider.close();
});

test('rejects malformed protocol frames, server errors, crashes and timeouts', async (t) => {
  const { root } = await copyFixture(t);
  const modes = [
    ['malformed-json', /not valid JSON/i],
    ['bad-length', /invalid Content-Length/i],
    ['oversized-length', /invalid Content-Length/i],
    ['server-error', /mock symbol failure/i],
    ['crash', /exited before responding/i],
  ];
  for (const [mode, expected] of modes) {
    const provider = mockProvider(root, mode, { timeoutMs: 1_500 });
    try {
      await assert.rejects(
        provider.extract('', { filePath: MIDDLEWARE, maxSymbols: 100 }),
        expected,
        mode,
      );
    } finally {
      await provider.close();
    }
  }

  const slow = mockProvider(root, 'slow', { timeoutMs: 250 });
  try {
    const started = performanceNow();
    await assert.rejects(slow.extract('', { filePath: MIDDLEWARE, maxSymbols: 100 }), /timed out|timeout/i);
    assert.ok(performanceNow() - started < 2_000, 'timeout must stop a hung server');
  } finally {
    await slow.close();
  }
});

test('validates server symbol output before it reaches the index', async (t) => {
  const { root } = await copyFixture(t);
  for (const mode of ['bad-symbols', 'invalid-range']) {
    const provider = mockProvider(root, mode);
    try {
      await assert.rejects(provider.extract('', { filePath: MIDDLEWARE, maxSymbols: 100 }), /symbol|range|line/i, mode);
    } finally {
      await provider.close();
    }
  }
});

test('validates launch configuration and file paths', async (t) => {
  const { root } = await copyFixture(t);
  const base = {
    command: process.execPath,
    args: [MOCK],
    cwd: root,
    rootUri: pathToFileURL(root).href,
  };
  assert.throws(() => createLspSymbolProvider({ ...base, command: '' }), /command/);
  assert.throws(() => createLspSymbolProvider({ ...base, command: 'node\0bad' }), /command/);
  assert.throws(() => createLspSymbolProvider({ ...base, args: 'nope' }), /args/);
  assert.throws(() => createLspSymbolProvider({ ...base, args: [1] }), /args/);
  assert.throws(() => createLspSymbolProvider({ ...base, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => createLspSymbolProvider({ ...base, maxMessageBytes: 10 }), /maxMessageBytes/);
  assert.throws(() => createLspSymbolProvider({ ...base, rootUri: 'https://example.com' }), /rootUri/);
  assert.throws(() => createLspSymbolProvider({ ...base, rootUri: 'file://server/share/repo' }), /rootUri/);
  assert.throws(() => createLspSymbolProvider({ ...base, extensions: ['ts'] }), /extensions/);
  assert.throws(() => createLspSymbolProvider({ ...base, id: 'Bad Id' }), /id/);
  assert.throws(() => createLspSymbolProvider({ ...base, languageId: '' }), /languageId/);
  assert.throws(() => createLspSymbolProvider({ ...base, env: { 'BAD KEY': 'x' } }), /environment/);

  const provider = mockProvider(root);
  t.after(() => provider.close());
  await assert.rejects(provider.extract('', { filePath: '../outside.ts' }), /filePath/);
  await assert.rejects(provider.extract('', { filePath: 'C:\\outside.ts' }), /filePath/);
  await assert.rejects(provider.extract('', { filePath: 'src/foo:bar.ts' }), /filePath/);
  await assert.rejects(provider.extract('', {}), /filePath/);
  assert.equal(await provider.extract('', { filePath: 'README.md', maxSymbols: 10 }), null);
  await provider.close();

  const missing = createLspSymbolProvider({ ...base, command: 'vibe-missing-lsp-command-xyz' });
  try {
    await assert.rejects(
      missing.extract('', { filePath: MIDDLEWARE }),
      /failed to start|language server|not found|ENOENT/i,
    );
  } finally {
    await missing.close();
  }
});

test('close is idempotent and stops the child process', async (t) => {
  const { root } = await copyFixture(t);
  const provider = mockProvider(root);
  await provider.extract('', { filePath: MIDDLEWARE, maxSymbols: 100 });
  await provider.close();
  await provider.close();
});

test('close during an in-flight extract settles it before returning', async (t) => {
  const { root } = await copyFixture(t);
  const provider = mockProvider(root, 'delayed-exit');
  const pending = provider.extract('', { filePath: MIDDLEWARE });
  let settled = 'pending';
  pending.then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
  await provider.close();
  const atClose = settled;
  await pending.catch(() => {});
  assert.notEqual(atClose, 'pending', 'close must not return while an extract is still in flight');
});
