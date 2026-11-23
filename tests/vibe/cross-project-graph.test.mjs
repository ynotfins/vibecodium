import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCrossProjectGraph,
  CrossProjectGraph,
  CrossProjectGraphError,
  MAX_HTTP_CALLS,
} from '../../src/stable/index-engine/cross-project-graph.mjs';
import { INDEX_VERSION } from '../../src/stable/index-engine/index-engine.mjs';
import { ProjectRegistry } from '../../src/stable/index-engine/project-registry.mjs';

const API_FILES = {
  'package.json': JSON.stringify({
    name: 'fixture-api',
    private: true,
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.20.0',
      express: '^5.1.0',
      pg: '^8.16.0',
    },
  }),
  Dockerfile: [
    'FROM node:22-alpine',
    'WORKDIR /app',
    'EXPOSE 3000',
    '',
  ].join('\n'),
  'src/db.ts': [
    "import { Pool } from 'pg';",
    "import bad from '<script>alert(1)</script>';",
    "import leaked from 'pg?token=LEAKED_IMPORT_TOKEN';",
    "import urlBad from 'https://example.invalid/pkg?token=LEAKED_IMPORT_TOKEN';",
    'export const pool = new Pool({',
    "  connectionString: process.env.DATABASE_URL ?? 'postgres://fixture.invalid/db',",
    '});',
    '',
  ].join('\n'),
  'src/mcp.ts': [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "export const server = new McpServer({ name: 'fixture', version: '1.0.0' });",
    "server.tool('lookup_user', { id: { type: 'string' } }, async () => ({ content: [] }));",
    '',
  ].join('\n'),
  'src/routes/users.ts': [
    "import express from 'express';",
    "import { pool } from '../db';",
    '',
    'export async function getUser(id: string) {',
    "  return pool.query('SELECT * FROM users WHERE id = $1', [id]);",
    '}',
    '',
    'export async function createUser(body: unknown) {',
    "  return pool.query('INSERT INTO users (id) VALUES ($1)', [body]);",
    '}',
    '',
    'export const router = express.Router();',
    "router.get('/api/users/:id', getUser);",
    "router.post('/api/users', createUser);",
    '',
  ].join('\n'),
  'src/server.ts': [
    "import express from 'express';",
    "import { router } from './routes/users';",
    'export const app = express();',
    "const ROUTE_VERSION_TOKEN = 'v1';",
    "app.get(`/api/docs/${ROUTE_VERSION_TOKEN}`, () => 'ok');",
    "app.get('/unterminated/${oops', () => 'ok');",
    "app.get('/" + "${x}".repeat(400) + "', () => 'ok');",
    "app.get('/health', () => 'ok');",
    'app.listen(Number(process.env.PORT ?? 3000));',
    '',
  ].join('\n'),
};

const WEB_FILES = {
  'package.json': JSON.stringify({
    name: 'fixture-web',
    private: true,
    dependencies: { react: '^19.0.0' },
  }),
  'compose.yaml': [
    'services:',
    '  web:',
    '    image: node:22-alpine',
    '    ports:',
    '      - "5173:5173"',
    '',
  ].join('\n'),
  'src/admin.tsx': [
    'export async function healthCheck() {',
    "  return fetch('http://localhost:3000/health');",
    '}',
    '',
  ].join('\n'),
  'src/client.ts': [
    "import odd from 'ok\u202Eevil';",
    "import nul from 'ok\u0000evil';",
    "const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';",
    'const httpClient = {};',
    'export async function loadUser(id: string) {',
    '  const response = await fetch(`${API}/api/users/${id}`);',
    '  return response.json();',
    '}',
    '',
    'export async function createUser(body: unknown) {',
    '  return fetch(`${API}/api/users`, {',
    "    method: 'POST',",
    '    body: JSON.stringify(body),',
    '  });',
    '}',
    '',
    'export async function loadUserWithClient(id: string) {',
    '  return httpClient.get(`${API}/api/users/${id}`);',
    '}',
    '',
    'export async function createUserWithClient(body: unknown) {',
    '  return httpClient.post(`${API}/api/users`, body);',
    '}',
    '',
    "export const ignored = 'fetch(`/api/users/1`)';",
    '// fetch(`${API}/api/users/2`);',
    '',
  ].join('\n'),
};

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

