import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GraphPanelModel,
  GraphPanelModelError,
  createGraphPanelController,
  createGraphPanelModel,
  renderGraphPanelHtml,
} from '../../src/stable/extensions/vibecodium-ai/src/graph-panel.cjs';
import { buildCrossProjectGraph } from '../../src/stable/index-engine/cross-project-graph.mjs';
import { ProjectRegistry } from '../../src/stable/index-engine/project-registry.mjs';

const API_FILES = {
  'package.json': JSON.stringify({ name: 'fixture-api', private: true, dependencies: { express: '^5.1.0' } }),
  'src/server.ts': [
    "import express from 'express';",
    'export const app = express();',
    'export function getUser(id: string) { return { id }; }',
    "app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));",
    'app.listen(Number(process.env.PORT ?? 3000));',
    '',
  ].join('\n'),
};

const WEB_FILES = {
  'package.json': JSON.stringify({ name: 'fixture-web', private: true }),
  'src/client.ts': [
    'export async function loadUser(id: string) {',
    '  const response = await fetch(`http://localhost:3000/api/users/${id}`);',
    '  return response.json();',
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-graph-panel-'));
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
  return { graph, roots: { api: apiRoot, web: webRoot } };
}

function nodeId(graph, type, project, predicate = () => true) {
  const node = graph.nodes.find((candidate) => candidate.type === type && candidate.project === project && predicate(candidate));
  assert.ok(node, `missing ${type} node in ${project}`);
  return node.id;
}

function createFakeVscode() {
  const calls = { createWebviewPanel: [], showTextDocument: [], warnings: [], info: [] };
  const webview = {
    html: '',
    handler: null,
    onDidReceiveMessage(handler) {
      this.handler = handler;
      return { dispose() {} };
    },
    async receive(message) {
      assert.equal(typeof this.handler, 'function');
      return this.handler(message);
    },
  };
  const panel = {
    webview,
    disposeHandler: null,
    reveal() {},
    onDidDispose(handler) {
      this.disposeHandler = handler;
      return { dispose() {} };
    },
    dispose() {
      if (this.disposeHandler) this.disposeHandler();
    },
  };
  class FakeUri {
    constructor(value) {
      this.value = value;
    }
    static file(value) {
      return new FakeUri(value);
    }
    toString() {
      return 'file://' + this.value;
    }
  }
  class FakeRange {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  }
  return {
    calls,
    panel,
    Uri: FakeUri,
    Range: FakeRange,
    ViewColumn: { Active: 1 },
    window: {
      createWebviewPanel(type, title, column, options) {
        calls.createWebviewPanel.push({ type, title, column, options });
        return panel;
      },
      async showTextDocument(document, options) {
        calls.showTextDocument.push({ document, options });
      },
      showWarningMessage(message) {
        calls.warnings.push(message);
      },
      showInformationMessage(message) {
        calls.info.push(message);
      },
    },
    workspace: {
      async openTextDocument(uri) {
        return { uri, lineCount: 100 };
      },
    },
  };
}

test('the view model zooms workspace -> project -> module -> symbol', async (t) => {
  const { graph, roots } = await makeFixture(t);
  const model = createGraphPanelModel(graph, { projectRoots: roots });

  assert.ok(model instanceof GraphPanelModel);
  assert.equal(model.view().level, 'workspace');
  assert.ok(model.view().nodes.every((node) => node.type === 'project'));
  assert.ok(model.view().nodes.some((node) => node.project === 'api'));
  assert.ok(model.view().nodes.some((node) => node.project === 'web'));

  const apiProject = nodeId(graph, 'project', 'web');
  const apiModule = nodeId(graph, 'module', 'web', (node) => node.file === 'src/client.ts');
  const symbol = graph.nodes.find((node) => node.type === 'symbol' && node.project === 'web' && node.file === 'src/client.ts');
  assert.ok(symbol, 'missing web caller symbol');
  const apiSymbol = symbol.id;

  assert.deepEqual(model.handleNodeClick(apiProject), { kind: 'zoom', level: 'project' });
  assert.equal(model.view().level, 'project');
  assert.ok(model.view().nodes.some((node) => node.id === apiModule));
  assert.ok(model.view().crumbs.some((crumb) => crumb.level === 'workspace'));
  assert.ok(model.view().crumbs.some((crumb) => crumb.level === 'project' && crumb.id === 'web'));

  assert.deepEqual(model.handleNodeClick(apiModule), { kind: 'zoom', level: 'module' });
  assert.equal(model.view().level, 'module');
  assert.ok(model.view().nodes.some((node) => node.id === apiSymbol));
  assert.ok(model.view().nodes.every((node) => node.project === 'web'));
  assert.equal(model.view().counts.total, model.view().nodes.length);
  assert.equal(model.view().counts.shown, model.view().nodes.length);

  const opened = model.handleNodeClick(apiSymbol);
  assert.equal(opened.kind, 'open');
  assert.equal(opened.file, 'src/client.ts');
  assert.equal(opened.line, symbol.line);
  assert.equal(opened.column, symbol.column);
  assert.equal(path.resolve(opened.absolutePath), path.resolve(roots.web, 'src/client.ts'));
  assert.equal(model.view().level, 'symbol');
  assert.equal(model.view().nodes.length, 1);
  assert.equal(model.view().nodes[0].id, apiSymbol);

  model.reset();
  assert.equal(model.view().level, 'workspace');
});

test('routes appear in their defining module with visible edges and click-through', async (t) => {
  const { graph, roots } = await makeFixture(t);
  const model = createGraphPanelModel(graph, { projectRoots: roots });
  const route = graph.nodes.find((node) => node.type === 'route' && node.project === 'api' &&
    node.method === 'GET' && node.path === '/api/users/:id');
  assert.ok(route, 'missing GET /api/users/:id route');

  model.handleNodeClick(nodeId(graph, 'project', 'api'));
  model.handleNodeClick(nodeId(graph, 'module', 'api', (node) => node.file === 'src/server.ts'));
  const view = model.view();
  assert.equal(view.level, 'module');
  assert.ok(view.nodes.some((node) => node.id === route.id));
  assert.equal(view.counts.total, view.nodes.length);
  assert.equal(view.counts.shown, view.nodes.length);
  assert.ok(view.edges.some((edge) => edge.type === 'route-definition' && edge.to === route.id));

  const html = renderGraphPanelHtml(view, { nonce: 'fixednonce1234567890' });
  assert.match(html, /data-action="open"/);
  assert.match(html, /<ul class="graph-edges"/);
  assert.match(html, /route-definition/);

  const opened = model.handleNodeClick(route.id);
  assert.equal(opened.kind, 'open');
  assert.equal(opened.file, 'src/server.ts');
  assert.equal(opened.line, route.line);
  assert.equal(opened.column, route.column);
  assert.equal(path.resolve(opened.absolutePath), path.resolve(roots.api, 'src/server.ts'));
});

test('the panel HTML renders the fixture graph and escapes untrusted names', async (t) => {
  const { graph, roots } = await makeFixture(t);
  const model = createGraphPanelModel(graph, { projectRoots: roots });
  const apiProject = nodeId(graph, 'project', 'api');
  const html = renderGraphPanelHtml(model.view(), { nonce: 'fixednonce1234567890' });

  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'nonce-fixednonce1234567890'/);
  assert.match(html, /style-src 'nonce-fixednonce1234567890'/);
  assert.match(html, /data-node-id="project:api"/);
  assert.match(html, /data-action="zoom"/);
  assert.match(html, /aria-label=/);
  assert.ok(!html.includes('src="http'));
  assert.ok(!html.includes('onerror='));

  model.handleNodeClick(apiProject);
  const projectHtml = renderGraphPanelHtml(model.view(), { nonce: 'fixednonce1234567890' });
  assert.match(projectHtml, /data-node-id="module:api:src%2Fserver.ts"/);
  assert.match(projectHtml, /src\/server\.ts/);

  const escapeModel = createGraphPanelModel({
    projects: [{ id: 'api' }],
    nodes: [
      { id: 'project:api', type: 'project', project: 'api' },
      { id: 'module:api:src/a.ts', type: 'module', project: 'api', file: 'src/a.ts' },
      { id: 'symbol:api:evil', type: 'symbol', project: 'api', name: '<img src=x onerror=alert(1)>', file: 'src/a.ts', line: 1, column: 1 },
    ],
    edges: [],
  }, { projectRoots: roots });
  escapeModel.handleNodeClick('project:api');
  escapeModel.handleNodeClick('module:api:src/a.ts');
  const escapeHtml = renderGraphPanelHtml(escapeModel.view(), { nonce: 'fixednonce1234567890' });
  assert.ok(!escapeHtml.includes('<img src=x'));
  assert.match(escapeHtml, /&lt;img/);
});

