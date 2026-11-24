'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const GRAPH_PANEL_VERSION = 1;
const MAX_VIEW_NODES = 200;
const MAX_VIEW_EDGES = 500;
const MAX_GRAPH_NODES = 20_000;
const MAX_GRAPH_EDGES = 40_000;
const MAX_PROJECTS = 32;
const MAX_LABEL = 220;
const MAX_FILE = 8_192;
const MAX_ID = 8_192;
const SAFE_TYPE = /^[a-z][a-z0-9-]{0,63}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const SOURCE_TRUST = 'untrusted-repository-content';

class GraphPanelModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphPanelModelError';
  }
}

function fail(message) {
  throw new GraphPanelModelError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maximum, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) fail(label + ' is invalid');
  return value;
}

function positiveInteger(value, label, maximum = 10_000_000) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) fail(label + ' is invalid');
  return value;
}

function nodeLabel(node) {
  if (node.type === 'project') return node.project;
  if (node.name) return node.name;
  if (node.path) return node.method ? node.method + ' ' + node.path : node.path;
  if (node.file) return node.file.split('/').pop() || node.file;
  if (node.image) return node.image;
  if (node.port) return ':' + node.port;
  const pieces = node.id.split(':');
  return pieces[pieces.length - 1] || node.id;
}

function graphSnapshot(value) {
  let raw = value;
  if (raw && typeof raw.toJSON === 'function') {
    try {
      raw = raw.toJSON();
    } catch {
      fail('graph could not be read');
    }
  }
  if (!isPlainObject(raw)) fail('graph must be an object');
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) fail('graph projects are invalid');
  if (!Array.isArray(raw.nodes)) fail('graph nodes are invalid');
  if (!Array.isArray(raw.edges)) fail('graph edges are invalid');
  if (raw.projects.length > MAX_PROJECTS) fail('graph exceeds the project cap');
  if (raw.nodes.length > MAX_GRAPH_NODES) fail('graph exceeds the node cap');
  if (raw.edges.length > MAX_GRAPH_EDGES) fail('graph exceeds the edge cap');

  const projectIds = new Set();
  const projects = raw.projects.map((project) => {
    if (!isPlainObject(project)) fail('graph project is invalid');
    const id = text(project.id, 64, 'project id');
    if (!PROJECT_ID.test(id)) fail('project id is invalid');
    const key = id.toLowerCase();
    if (projectIds.has(key)) fail('graph project is duplicated');
    projectIds.add(key);
    return { id };
  });
  const exactProjectIds = new Set(projects.map((project) => project.id));
  const nodes = [];
  const nodeById = new Map();
  for (const rawNode of raw.nodes) {
    if (!isPlainObject(rawNode)) fail('graph node is invalid');
    const id = text(rawNode.id, MAX_ID, 'node id');
    const type = text(rawNode.type, 64, 'node type');
    if (!SAFE_TYPE.test(type)) fail('node type is invalid');
    const project = text(rawNode.project, 64, 'node project');
    if (!exactProjectIds.has(project)) fail('node project is not in the graph');
    if (nodeById.has(id)) fail('graph node id is duplicated');
    const node = { id, type, project };
    if (rawNode.file !== undefined) node.file = text(rawNode.file, MAX_FILE, 'node file');
    if (rawNode.line !== undefined) node.line = positiveInteger(rawNode.line, 'node line');
    if (rawNode.column !== undefined) node.column = positiveInteger(rawNode.column, 'node column');
    if (rawNode.name !== undefined) node.name = text(rawNode.name, MAX_LABEL, 'node name');
    if (rawNode.kind !== undefined) node.kind = text(rawNode.kind, 64, 'node kind');
    if (rawNode.container !== undefined) node.container = text(rawNode.container, MAX_LABEL, 'node container');
    if (rawNode.method !== undefined) node.method = text(rawNode.method, 16, 'node method');
    if (rawNode.path !== undefined) node.path = text(rawNode.path, 4_096, 'node path');
    if (rawNode.port !== undefined) node.port = positiveInteger(rawNode.port, 'node port', 65_535);
    if (rawNode.image !== undefined) node.image = text(rawNode.image, 512, 'node image');
    nodes.push(Object.freeze(node));
    nodeById.set(id, node);
  }
  const edgeIds = new Set();
  const edges = [];
  for (const rawEdge of raw.edges) {
    if (!isPlainObject(rawEdge)) fail('graph edge is invalid');
    const id = text(rawEdge.id, MAX_ID, 'edge id');
    const type = text(rawEdge.type, 64, 'edge type');
    if (!SAFE_TYPE.test(type)) fail('edge type is invalid');
    const from = text(rawEdge.from, MAX_ID, 'edge from');
    const to = text(rawEdge.to, MAX_ID, 'edge to');
    if (!nodeById.has(from) || !nodeById.has(to)) fail('graph edge references a missing node');
    if (edgeIds.has(id)) fail('graph edge id is duplicated');
    edgeIds.add(id);
    edges.push(Object.freeze({ id, type, from, to }));
  }
  return { projects, nodes, edges };
}