async function makeFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-'));
  const apiRoot = path.join(dir, 'api');
  const webRoot = path.join(dir, 'web');
  await mkdir(apiRoot, { recursive: true });
  await mkdir(webRoot, { recursive: true });
  await writeFiles(apiRoot, API_FILES);
  await writeFiles(webRoot, WEB_FILES);
  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(apiRoot, { id: 'api' });
  await registry.register(webRoot, { id: 'web' });
  const graph = await buildCrossProjectGraph(registry);
  return { graph };
}

test('links a client symbol to an API route across two fixture repositories', async (t) => {
  const { graph } = await makeFixture(t);

  const answer = graph.routeCallers('/api/users/:id', { method: 'GET' });
  assert.equal(answer.found, true);
  assert.equal(answer.route.project, 'api');
  assert.equal(answer.route.type, 'route');
  assert.equal(answer.route.method, 'GET');
  assert.equal(answer.route.path, '/api/users/:id');
  assert.deepEqual(answer.callers.map((caller) => caller.symbol).sort(), ['loadUser', 'loadUserWithClient']);
  assert.equal(answer.callers[0].project, 'web');
  assert.equal(answer.callers[0].file, 'src/client.ts');
  assert.equal(answer.callers[0].method, 'GET');
  assert.equal(answer.callers[0].sourceTrust, 'untrusted-repository-content');

  const edge = graph.edges.find((candidate) => candidate.type === 'http-route-caller' &&
    candidate.from === answer.callers[0].id && candidate.to === answer.route.id);
  assert.ok(edge, 'the caller-to-route edge must be present');
  assert.equal(edge.confidence, 'template');
  assert.equal(edge.at.file, 'src/client.ts');
  assert.ok(edge.at.line >= 1);

  const post = graph.routeCallers('/api/users', { method: 'POST' });
  assert.deepEqual(post.callers.map((caller) => [caller.symbol, caller.method]).sort(), [
    ['createUser', 'POST'], ['createUserWithClient', 'POST'],
  ]);

  const health = graph.routeCallers('/health', { method: 'GET' });
  assert.deepEqual(health.callers.map((caller) => [caller.project, caller.symbol]), [['web', 'healthCheck']]);

  assert.equal(graph.nodes.filter((node) => node.type === 'route' && node.project === 'web').length, 0);
});

test('extracts the C3 edge families without storing source values', async (t) => {
  const { graph } = await makeFixture(t);

  const dependencies = graph.edges.filter((edge) => edge.type === 'package-dependency');
  assert.ok(dependencies.some((edge) => edge.project === 'api' && edge.name === 'express' && edge.scope === 'runtime'));
  assert.ok(dependencies.some((edge) => edge.project === 'web' && edge.name === 'react' && edge.scope === 'runtime'));
  assert.ok(graph.nodes.some((node) => node.type === 'package' && node.name === 'express'));

  const imports = graph.edges.filter((edge) => edge.type === 'import');
  assert.ok(imports.some((edge) => edge.project === 'api' && edge.specifier === 'express'));
  assert.ok(imports.some((edge) => edge.project === 'api' && edge.specifier === 'src/routes/users.ts'));

  const envNames = graph.nodes
    .filter((node) => node.type === 'env')
    .map((node) => `${node.project}:${node.name}`)
    .sort();
  assert.deepEqual(envNames, ['api:DATABASE_URL', 'api:PORT', 'web:VITE_API_URL']);

  const ports = new Set(graph.nodes.filter((node) => node.type === 'port').map((node) => node.port));
  assert.ok(ports.has(3000));
  assert.ok(ports.has(5173));

  assert.ok(graph.nodes.some((node) => node.type === 'database-table' && node.project === 'api' && node.name === 'users'));
  assert.ok(graph.nodes.some((node) => node.type === 'mcp-tool' && node.project === 'api' && node.name === 'lookup_user'));
  assert.ok(graph.nodes.some((node) => node.type === 'container' && node.project === 'api' && node.image === 'node:22-alpine'));
  assert.ok(graph.nodes.some((node) => node.type === 'container' && node.project === 'web' && node.image === 'node:22-alpine'));

  const serialized = JSON.stringify(graph);
  assert.doesNotMatch(serialized, /fixture\.invalid|localhost:3000/);
  assert.doesNotMatch(serialized, /process\.env|import\.meta\.env/);
  assert.doesNotMatch(serialized, /<script>/);
  assert.doesNotMatch(serialized, /LEAKED_IMPORT_TOKEN/);
  assert.equal(graph.nodes.every((node) => node.sourceTrust === 'untrusted-repository-content'), true);
  assert.equal(graph.edges.every((edge) => edge.sourceTrust === 'untrusted-repository-content'), true);
  assert.equal(graph.toJSON().sourceTrust, 'untrusted-repository-content');
  assert.doesNotMatch(serialized, /[\u202E\u0000]/);
  assert.ok(graph.nodes.some((node) => node.type === 'route' && node.path === '/api/docs/:param'));
  assert.ok(graph.nodes.filter((node) => node.type === 'route').every((node) => !node.path.includes('${')));
  assert.ok(!graph.nodes.some((node) => node.type === 'route' && node.path.includes('unterminated')));
  assert.ok(!graph.nodes.some((node) => node.type === 'route' && node.path.length > 2_048));
  assert.doesNotMatch(serialized, /ROUTE_VERSION_TOKEN/);
  assert.equal(graph.node(graph.routeCallers('/api/users/:id', { method: 'GET' }).route.id).type, 'route');
});

