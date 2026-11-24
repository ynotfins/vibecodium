import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCrossProjectGraph } from '../../src/stable/index-engine/cross-project-graph.mjs';
import { ProjectRegistry } from '../../src/stable/index-engine/project-registry.mjs';
import {
  projectToUnderstandGraph,
  UNDERSTAND_GRAPH_VERSION,
  UNDERSTAND_SOURCE_TRUST,
  validateUnderstandGraph,
} from '../../src/stable/index-engine/understand-projection.mjs';

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
  'src/server.ts': [
    "const LEAKED_IMPORT_TOKEN = 'super-secret';",
    "import express from 'express';",
    "import { router } from './routes/users';",
    'export const app = express();',
    "app.get('/api/users/:id', () => 'ok');",
    "app.get('/health', () => 'ok');",
    'const port = Number(process.env.PORT ?? 3000);',
    'app.listen(port);',
    '',
  ].join('\n'),
  'src/routes/users.ts': [
    "import { query } from '../db';",
    'export async function getUser(id: string) {',
    "  return query('SELECT * FROM users WHERE id = $1', [id]);",
    '}',
    'export const router = { get() {} };',
    "router.get('/api/users/:id', getUser);",
    '',
  ].join('\n'),
  'src/db.ts': [
    "export const connectionString = 'postgres://fixture.invalid/db';",
    'export function query(sql: string, params: unknown[]) {',
    '  return { sql, params };',
    '}',
    '',
  ].join('\n'),
  'src/mcp.ts': [
    'const server = { tool(_name: string, _handler: unknown) {} };',
    "server.tool('lookup_user', async () => ({ content: [] }));",
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
  'src/client.ts': [
    "import { helper } from './helper';",
    "const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';",
    'export async function loadUser(id: string) {',
    '  return fetch(`${API}/api/users/${id}`).then((response) => response.json());',
    '}',
    'export async function healthCheck() {',
    '  return fetch(`${API}/health`);',
    '}',
    'export function describe() {',
    '  return helper();',
    '}',
    '',
  ].join('\n'),
  'src/helper.ts': [
    'export function helper() {',
    "  return 'ok';",
    '}',
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-understand-projection-'));
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
  return { graph, root: dir };
}

test('projects the cross-project graph into an Understand-Anything knowledge graph', async (t) => {
  const { graph, root } = await makeFixture(t);
  const options = {
    name: 'fixture-workspace',
    description: 'fixture workspace',
    analyzedAt: '2026-11-24T00:00:00.000Z',
    gitCommitHash: 'abc123',
  };
  const projected = projectToUnderstandGraph(graph, options);

  assert.equal(projected.version, UNDERSTAND_GRAPH_VERSION);
  assert.equal(projected.sourceTrust, UNDERSTAND_SOURCE_TRUST);
  for (const node of projected.nodes) assert.equal(node.sourceTrust, UNDERSTAND_SOURCE_TRUST);
  for (const edge of projected.edges) assert.equal(edge.sourceTrust, UNDERSTAND_SOURCE_TRUST);
  assert.equal(projected.project.name, 'fixture-workspace');
  assert.equal(projected.project.analyzedAt, '2026-11-24T00:00:00.000Z');
  assert.equal(projected.project.gitCommitHash, 'abc123');
  assert.equal(projected.nodes.length, graph.nodes.length);
  assert.equal(projected.layers.length, 2);
  assert.ok(projected.tour.length >= 2);

  const validation = validateUnderstandGraph(projected);
  assert.deepEqual(validation.issues, []);
  assert.equal(validation.stats.totalNodes, graph.nodes.length);
  assert.equal(validation.stats.totalEdges, projected.edges.length);

  const nodeTypes = new Set(projected.nodes.map((node) => node.type));
  for (const type of ['module', 'file', 'function', 'endpoint', 'concept', 'resource', 'table', 'service']) {
    assert.ok(nodeTypes.has(type), type);
  }
  const edgeTypes = new Set(projected.edges.map((edge) => edge.type));
  for (const type of ['contains', 'routes', 'imports', 'depends_on', 'reads_from', 'serves', 'related', 'exports', 'deploys', 'calls']) {
    assert.ok(edgeTypes.has(type), type);
  }

  const route = projected.nodes.find((node) => node.type === 'endpoint' && node.name === 'GET /api/users/:id');
  assert.ok(route);
  assert.equal(route.filePath, 'api/src/routes/users.ts');
  const caller = projected.nodes.find((node) => node.type === 'function' && node.name === 'loadUser');
  assert.ok(caller);
  assert.equal(caller.filePath, 'web/src/client.ts');
  const call = projected.edges.find((edge) => edge.type === 'calls' && edge.source === caller.id && edge.target === route.id);
  assert.ok(call, 'route-to-caller edge is projected');
  assert.equal(call.weight, 0.8);

  const apiProject = projected.nodes.find((node) => node.id === 'module:project:api');
  const serverFile = projected.nodes.find((node) => node.type === 'file' && node.filePath === 'api/src/server.ts');
  assert.ok(apiProject);
  assert.ok(serverFile);
  assert.ok(projected.edges.some((edge) => edge.type === 'contains' && edge.source === apiProject.id && edge.target === serverFile.id));

  const table = projected.nodes.find((node) => node.type === 'table' && node.name === 'users');
  assert.ok(table);
  assert.ok(projected.edges.some((edge) => edge.type === 'related' && edge.target === table.id));

  const serialized = JSON.stringify(projected);
  for (const marker of ['LEAKED_IMPORT_TOKEN', 'postgres://fixture.invalid', 'SELECT * FROM users', 'http://localhost:3000', 'super-secret', root]) {
    assert.equal(serialized.includes(marker), false, marker);
  }

  const again = projectToUnderstandGraph(graph, options);
  assert.deepEqual(again, projected);
});

test('validator reports missing fields, dangling edges, duplicate ids and unassigned file nodes', () => {
  const graph = {
    version: UNDERSTAND_GRAPH_VERSION,
    project: { name: 'x', languages: ['text'], frameworks: [], description: 'x', analyzedAt: '2026-11-24T00:00:00.000Z', gitCommitHash: 'x' },
    nodes: [
      { id: 'file:a.ts', type: 'file', name: 'a.ts', filePath: 'a.ts', tags: ['source'] },
      { id: 'file:a.ts', type: 'file', name: 'a.ts', filePath: 'a.ts', summary: 'x', tags: ['source'] },
    ],
    edges: [{ source: 'file:a.ts', target: 'missing', type: 'imports', weight: 0.7 }],
    layers: [{ id: 'layer:one', name: 'one', description: 'x', nodeIds: [] }],
    tour: [{ order: 1, title: 'x', description: 'x', nodeIds: ['missing'] }],
  };
  const { issues } = validateUnderstandGraph(graph);
  assert.ok(issues.some((issue) => issue.includes('missing summary')));
  assert.ok(issues.some((issue) => issue.includes('Duplicate node ID')));
  assert.ok(issues.some((issue) => issue.includes('target "missing" not found')));
  assert.ok(issues.some((issue) => issue.includes('not in any layer')));
  assert.ok(issues.some((issue) => issue.includes('Tour step[0] references missing node')));
});

test('validator sanitizes hostile labels in diagnostics', () => {
  const graph = {
    version: UNDERSTAND_GRAPH_VERSION,
    project: { name: 'x', languages: ['text'], frameworks: [], description: 'x', analyzedAt: '2026-11-24T00:00:00.000Z', gitCommitHash: 'x' },
    nodes: [
      { id: 'bad\u0007node', type: 'file', name: 'x', summary: 'x', tags: ['source'] },
    ],
    edges: [{ source: 'missing\u0007source', target: 'bad\u0007node', type: 'imports', weight: 0.5 }],
    layers: [{ id: 'layer\u202Etest', name: '', description: 'x', nodeIds: [] }],
    tour: [{ order: 1, title: 'x', description: 'x', nodeIds: ['missing\u2028node'] }],
  };
  const { issues } = validateUnderstandGraph(graph);
  assert.ok(issues.some((issue) => issue.includes('Layer "layer?test"')));
  assert.ok(issues.every((issue) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(issue)));
});

test('rejects a graph that CrossProjectGraph does not validate', async (t) => {
  const { graph } = await makeFixture(t);
  const snapshot = graph.toJSON();
  const forged = {
    ...snapshot,
    edges: [{ ...snapshot.edges[0], to: 'missing-node' }],
  };
  assert.throws(() => projectToUnderstandGraph(forged), /missing node/);
  assert.throws(() => projectToUnderstandGraph(null), /graph snapshot is invalid/);
  assert.throws(() => projectToUnderstandGraph(graph, { analyzedAt: 'not-a-date' }), /analyzedAt/);
});

test('rejects control, bidi and separator characters in option text', async (t) => {
  const { graph } = await makeFixture(t);
  assert.throws(() => projectToUnderstandGraph(graph, { name: 'bad\u202Ename' }), /project name is invalid/);
  assert.throws(() => projectToUnderstandGraph(graph, { description: 'bad\u0085value' }), /description is invalid/);
  assert.throws(() => projectToUnderstandGraph(graph, { description: 'bad\u2028value' }), /description is invalid/);
});