function projectRootMap(roots) {
  const map = new Map();
  if (roots === undefined || roots === null) return map;
  if (roots instanceof Map) {
    for (const [id, root] of roots) {
      map.set(text(id, 64, 'project root id'), path.resolve(text(root, 4_096, 'project root')));
    }
    return map;
  }
  if (!isPlainObject(roots)) fail('project roots must be an object');
  for (const [id, root] of Object.entries(roots)) {
    map.set(text(id, 64, 'project root id'), path.resolve(text(root, 4_096, 'project root')));
  }
  return map;
}

function safeRelativeFile(file) {
  const value = text(file, MAX_FILE, 'source file');
  if (value.includes('\\') || value.includes(':') || value.includes('\0') || value.trim() !== value) fail('source file is invalid');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail('source file is invalid');
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.split('/').some((part) => part === '..')) {
    fail('source file is invalid');
  }
  return normalized;
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

class GraphPanelModel {
  constructor(graph, options = {}) {
    if (!isPlainObject(options)) fail('options must be an object');
    const snapshot = graphSnapshot(graph);
    this.version = GRAPH_PANEL_VERSION;
    this.projects = Object.freeze(snapshot.projects.map((project) => Object.freeze({ id: project.id })));
    this.nodes = Object.freeze(snapshot.nodes);
    this.edges = Object.freeze(snapshot.edges);
    this.projectRoots = projectRootMap(options.projectRoots);
    this.byId = new Map(this.nodes.map((node) => [node.id, node]));
    this.level = 'workspace';
    this.projectId = null;
    this.moduleId = null;
    this.symbolId = null;
    this.#index();
  }

  #projectNodes;
  #modulesByFile;
  #symbolsByModule;
  #routesByModule;
  #nodesByProject;

  #index() {
    this.#projectNodes = new Map();
    this.#modulesByFile = new Map();
    this.#symbolsByModule = new Map();
    this.#routesByModule = new Map();
    this.#nodesByProject = new Map(this.projects.map((project) => [project.id, []]));
    for (const node of this.nodes) {
      this.#nodesByProject.get(node.project).push(node);
      if (node.type === 'project') this.#projectNodes.set(node.project, node);
      if (node.type === 'module' && node.file) this.#modulesByFile.set(node.project + '\0' + node.file, node);
    }
    for (const node of this.nodes) {
      if ((node.type !== 'symbol' && node.type !== 'route') || !node.file) continue;
      const module = this.#modulesByFile.get(node.project + '\0' + node.file);
      if (!module) continue;
      const byModule = node.type === 'route' ? this.#routesByModule : this.#symbolsByModule;
      if (!byModule.has(module.id)) byModule.set(module.id, []);
      byModule.get(module.id).push(node);
    }
    for (const list of [...this.#symbolsByModule.values(), ...this.#routesByModule.values()]) {
      list.sort((left, right) => (left.line || 1) - (right.line || 1) ||
        (left.column || 1) - (right.column || 1) || compareText(nodeLabel(left), nodeLabel(right)));
    }
  }