test('ignores comments and string-only calls and keeps HTTP methods distinct', async (t) => {
  const { graph } = await makeFixture(t);

  const get = graph.routeCallers('/api/users/:id', { method: 'GET' });
  assert.ok(get.callers.every((caller) => caller.method === 'GET'));
  assert.ok(!get.callers.some((caller) => caller.symbol === 'ignored'));

  assert.equal(graph.routeCallers('/api/users/:id', { method: 'POST' }).callers.length, 0);
  assert.equal(graph.routeCallers('/api/users/2', { method: 'GET' }).found, false);
  assert.equal(graph.routeCallers('/api/users/:id', { method: 'PATCH' }).found, false);
});

test('bounds HTTP caller extraction per file and across the graph', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-bulk-'));
  const root = path.join(dir, 'bulk');
  const callers = Array.from({ length: 1_001 }, (_, index) =>
    `export function f${index}() { return fetch('/api/items/${index}'); }`).join('\n');
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`src/bulk${index}.ts`, callers]));
  await writeFiles(root, files);
  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(root, { id: 'bulk' });
  const graph = await buildCrossProjectGraph(registry);
  assert.equal(graph.stats.httpCallers, MAX_HTTP_CALLS);
  assert.ok(graph.stats.httpCallers <= MAX_HTTP_CALLS);

  const singleRoot = path.join(dir, 'single');
  await writeFiles(singleRoot, { 'src/bulk.ts': callers });
  const singleRegistry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(() => singleRegistry.close());
  await singleRegistry.register(singleRoot, { id: 'single' });
  const single = await buildCrossProjectGraph(singleRegistry);
  assert.equal(single.stats.httpCallers, 1_000);
});

