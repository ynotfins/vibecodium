'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const API_SOURCE = [
  "import express from 'express';",
  'export const app = express();',
  'export function getUser(id: string) { return { id }; }',
  "app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));",
  '',
].join('\n');

const WEB_SOURCE = [
  'export async function loadUser(id: string) {',
  '  const response = await fetch(`http://localhost:3000/api/users/${id}`);',
  '  return response.json();',
  '}',
  '',
].join('\n');

async function writeFixture(root) {
  const apiRoot = path.join(root, 'api');
  const webRoot = path.join(root, 'web');
  await fs.mkdir(path.join(apiRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(webRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(apiRoot, 'src', 'server.ts'), API_SOURCE);
  await fs.writeFile(path.join(webRoot, 'src', 'client.ts'), WEB_SOURCE);
  return { apiRoot, webRoot };
}

function fixtureGraph(roots) {
  return {
    projects: [{ id: 'api' }, { id: 'web' }],
    nodes: [
      { id: 'project:api', type: 'project', project: 'api' },
      { id: 'project:web', type: 'project', project: 'web' },
      { id: 'module:api:src/server.ts', type: 'module', project: 'api', file: 'src/server.ts' },
      {
        id: 'symbol:api:src/server.ts:getUser',
        type: 'symbol',
        project: 'api',
        name: 'getUser',
        file: 'src/server.ts',
        line: 3,
        column: 17,
      },
      { id: 'module:web:src/client.ts', type: 'module', project: 'web', file: 'src/client.ts' },
      {
        id: 'symbol:web:src/client.ts:loadUser',
        type: 'symbol',
        project: 'web',
        name: 'loadUser',
        file: 'src/client.ts',
        line: 1,
        column: 23,
      },
    ],
    edges: [
      {
        id: 'edge:loadUser:getUser',
        type: 'http-route-caller',
        from: 'symbol:web:src/client.ts:loadUser',
        to: 'symbol:api:src/server.ts:getUser',
      },
    ],
    projectRoots: { api: roots.apiRoot, web: roots.webRoot },
  };
}

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('vibecodium.vibecodium-ai');
  assert.ok(extension, 'the vibecodium-ai extension is loaded');
  const api = await extension.activate();
  assert.equal(typeof api.setGraph, 'function');
  assert.equal(typeof api.open, 'function');
  assert.equal(typeof api.getView, 'function');
  assert.equal(typeof api.getPanelHtml, 'function');
  assert.equal(typeof api.activateNode, 'function');
  assert.equal(typeof api.dispose, 'function');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibecodium-graph-ide-'));
  try {
    const roots = await writeFixture(root);
    api.setGraph(fixtureGraph(roots));
    api.open();

    const workspaceView = api.getView();
    assert.equal(workspaceView.level, 'workspace');
    assert.deepEqual(workspaceView.nodes.map((node) => node.id).sort(), ['project:api', 'project:web']);
    const workspaceHtml = api.getPanelHtml();
    assert.match(workspaceHtml, /Graph nodes/);
    assert.match(workspaceHtml, /data-node-id="project:api"/);
    assert.match(workspaceHtml, /data-node-id="project:web"/);

    await api.activateNode('project:web');
    assert.equal(api.getView().level, 'project');
    assert.ok(api.getPanelHtml().includes('data-node-id="module:web:src/client.ts"'));

    await api.activateNode('module:web:src/client.ts');
    assert.equal(api.getView().level, 'module');
    assert.ok(api.getPanelHtml().includes('data-node-id="symbol:web:src/client.ts:loadUser"'));

    const opened = await api.activateNode('symbol:web:src/client.ts:loadUser');
    assert.equal(opened.kind, 'open');
    assert.equal(api.getView().level, 'symbol');

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'the selected source opens in an editor');
    assert.equal(
      path.resolve(editor.document.uri.fsPath).toLowerCase(),
      path.resolve(roots.webRoot, 'src', 'client.ts').toLowerCase(),
    );
    assert.equal(editor.selection.active.line, 0);
    assert.equal(editor.selection.active.character, 22);
    assert.match(api.getPanelHtml(), /Showing 1 of 1 nodes/);
  } finally {
    try {
      api.dispose();
    } catch {}
    const temporaryRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(root);
    if (resolved.startsWith(temporaryRoot + path.sep)) {
      await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
    }
  }
  console.log('GRAPH_PANEL_IDE_OK');
};