  #projectNode(project) {
    return this.#projectNodes.get(project) || { id: 'project:' + project, type: 'project', project };
  }

  #bounded(nodes, total) {
    return {
      nodes: nodes.slice(0, MAX_VIEW_NODES),
      total,
      truncated: total > MAX_VIEW_NODES,
    };
  }

  #visibleEdges(nodes) {
    const visible = new Set(nodes.map((node) => node.id));
    return this.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)).slice(0, MAX_VIEW_EDGES);
  }

  #crumbs() {
    const crumbs = [{ level: 'workspace', id: null, label: 'Workspace' }];
    if (this.projectId) crumbs.push({ level: 'project', id: this.projectId, label: this.projectId });
    if (this.moduleId) {
      const module = this.byId.get(this.moduleId);
      crumbs.push({ level: 'module', id: this.moduleId, label: module && module.file ? module.file : this.moduleId });
    }
    if (this.symbolId) {
      const symbol = this.byId.get(this.symbolId);
      crumbs.push({ level: 'symbol', id: this.symbolId, label: symbol ? nodeLabel(symbol) : this.symbolId });
    }
    return crumbs;
  }

  view() {
    let nodes;
    let total;
    if (this.level === 'project') {
      const project = this.projectId;
      const modules = (this.#nodesByProject.get(project) || [])
        .filter((node) => node.type === 'module')
        .sort((left, right) => compareText(left.file, right.file));
      const bounded = this.#bounded(modules, modules.length);
      nodes = bounded.nodes;
      total = bounded.total;
      return this.#result(nodes, total, bounded.truncated);
    }
    if (this.level === 'module') {
      const module = this.byId.get(this.moduleId);
      if (!module) fail('module is not in the graph');
      const symbols = this.#symbolsByModule.get(module.id) || [];
      const routes = this.#routesByModule.get(module.id) || [];
      const combined = [module, ...symbols, ...routes];
      const bounded = this.#bounded(combined, combined.length);
      return this.#result(bounded.nodes, bounded.total, bounded.truncated);
    }
    if (this.level === 'symbol') {
      const symbol = this.byId.get(this.symbolId);
      if (!symbol) fail('symbol is not in the graph');
      return this.#result([symbol], 1, false);
    }
    const projects = this.projects
      .map((project) => this.#projectNode(project.id))
      .sort((left, right) => compareText(left.project, right.project));
    const bounded = this.#bounded(projects, projects.length);
    nodes = bounded.nodes;
    total = bounded.total;
    return this.#result(nodes, total, bounded.truncated);
  }

  #result(nodes, total, truncated) {
    return Object.freeze({
      version: this.version,
      level: this.level,
      title: this.level === 'workspace' ? 'Workspace' : this.level === 'project' ? this.projectId :
        this.level === 'module' ? (this.byId.get(this.moduleId) || {}).file || this.moduleId :
          (this.byId.get(this.symbolId) || {}).name || this.symbolId,
      nodes: Object.freeze(nodes.map((node) => Object.freeze({ ...node, label: nodeLabel(node), sourceTrust: SOURCE_TRUST }))),
      edges: Object.freeze(this.#visibleEdges(nodes).map((edge) => Object.freeze({ ...edge, sourceTrust: SOURCE_TRUST }))),
      counts: Object.freeze({ total, shown: nodes.length }),
      truncated,
      crumbs: Object.freeze(this.#crumbs()),
      sourceTrust: SOURCE_TRUST,
    });
  }

  handleNodeClick(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) fail('node id is invalid');
    const node = this.byId.get(id);
    if (!node) fail('node is not in the graph');
    if (node.type === 'project') {
      this.level = 'project';
      this.projectId = node.project;
      this.moduleId = null;
      this.symbolId = null;
      return { kind: 'zoom', level: 'project' };
    }
    if (node.type === 'module') {
      this.level = 'module';
      this.projectId = node.project;
      this.moduleId = node.id;
      this.symbolId = null;
      return { kind: 'zoom', level: 'module' };
    }
    if (node.type === 'symbol') {
      this.projectId = node.project;
      if (node.file) {
        this.moduleId = (this.#modulesByFile.get(node.project + '\0' + node.file) || {}).id || null;
      }
      this.level = 'symbol';
      this.symbolId = node.id;
      return this.#open(node);
    }
    return this.#open(node);
  }

  #open(node) {
    if (typeof node.file !== 'string' || node.file.length === 0) fail('node has no source file');
    const file = safeRelativeFile(node.file);
    const root = this.projectRoots.get(node.project);
    if (!root) fail('project root is not available');
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('source file escapes the project root');
    return {
      kind: 'open',
      project: node.project,
      file,
      line: node.line || 1,
      column: node.column || 1,
      absolutePath: absolute,
      sourceTrust: SOURCE_TRUST,
    };
  }

  reset() {
    this.level = 'workspace';
    this.projectId = null;
    this.moduleId = null;
    this.symbolId = null;
  }
}

function createGraphPanelModel(graph, options = {}) {
  return new GraphPanelModel(graph, options);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function createNonce() {
  return crypto.randomBytes(16).toString('base64url');
}

function renderNode(node) {
  const action = node.type === 'project' || node.type === 'module' ? 'zoom' : (node.file ? 'open' : 'none');
  const label = node.label || nodeLabel(node);
  const detail = node.type === 'project' ? '' : node.type === 'module' ? node.file || '' : node.name || node.file || '';
  return [
    '<button type="button" class="graph-node ' + escapeHtml(node.type) + '"',
    ' data-node-id="' + escapeHtml(node.id) + '"',
    ' data-action="' + action + '"',
    ' aria-label="' + escapeHtml(label) + '">',
    '<span class="node-label">' + escapeHtml(label) + '</span>',
    '<span class="node-type">' + escapeHtml(node.type) + '</span>',
    detail ? '<span class="node-detail">' + escapeHtml(detail) + '</span>' : '',
    '</button>',
  ].join('');
}

function renderEdge(edge) {
  return '<li class="graph-edge" data-edge-id="' + escapeHtml(edge.id) + '">' +
    '<span class="edge-type">' + escapeHtml(edge.type) + '</span>' +
    '<span class="edge-flow">' + escapeHtml(edge.from) + ' -&gt; ' + escapeHtml(edge.to) + '</span></li>';
}

function renderGraphPanelHtml(view, options = {}) {
  if (!isPlainObject(view) || !Array.isArray(view.nodes) || !Array.isArray(view.edges)) fail('view is invalid');
  if (view.nodes.length > MAX_VIEW_NODES || view.edges.length > MAX_VIEW_EDGES) fail('view exceeds the render cap');
  const nonce = options.nonce === undefined ? createNonce() : text(options.nonce, 128, 'nonce');
  if (!SAFE_NONCE.test(nonce)) fail('nonce is invalid');
  const level = text(view.level || 'workspace', 32, 'level');
  const title = escapeHtml(view.title || 'Vibe Graph');
  const nodes = view.nodes.map(renderNode).join('');
  const edges = view.edges.map(renderEdge).join('');
  const crumbs = Array.isArray(view.crumbs) ? view.crumbs.map((crumb) => {
    const label = escapeHtml(crumb.label || crumb.level || '');
    return '<span class="crumb" data-level="' + escapeHtml(crumb.level || '') + '">' + label + '</span>';
  }).join('<span class="crumb-separator" aria-hidden="true">/</span>') : '';
  const counts = view.counts && Number.isInteger(view.counts.shown) && Number.isInteger(view.counts.total) ? view.counts : { total: view.nodes.length, shown: view.nodes.length };
  const truncated = view.truncated ? '<p class="notice" role="status">Showing ' + counts.shown + ' of ' + counts.total +
    ' nodes. Zoom into a project or module to narrow the view.</p>' : '';
  const csp = "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce +
    "'; img-src 'none'; base-uri 'none'; form-action 'none';";
  const script = [
    "const vscode = acquireVsCodeApi();",
    "document.addEventListener('click', (event) => {",
    "  const node = event.target.closest('[data-node-id]');",
    "  if (!node) return;",
    "  const action = node.getAttribute('data-action');",
    "  if (action === 'zoom' || action === 'open') {",
    "    vscode.postMessage({ type: 'nodeClick', nodeId: node.getAttribute('data-node-id') });",
    '  }',
    '});',
    "const reset = document.getElementById('reset');",
    "if (reset) reset.addEventListener('click', () => vscode.postMessage({ type: 'reset' }));",
  ].join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<title>' + title + '</title>',
    '<style nonce="' + nonce + '">',
    'body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); margin: 0; }',
    'header { padding: 14px 18px 8px; border-bottom: 1px solid var(--vscode-panel-border); }',
    'header h1 { font-size: 16px; margin: 0 0 8px; }',
    'nav { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }',
    '.crumb { color: var(--vscode-descriptionForeground); }',
    '.crumb:last-child { color: var(--vscode-foreground); font-weight: 600; }',
    'main { padding: 14px 18px 24px; }',
    '.graph-nodes { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }',
    '.graph-node { text-align: left; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; padding: 10px 12px; cursor: pointer; min-height: 64px; }',
    '.graph-node:hover { background: var(--vscode-button-hoverBackground); }',
    '.graph-node:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }',
    '.node-label { display: block; font-weight: 600; overflow-wrap: anywhere; }',
    '.node-type, .node-detail { display: block; font-size: 11px; opacity: .8; overflow-wrap: anywhere; }',
    '.graph-edges { padding-left: 18px; color: var(--vscode-descriptionForeground); }',
    '.graph-edge { margin: 4px 0; }',
    '.edge-type { font-weight: 600; margin-right: 8px; }',
    '.notice { color: var(--vscode-descriptionForeground); margin: 12px 0 0; }',
    'button#reset { margin-top: 12px; }',
    '</style>',
    '</head>',
    '<body>',
    '<header>',
    '<h1>' + title + ' <span class="node-type">' + escapeHtml(level) + '</span></h1>',
    '<nav aria-label="Graph zoom path">' + crumbs + '</nav>',
    '</header>',
    '<main>',
    '<section class="graph-nodes" aria-label="Graph nodes">' + nodes + '</section>',
    '<button type="button" id="reset">Back to workspace</button>',
    '<p class="notice" role="status">Showing ' + counts.shown + ' of ' + counts.total + ' nodes.</p>',
    truncated,
    edges ? '<ul class="graph-edges" aria-label="Graph edges">' + edges + '</ul>' : '',
    '</main>',
    '<script nonce="' + nonce + '">',
    script,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

function createGraphPanelController(input = {}) {
  if (!isPlainObject(input)) fail('controller options must be an object');
  const { vscode, graphProvider, extensionUri } = input;
  if (!vscode || typeof vscode !== 'object') fail('vscode is required');
  if (typeof graphProvider !== 'function') fail('graphProvider is required');
  let panel = null;
  let model = null;

  function readProvider() {
    const data = graphProvider();
    if (!data) return null;
    return data;
  }

  function load(data) {
    if (!data) {
      model = null;
      return;
    }
    const graph = data.graph || data;
    const roots = data.projectRoots || data.roots;
    model = createGraphPanelModel(graph, { projectRoots: roots });
  }

  function refresh() {
    if (panel && model) panel.webview.html = renderGraphPanelHtml(model.view());
  }

  async function openSource(result) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(result.absolutePath));
    const line = result.line - 1;
    const column = result.column - 1;
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(line, column, line, column),
      preview: false,
    });
  }

  async function handle(message) {
    if (!message || typeof message !== 'object') return { handled: false, reason: 'invalid-message' };
    if (message.type === 'reset') {
      if (!model) return { handled: false, reason: 'no-graph' };
      model.reset();
      refresh();
      return { handled: true, kind: 'reset', level: 'workspace' };
    }
    if (message.type !== 'nodeClick' || typeof message.nodeId !== 'string') {
      return { handled: false, reason: 'invalid-message' };
    }
    if (!model) return { handled: false, reason: 'no-graph' };
    const result = model.handleNodeClick(message.nodeId);
    if (result.kind === 'zoom') refresh();
    if (result.kind === 'open') {
      await openSource(result);
      refresh();
    }
    return { handled: true, ...result };
  }

  function open() {
    const data = readProvider();
    if (!panel) {
      if (!data) {
        vscode.window.showInformationMessage('Vibe Graph: no indexed graph is available yet.');
        return;
      }
      load(data);
      panel = vscode.window.createWebviewPanel('vibecodium.graph', 'Vibe Graph', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: extensionUri ? [extensionUri] : [],
      });
      panel.webview.onDidReceiveMessage(async (message) => {
        try {
          await handle(message);
        } catch (error) {
          if (panel) vscode.window.showWarningMessage('Vibe Graph: the selected item could not be opened.');
        }
      });
      panel.onDidDispose(() => {
        panel = null;
        model = null;
      });
      refresh();
      return;
    }
    if (data) load(data);
    refresh();
    panel.reveal();
  }

  function setGraph(data) {
    load(data);
    refresh();
  }

  function view() {
    return model ? model.view() : null;
  }

  function dispose() {
    if (panel) panel.dispose();
  }

  return { open, setGraph, view, dispose, handleMessage: handle };
}

module.exports = {
  GRAPH_PANEL_VERSION,
  GraphPanelModel,
  GraphPanelModelError,
  createGraphPanelController,
  createGraphPanelModel,
  renderGraphPanelHtml,
};