test('rejects malformed registries, routes and graph snapshots', async (t) => {
  await assert.rejects(buildCrossProjectGraph(null), /registry/);
  await assert.rejects(buildCrossProjectGraph({ list: () => [], index: () => ({}) }), /at least one|empty/);

  const duplicate = {
    list: () => [
      { id: 'same', root: 'D:\\fixture-one' },
      { id: 'same', root: 'D:\\fixture-two' },
    ],
    index: () => ({ files: {} }),
  };
  await assert.rejects(buildCrossProjectGraph(duplicate), /duplicate|project id/);

  const project = (index) => ({ list: () => [{ id: 'bad', root: os.tmpdir() }], index: () => index });
  await assert.rejects(buildCrossProjectGraph(project({ version: 0, files: {} })), CrossProjectGraphError);
  await assert.rejects(buildCrossProjectGraph(project({ version: INDEX_VERSION, files: null })), CrossProjectGraphError);
  await assert.rejects(
    buildCrossProjectGraph(project({ version: INDEX_VERSION, files: { '../escape.ts': { symbols: [] } } })),
    CrossProjectGraphError,
  );
  await assert.rejects(
    buildCrossProjectGraph(project({ version: INDEX_VERSION, files: { 'C:/escape.ts': { symbols: [] } } })),
    CrossProjectGraphError,
  );
  await assert.rejects(
    buildCrossProjectGraph(project({
      version: INDEX_VERSION,
      files: { 'src/a.ts': { symbols: [{ name: 'LEAKED SOURCE TEXT <script>', kind: 'function', line: 1, column: 1 }] } },
    })),
    CrossProjectGraphError,
  );
  await assert.rejects(
    buildCrossProjectGraph(project({
      version: INDEX_VERSION,
      files: { 'src/a.ts': { symbols: [{ name: 'ok', kind: 'function', line: 1, column: 1, container: 'LEAKED CONTAINER VALUE' }] } },
    })),
    CrossProjectGraphError,
  );

  const forgedSymbol = (patch) => project({
    version: INDEX_VERSION,
    files: { 'src/a.ts': { symbols: [{ name: 'ok', kind: 'function', line: 1, column: 1, ...patch }] } },
  });
  for (const patch of [
    { kind: 'rogue' },
    { line: 0 },
    { line: 1.5 },
    { column: 0 },
    { column: '1' },
  ]) {
    await assert.rejects(buildCrossProjectGraph(forgedSymbol(patch)), CrossProjectGraphError);
  }

  const symbols = (count) => Array.from({ length: count }, (_, index) => ({
    name: `s${index}`, kind: 'function', line: index + 1, column: 1,
  }));
  await assert.rejects(
    buildCrossProjectGraph(project({ version: INDEX_VERSION, files: { 'src/a.ts': { symbols: symbols(2_001) } } })),
    CrossProjectGraphError,
  );
  const atCap = await buildCrossProjectGraph(project({
    version: INDEX_VERSION,
    files: { 'src/a.ts': { symbols: symbols(2_000) } },
  }));
  assert.equal(atCap.projects.length, 1);

  const { graph } = await makeFixture(t);
  assert.throws(() => graph.routeCallers('../escape', { method: 'GET' }), CrossProjectGraphError);
  assert.throws(() => graph.routeCallers('/health', { method: 'TRACE' }), CrossProjectGraphError);
  assert.throws(() => graph.routeCallers('/' + 'a'.repeat(3_000), { method: 'GET' }), CrossProjectGraphError);
  assert.throws(() => graph.node('missing'), CrossProjectGraphError);
});
test('bounds contained reads: per-file size, symlink escape and source-file count', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-contained-'));
  const root = path.join(dir, 'app');
  const outside = path.join(dir, 'outside');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'evil.ts'), "app.get('/escaped', () => 'x');\n");
  await writeFile(
    path.join(root, 'src', 'big.ts'),
    '/* ' + 'x'.repeat(1_000_001) + ' */\nexport const big = 1;\n',
  );
  await writeFile(path.join(root, 'src', 'ok.ts'), "app.get('/ok', () => 'x');\n");
  await symlink(outside, path.join(root, 'link'), 'junction');

  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await unlink(path.join(root, 'link')).catch(() => {});
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(root, { id: 'app' });

  const graph = await buildCrossProjectGraph({
    list: () => registry.list(),
    index: (id) => {
      const snapshot = registry.index(id);
      return {
        ...snapshot,
        files: {
          ...snapshot.files,
          'link/evil.ts': { symbols: [] },
        },
      };
    },
  });

  assert.equal(graph.routeCallers('/escaped', { method: 'GET' }).found, false);
  assert.equal(graph.routeCallers('/ok', { method: 'GET' }).found, true);
  assert.ok(graph.stats.skipped >= 2);

  const many = Object.fromEntries(
    Array.from({ length: 10_001 }, (_, index) => ['src/f' + index + '.ts', { symbols: [] }]),
  );
  await assert.rejects(
    buildCrossProjectGraph({
      list: () => [{ id: 'many', root }],
      index: () => ({ version: INDEX_VERSION, files: many }),
    }),
    /exceeds 10000 files|source files/,
  );

});