test('click-through posts the selected source to the extension host', async (t) => {
  const { graph, roots } = await makeFixture(t);
  const vscode = createFakeVscode();
  const controller = createGraphPanelController({
    vscode,
    graphProvider: () => ({ graph, projectRoots: roots }),
  });

  controller.open();
  assert.equal(vscode.calls.createWebviewPanel.length, 1);
  assert.equal(vscode.calls.createWebviewPanel[0].type, 'vibecodium.graph');
  assert.match(vscode.panel.webview.html, /data-node-id="project:api"/);

  await vscode.panel.webview.receive({
    type: 'nodeClick',
    nodeId: nodeId(graph, 'project', 'web'),
  });
  await vscode.panel.webview.receive({
    type: 'nodeClick',
    nodeId: nodeId(graph, 'module', 'web', (node) => node.file === 'src/client.ts'),
  });
  const apiSymbol = nodeId(graph, 'symbol', 'web', (node) => node.file === 'src/client.ts');
  await vscode.panel.webview.receive({ type: 'nodeClick', nodeId: apiSymbol });
  assert.equal(vscode.calls.warnings.length, 0);
  assert.equal(vscode.calls.showTextDocument.length, 1);
  assert.match(vscode.calls.showTextDocument[0].document.uri.value, /src[\\/]client\.ts$/);
  assert.ok(vscode.calls.showTextDocument[0].options.selection.start.line >= 0);
  assert.equal(vscode.calls.showTextDocument[0].options.preview, false);
  assert.equal(controller.view().level, 'symbol');
  assert.ok(vscode.panel.webview.html.includes('data-node-id="' + apiSymbol + '"'));
  assert.match(vscode.panel.webview.html, /Showing 1 of 1 nodes/);

  await vscode.panel.webview.receive({ type: 'reset' });
  assert.equal(controller.view().level, 'workspace');
});