test('fails when total source bytes exceed the graph cap', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-bytes-'));
  const root = path.join(dir, 'app');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const filler = '/*' + 'x'.repeat(999_992) + '*/\n';
  for (let index = 0; index < 65; index += 1) {
    await writeFile(path.join(root, 'src', 'f' + index + '.ts'), filler);
  }
  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(root, { id: 'bytes' });

  await assert.rejects(buildCrossProjectGraph(registry), /source bytes/);
});

test('keys route matching by HTTP method for identical paths', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-method-'));
  const root = path.join(dir, 'app');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'server.ts'), [
    "app.get('/api/thing', () => 'get');",
    "app.post('/api/thing', () => 'post');",
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'client.ts'), [
    'export async function getThing() {',
    "  return fetch('/api/thing');",
    '}',
    '',
  ].join('\n'));
  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(root, { id: 'method' });

  const graph = await buildCrossProjectGraph(registry);
  const get = graph.routeCallers('/api/thing', { method: 'GET' });
  const post = graph.routeCallers('/api/thing', { method: 'POST' });
  assert.ok(get.callers.some((caller) => caller.symbol === 'getThing'));
  assert.ok(!post.callers.some((caller) => caller.symbol === 'getThing'));
});

test('stores only normalized package names for import specifiers', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-imports-'));
  const root = path.join(dir, 'app');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), [
    "import q from 'pkg?token=LEAKED_IMPORT_TOKEN';",
    "import u from 'https://example.invalid/pkg?token=LEAKED_IMPORT_TOKEN';",
    String.raw`import b from '\\server\share\x';`,
    "import c from 'C:/secret/x';",
    "import d from 'pkg/sub';",
    "import e from '@scope/pkg/deep';",
    '',
  ].join('\n'));
  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(root, { id: 'imports' });

  const graph = await buildCrossProjectGraph(registry);
  const serialized = JSON.stringify(graph.toJSON());
  for (const leaked of ['LEAKED_IMPORT_TOKEN', 'example.invalid', 'server', 'secret']) {
    assert.ok(!serialized.includes(leaked), 'leaked: ' + leaked);
  }
  const specs = graph.toJSON().edges
    .filter((edge) => edge.type === 'import')
    .map((edge) => edge.specifier);
  assert.deepEqual(specs.sort(), ['@scope/pkg', 'pkg']);
});

test('bounds hostile import lines and drops over-long route paths', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-hostile-'));
  const root = path.join(dir, 'app');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const hostile = 'import a '.repeat(40_000) + '\n';
  const longRoute = '/a'.repeat(65);
  const maxRoute = '/' + 'b/'.repeat(63) + 'b';
  await writeFile(path.join(root, 'src', 'a.ts'), [
    hostile,
    "import ok from 'pkg';",
    "app.get('" + longRoute + "', () => 'long');",
    "app.get('" + maxRoute + "', () => 'max');",
    '',
  ].join('\n'));
  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(root, { id: 'hostile' });

  const graph = await buildCrossProjectGraph(registry);
  assert.equal(graph.routeCallers(longRoute, { method: 'GET' }).found, false);
  assert.equal(graph.routeCallers(maxRoute, { method: 'GET' }).found, true);
  const specs = graph.toJSON().edges.filter((edge) => edge.type === 'import').map((edge) => edge.specifier);
  assert.deepEqual(specs, ['pkg']);
});

test('rejects forged snapshot fields and forces trust on accepted snapshots', async (t) => {
  const { graph } = await makeFixture(t);
  const clone = () => JSON.parse(JSON.stringify(graph.toJSON()));

  const injectedNode = clone();
  injectedNode.nodes[1].source = 'LEAKED SOURCE TEXT';
  assert.throws(() => new CrossProjectGraph(injectedNode), CrossProjectGraphError);

  const injectedEdge = clone();
  injectedEdge.edges[0].secret = 'LEAKED SECRET';
  assert.throws(() => new CrossProjectGraph(injectedEdge), CrossProjectGraphError);

  const missingNode = clone();
  missingNode.edges[0].to = 'symbol:missing';
  assert.throws(() => new CrossProjectGraph(missingNode), CrossProjectGraphError);

  const spoofed = clone();
  spoofed.nodes[1].sourceTrust = 'trusted';
  const rebuilt = new CrossProjectGraph(spoofed);
  assert.equal(rebuilt.nodes[1].sourceTrust, 'untrusted-repository-content');
  assert.equal(rebuilt.toJSON().sourceTrust, 'untrusted-repository-content');
  assert.ok(!JSON.stringify(rebuilt.toJSON()).includes('LEAKED'));
  for (const bad of ['bad\nline', 'bad\u202Eevil', 'bad<script>', 'bad\u0000nul']) {
    const unsafeNode = clone();
    unsafeNode.nodes[1].id = bad;
    assert.throws(() => new CrossProjectGraph(unsafeNode), CrossProjectGraphError);
    const unsafeEdge = clone();
    unsafeEdge.edges[0].id = bad;
    assert.throws(() => new CrossProjectGraph(unsafeEdge), CrossProjectGraphError);
  }

  const duplicateEdge = clone();
  duplicateEdge.edges[1].id = duplicateEdge.edges[0].id;
  assert.throws(() => new CrossProjectGraph(duplicateEdge), CrossProjectGraphError);

  const injectedRoot = clone();
  injectedRoot.secret = 'LEAKED SECRET';
  assert.throws(() => new CrossProjectGraph(injectedRoot), CrossProjectGraphError);

  const badVersion = clone();
  badVersion.version = 999;
  assert.throws(() => new CrossProjectGraph(badVersion), CrossProjectGraphError);

  const badTrust = clone();
  badTrust.sourceTrust = 'trusted';
  assert.throws(() => new CrossProjectGraph(badTrust), CrossProjectGraphError);
});

test('charges parameter nodes to the trie budget', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-params-'));
  const root = path.join(dir, 'app');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const params = '/:p'.repeat(63);
  const lines = Array.from({ length: 4_000 }, (_, index) =>
    "app.get('/r" + index + params + "', () => 'x');");
  await writeFile(path.join(root, 'src', 'routes.ts'), lines.join('\n'));
  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(root, { id: 'params' });

  const graph = await buildCrossProjectGraph(registry);
  assert.equal(graph.stats.routes, 4_000);
  assert.ok(graph.stats.routesIndexed > 0);
  assert.ok(graph.stats.routesIndexed < graph.stats.routes);
});

test('stops indexing the trie at the global node budget', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-trie-'));
  const root = path.join(dir, 'app');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const suffix = 's/'.repeat(62) + 's';
  const lines = Array.from({ length: 4_000 }, (_, index) =>
    "app.get('/r" + index + '/' + suffix + "', () => 'x');");
  await writeFile(path.join(root, 'src', 'routes.ts'), lines.join('\n'));
  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(root, { id: 'trie' });

  const graph = await buildCrossProjectGraph(registry);
  assert.equal(graph.stats.routes, 4_000);
  assert.ok(graph.stats.routesIndexed > 0);
  assert.ok(graph.stats.routesIndexed < graph.stats.routes);
});

test('disables caller inference when the route-range table saturates', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-cross-project-ranges-'));
  const root = path.join(dir, 'app');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const lines = Array.from({ length: 4_097 }, (_, index) =>
    "app.get('/r" + index + "', () => 'x');");
  lines.push("export function loadR5() { return fetch('/r5'); }");
  await writeFile(path.join(root, 'src', 'routes.ts'), lines.join('\n'));
  const registry = new ProjectRegistry({ watchIntervalMs: 10_000 });
  t.after(async () => {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.register(root, { id: 'ranges' });

  const graph = await buildCrossProjectGraph(registry);
  assert.equal(graph.stats.routes, 4_097);
  const answer = graph.routeCallers('/r5', { method: 'GET' });
  assert.equal(answer.found, true);
  assert.deepEqual(answer.callers, []);
});