test('large graphs are bounded and the HTML stays proportional', () => {
  const nodes = [
    { id: 'project:api', type: 'project', project: 'api' },
    { id: 'module:api:src/main.ts', type: 'module', project: 'api', file: 'src/main.ts' },
  ];
  for (let index = 0; index < 10_000; index += 1) {
    nodes.push({
      id: 'symbol:api:src/main.ts:' + (index + 1) + ':1:generated',
      type: 'symbol',
      project: 'api',
      name: 'symbol' + index,
      file: 'src/main.ts',
      line: index + 1,
      column: 1,
    });
  }
  const graph = { projects: [{ id: 'api' }], nodes, edges: [] };
  const started = performance.now();
  const model = createGraphPanelModel(graph);
  model.handleNodeClick('project:api');
  model.handleNodeClick('module:api:src/main.ts');
  const view = model.view();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `view took ${elapsed}ms`);
  assert.equal(view.level, 'module');
  assert.equal(view.truncated, true);
  assert.ok(view.nodes.length <= 200);
  assert.deepEqual(view.counts, { total: 10_001, shown: view.nodes.length });
  const html = renderGraphPanelHtml(view, { nonce: 'fixednonce1234567890' });
  assert.ok(html.length < 500_000);
});

test('invalid graphs and unsafe source paths fail closed', async (t) => {
  const { graph, roots } = await makeFixture(t);
  assert.throws(() => createGraphPanelModel(null), GraphPanelModelError);
  assert.throws(() => createGraphPanelModel({ projects: [{ id: 'api' }], nodes: [{ id: 'x', type: 'project', project: 'missing' }], edges: [] }), GraphPanelModelError);
  assert.throws(() => createGraphPanelModel({ projects: [{ id: 'api' }], nodes: [], edges: [{ id: 'e', from: 'a', to: 'b' }] }), GraphPanelModelError);
  assert.throws(() => createGraphPanelModel({ projects: Array.from({ length: 33 }, (_, index) => ({ id: 'p' + index })), nodes: [], edges: [] }), GraphPanelModelError);
  assert.throws(() => createGraphPanelModel({
    projects: [{ id: 'api' }],
    nodes: [{ id: 'symbol:api:bidi', type: 'symbol', project: 'api', name: 'safe\u202Eevil', file: 'src/a.ts', line: 1, column: 1 }],
    edges: [],
  }), GraphPanelModelError);
  const tooManyRoots = Object.fromEntries(Array.from({ length: 33 }, (_, index) => ['p' + index, os.tmpdir()]));
  assert.throws(() => createGraphPanelModel({ projects: [{ id: 'api' }], nodes: [], edges: [] }, { projectRoots: tooManyRoots }), GraphPanelModelError);
  assert.throws(() => renderGraphPanelHtml({ level: 'workspace', nodes: [], edges: [], counts: { total: 0, shown: 0 }, crumbs: [], truncated: false }, { nonce: 'bad" onload="x' }), GraphPanelModelError);

  const escapeModel = createGraphPanelModel({
    projects: [{ id: 'api' }],
    nodes: [
      { id: 'project:api', type: 'project', project: 'api' },
      { id: 'symbol:api:escape', type: 'symbol', project: 'api', name: 'escape', file: '../escape.mjs', line: 1, column: 1 },
    ],
    edges: [],
  }, { projectRoots: roots });
  escapeModel.handleNodeClick('project:api');
  assert.throws(() => escapeModel.handleNodeClick('symbol:api:escape'), GraphPanelModelError);

  const adsModel = createGraphPanelModel({
    projects: [{ id: 'api' }],
    nodes: [
      { id: 'project:api', type: 'project', project: 'api' },
      { id: 'module:api:src/a.ts', type: 'module', project: 'api', file: 'src/a.ts' },
      { id: 'symbol:api:ads', type: 'symbol', project: 'api', name: 'ads', file: 'src/a.ts:stream', line: 1, column: 1 },
    ],
    edges: [],
  }, { projectRoots: roots });
  adsModel.handleNodeClick('project:api');
  adsModel.handleNodeClick('module:api:src/a.ts');
  assert.throws(() => adsModel.handleNodeClick('symbol:api:ads'), GraphPanelModelError);

  assert.throws(() => {
    const missingRoot = createGraphPanelModel(graph, { projectRoots: {} });
    missingRoot.handleNodeClick(nodeId(graph, 'project', 'web'));
    missingRoot.handleNodeClick(nodeId(graph, 'module', 'web', (node) => node.file === 'src/client.ts'));
    missingRoot.handleNodeClick(nodeId(graph, 'symbol', 'web', (node) => node.file === 'src/client.ts'));
  }, GraphPanelModelError);
});
