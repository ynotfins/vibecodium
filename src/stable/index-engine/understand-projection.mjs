// Read-only projection of the cross-project graph into the Understand-Anything knowledge graph.
//
// The graph engine remains the only owner of cross-project edges. This module only
// re-expresses an already validated CrossProjectGraph snapshot in the Understand-Anything
// knowledge-graph.json shape (version 1.0.0), so its dashboard and agent tools can read it.
// It copies identifiers, paths and identifiers only; it never reads or emits source text.
import { CrossProjectGraph, MAX_EDGES, MAX_NODES } from './cross-project-graph.mjs';

export const UNDERSTAND_GRAPH_VERSION = '1.0.0';
export const UNDERSTAND_PROJECTION_VERSION = 1;
export const UNDERSTAND_SOURCE_TRUST = 'untrusted-repository-content';
export const MAX_PROJECTION_NODES = MAX_NODES;
export const MAX_PROJECTION_EDGES = MAX_EDGES;

const MAX_NODE_ID_LENGTH = 8_192;
const NODE_TYPES = new Set([
  'file', 'function', 'class', 'module', 'concept', 'config', 'document', 'service',
  'table', 'endpoint', 'pipeline', 'schema', 'resource',
]);
const EDGE_TYPES = new Set([
  'imports', 'exports', 'contains', 'inherits', 'implements',
  'calls', 'subscribes', 'publishes', 'middleware',
  'reads_from', 'writes_to', 'transforms', 'validates',
  'depends_on', 'tested_by', 'configures',
  'related', 'similar_to',
  'deploys', 'serves', 'provisions', 'triggers',
  'migrates', 'documents', 'routes', 'defines_schema',
]);
const FILE_LEVEL_TYPES = new Set([
  'file', 'config', 'document', 'service', 'pipeline', 'table', 'schema', 'resource', 'endpoint',
]);
const EDGE_WEIGHTS = Object.freeze({
  imports: 0.7,
  exports: 0.8,
  contains: 1,
  calls: 0.8,
  reads_from: 0.5,
  writes_to: 0.5,
  depends_on: 0.6,
  related: 0.5,
  deploys: 0.7,
  serves: 0.5,
  routes: 0.5,
});
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
export class UnderstandProjectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnderstandProjectionError';
  }
}

function fail(message) {
  throw new UnderstandProjectionError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label, maximum = 2_048) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || CONTROL.test(value)) {
    fail(label + ' is invalid');
  }
  return value;
}

function safeLabel(value) {
  return String(value).replace(CONTROL_ALL, '?').slice(0, 128);
}

function normalizeList(value, fallback, label) {
  const list = value === undefined ? fallback : value;
  if (!Array.isArray(list) || list.length > 32) fail(label + ' is invalid');
  return [...new Set(list.map((item) => requireText(item, label + ' item', 64)))];
}

function snapshotOf(graph) {
  if (graph instanceof CrossProjectGraph) return graph.toJSON();
  if (isPlainObject(graph) && typeof graph.toJSON === 'function') {
    return new CrossProjectGraph(graph.toJSON()).toJSON();
  }
  return new CrossProjectGraph(graph).toJSON();
}

function segment(value) {
  return encodeURIComponent(String(value));
}

function basenameOf(file) {
  const index = file.lastIndexOf('/');
  return index === -1 ? file : file.slice(index + 1);
}

function extensionOf(file) {
  const name = basenameOf(file);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function languageOf(extension) {
  switch (extension) {
    case 'cjs':
    case 'js':
    case 'jsx':
    case 'mjs':
      return 'javascript';
    case 'cts':
    case 'mts':
    case 'ts':
    case 'tsx':
      return 'typescript';
    default:
      return extension;
  }
}

function fileTags(file) {
  const extension = extensionOf(file);
  return /^[a-z0-9]{1,16}$/.test(extension) ? ['source', extension] : ['source'];
}

function projectPath(project, file) {
  return project + '/' + file;
}

function toUnderstandNode(node) {
  switch (node.type) {
    case 'project':
      return {
        id: 'module:project:' + segment(node.project),
        type: 'module',
        name: node.project,
        summary: 'Project ' + node.project + '.',
        tags: ['project', 'module'],
      };
    case 'module':
      return {
        id: 'file:' + segment(node.project) + ':' + segment(node.file),
        type: 'file',
        name: basenameOf(node.file),
        filePath: projectPath(node.project, node.file),
        summary: 'Source file ' + node.file + ' in project ' + node.project + '.',
        tags: fileTags(node.file),
      };
    case 'symbol': {
      const name = node.container ? node.container + '.' + node.name : node.name;
      return {
        id: 'function:' + segment(node.project) + ':' + segment(node.file) + ':' + node.line + ':' + node.column + ':' + segment(node.name),
        type: 'function',
        name,
        filePath: projectPath(node.project, node.file),
        summary: node.kind + ' ' + name + ' in ' + node.file + ' (project ' + node.project + ').',
        tags: ['symbol', node.kind],
        line: node.line,
        column: node.column,
      };
    }
    case 'route':
      return {
        id: 'endpoint:' + segment(node.project) + ':' + segment(node.method) + ':' + segment(node.path),
        type: 'endpoint',
        name: node.method + ' ' + node.path,
        filePath: projectPath(node.project, node.file),
        summary: 'HTTP ' + node.method + ' ' + node.path + ' served by project ' + node.project + '.',
        tags: ['route', 'http', node.method.toLowerCase()],
        line: node.line,
        column: node.column,
      };
    case 'package':
      return {
        id: 'module:package:' + segment(node.project) + ':' + segment(node.name),
        type: 'module',
        name: node.name,
        summary: 'Package ' + node.name + ' used by project ' + node.project + '.',
        tags: ['package', 'dependency'],
      };
    case 'env':
      return {
        id: 'concept:env:' + segment(node.project) + ':' + segment(node.name),
        type: 'concept',
        name: node.name,
        summary: 'Environment variable ' + node.name + ' used by project ' + node.project + '.',
        tags: ['environment', 'configuration'],
      };
    case 'port':
      return {
        id: 'resource:port:' + segment(node.project) + ':' + node.port,
        type: 'resource',
        name: 'port ' + node.port,
        summary: 'Port ' + node.port + ' exposed by project ' + node.project + '.',
        tags: ['port', 'network'],
      };
    case 'database-table':
      return {
        id: 'table:' + segment(node.project) + ':' + segment(node.name),
        type: 'table',
        name: node.name,
        summary: 'Database table ' + node.name + ' used by project ' + node.project + '.',
        tags: ['database', 'table'],
      };
    case 'mcp-tool':
      return {
        id: 'endpoint:mcp:' + segment(node.project) + ':' + segment(node.name),
        type: 'endpoint',
        name: node.name,
        summary: 'MCP tool ' + node.name + ' exposed by project ' + node.project + '.',
        tags: ['mcp', 'tool'],
      };
    case 'container':
      return {
        id: 'service:' + segment(node.project) + ':' + segment(node.image),
        type: 'service',
        name: node.image,
        summary: 'Container image ' + node.image + ' used by project ' + node.project + '.',
        tags: ['container', 'service'],
      };
    default:
      fail('graph node type cannot be projected');
  }
}

function toUnderstandEdge(edge) {
  switch (edge.type) {
    case 'project-module':
      return 'contains';
    case 'route-definition':
      return 'routes';
    case 'import':
      return 'imports';
    case 'package-dependency':
      return 'depends_on';
    case 'env-use':
      return 'reads_from';
    case 'exposes-port':
      return 'serves';
    case 'database-table-use':
      return 'related';
    case 'mcp-tool':
      return 'exports';
    case 'container-image':
      return 'deploys';
    case 'http-route-caller':
      return 'calls';
    default:
      fail('graph edge type cannot be projected');
  }
}

function buildLayers(records, projects) {
  return projects.map((project) => {
    const nodeIds = records.filter((record) => record.project === project).map((record) => record.node.id);
    if (nodeIds.length === 0) fail('project has no projected nodes');
    return {
      id: 'layer:project:' + segment(project),
      name: project,
      description: 'Project ' + project + ' and its files, symbols and interfaces.',
      nodeIds,
    };
  });
}

function buildTour(records) {
  const steps = [];
  const projects = records.filter((record) => record.graphNode.type === 'project').map((record) => record.node.id);
  if (projects.length > 0) {
    steps.push({
      order: steps.length + 1,
      title: 'Projects',
      description: 'Start with the projects in this workspace.',
      nodeIds: projects,
    });
  }
  const files = records.filter((record) => record.graphNode.type === 'module').map((record) => record.node.id);
  if (files.length > 0) {
    steps.push({
      order: steps.length + 1,
      title: 'Source files',
      description: 'Source files that carry the cross-project edges.',
      nodeIds: files,
    });
  }
  const interfaces = records
    .filter((record) => record.graphNode.type === 'route' || record.graphNode.type === 'mcp-tool')
    .map((record) => record.node.id);
  if (interfaces.length > 0) {
    steps.push({
      order: steps.length + 1,
      title: 'Routes and tools',
      description: 'HTTP routes and MCP tools exposed by the projects.',
      nodeIds: interfaces,
    });
  }
  return steps;
}

export function projectToUnderstandGraph(graph, options = {}) {
  if (!isPlainObject(options)) fail('options must be an object');
  const snapshot = snapshotOf(graph);
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges) || !Array.isArray(snapshot.projects)) {
    fail('graph snapshot is invalid');
  }
  if (snapshot.nodes.length === 0 || snapshot.nodes.length > MAX_PROJECTION_NODES) {
    fail('graph exceeds the Understand projection node cap');
  }
  if (snapshot.edges.length > MAX_PROJECTION_EDGES) fail('graph exceeds the Understand projection edge cap');
  const projects = snapshot.projects.map((project) => project.id);
  if (projects.length === 0) fail('graph has no projects');
  const records = snapshot.nodes.map((graphNode) => ({
    project: graphNode.project,
    graphNode,
    node: { ...toUnderstandNode(graphNode), sourceTrust: UNDERSTAND_SOURCE_TRUST },
  }));
  const nodeIds = new Set();
  for (const record of records) {
    if (!NODE_TYPES.has(record.node.type)) fail('projected node type is invalid');
    if (typeof record.node.id !== 'string' || record.node.id.length > MAX_NODE_ID_LENGTH) {
      fail('projected node id is invalid');
    }
    if (nodeIds.has(record.node.id)) fail('projected node id is duplicated');
    nodeIds.add(record.node.id);
    requireText(record.node.name, 'projected node name', 512);
    requireText(record.node.summary, 'projected node summary', 2_048);
    if (!Array.isArray(record.node.tags) || record.node.tags.length === 0) fail('projected node tags are invalid');
  }
  const idMap = new Map(records.map((record) => [record.graphNode.id, record.node.id]));
  const seenEdges = new Set();
  const edges = [];
  for (const edge of snapshot.edges) {
    const type = toUnderstandEdge(edge);
    if (!EDGE_TYPES.has(type)) fail('projected edge type is invalid');
    const source = idMap.get(edge.from);
    const target = idMap.get(edge.to);
    if (!source || !target) fail('projected edge references a missing node');
    const key = source + '\u0000' + target + '\u0000' + type;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ source, target, type, weight: EDGE_WEIGHTS[type], sourceTrust: UNDERSTAND_SOURCE_TRUST });
    if (edges.length > MAX_PROJECTION_EDGES) fail('projected graph exceeds the edge cap');
  }
  const detected = new Set(records
    .filter((record) => record.graphNode.type === 'module')
    .map((record) => languageOf(extensionOf(record.graphNode.file)))
    .filter((language) => /^[a-z0-9]{1,24}$/.test(language)));
  const languages = options.languages === undefined
    ? (detected.size > 0 ? [...detected].sort() : ['text'])
    : normalizeList(options.languages, [], 'languages');
  const frameworks = normalizeList(options.frameworks, [], 'frameworks');
  const analyzedAt = options.analyzedAt === undefined
    ? new Date().toISOString()
    : requireText(options.analyzedAt, 'analyzedAt', 64);
  if (Number.isNaN(Date.parse(analyzedAt))) fail('analyzedAt is not a valid date');
  const gitCommitHash = options.gitCommitHash === undefined
    ? 'unknown'
    : requireText(options.gitCommitHash, 'git commit hash', 128);
  return {
    version: UNDERSTAND_GRAPH_VERSION,
    sourceTrust: UNDERSTAND_SOURCE_TRUST,
    project: {
      name: requireText(options.name ?? 'Vibecodium workspace', 'project name', 256),
      languages,
      frameworks,
      description: requireText(options.description ?? ('Cross-project graph of ' + projects.join(', ') + '.'), 'description', 2_048),
      analyzedAt,
      gitCommitHash,
    },
    nodes: records.map((record) => record.node),
    edges,
    layers: buildLayers(records, projects),
    tour: buildTour(records),
  };
}

export function validateUnderstandGraph(graph) {
  const issues = [];
  const warnings = [];
  if (!isPlainObject(graph)) return { issues: ['graph is not an object'], warnings, stats: null };
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  if (!Array.isArray(graph.nodes)) issues.push('graph.nodes is missing or not an array');
  if (!Array.isArray(graph.edges)) issues.push('graph.edges is missing or not an array');
  const nodeIds = new Set();
  const seen = new Set();
  nodes.forEach((node, index) => {
    if (!isPlainObject(node)) {
      issues.push('Node[' + index + '] is not an object');
      return;
    }
    if (!node.id) issues.push('Node[' + index + '] missing id');
    if (!node.type) issues.push('Node[' + index + '] "' + safeLabel(node.id) + '" missing type');
    else if (!NODE_TYPES.has(node.type)) issues.push('Node[' + index + '] "' + safeLabel(node.id) + '" has an unknown type');
    if (!node.name) issues.push('Node[' + index + '] "' + safeLabel(node.id) + '" missing name');
    if (!node.summary) issues.push('Node[' + index + '] "' + safeLabel(node.id) + '" missing summary');
    if (!Array.isArray(node.tags) || node.tags.length === 0) issues.push('Node[' + index + '] "' + safeLabel(node.id) + '" missing tags');
    if (node.id && seen.has(node.id)) issues.push('Duplicate node ID "' + safeLabel(node.id) + '"');
    if (node.id) {
      seen.add(node.id);
      nodeIds.add(node.id);
    }
  });
  edges.forEach((edge, index) => {
    if (!isPlainObject(edge)) {
      issues.push('Edge[' + index + '] is not an object');
      return;
    }
    if (!EDGE_TYPES.has(edge.type)) issues.push('Edge[' + index + '] has an unknown type');
    if (!nodeIds.has(edge.source)) issues.push('Edge[' + index + '] source "' + safeLabel(edge.source) + '" not found');
    if (!nodeIds.has(edge.target)) issues.push('Edge[' + index + '] target "' + safeLabel(edge.target) + '" not found');
    if (typeof edge.weight !== 'number' || edge.weight < 0 || edge.weight > 1) {
      issues.push('Edge[' + index + '] weight is invalid');
    }
  });
  if (!Array.isArray(graph.layers)) warnings.push('graph.layers is not an array');
  if (!Array.isArray(graph.tour)) warnings.push('graph.tour is not an array');
  const assigned = new Set();
  (Array.isArray(graph.layers) ? graph.layers : []).forEach((layer) => {
    if (!isPlainObject(layer)) {
      issues.push('Layer is not an object');
      return;
    }
    if (!layer.id || !layer.name || !layer.description || !Array.isArray(layer.nodeIds)) {
      issues.push('Layer "' + safeLabel(layer.id) + '" is missing a required field');
    }
    for (const id of Array.isArray(layer.nodeIds) ? layer.nodeIds : []) {
      if (!nodeIds.has(id)) issues.push('Layer "' + safeLabel(layer.id) + '" references missing node "' + safeLabel(id) + '"');
      if (assigned.has(id)) issues.push('Node "' + safeLabel(id) + '" appears in multiple layers');
      assigned.add(id);
    }
  });
  nodes.forEach((node) => {
    if (isPlainObject(node) && FILE_LEVEL_TYPES.has(node.type) && !assigned.has(node.id)) {
      issues.push('File node "' + safeLabel(node.id) + '" not in any layer');
    }
  });
  (Array.isArray(graph.tour) ? graph.tour : []).forEach((step, index) => {
    if (!isPlainObject(step)) {
      issues.push('Tour step[' + index + '] is not an object');
      return;
    }
    if (!Number.isInteger(step.order) || !step.title || !step.description || !Array.isArray(step.nodeIds)) {
      issues.push('Tour step[' + index + '] is missing a required field');
    }
    for (const id of Array.isArray(step.nodeIds) ? step.nodeIds : []) {
      if (!nodeIds.has(id)) issues.push('Tour step[' + index + '] references missing node "' + safeLabel(id) + '"');
    }
  });
  const withEdges = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  nodes.forEach((node) => {
    if (isPlainObject(node) && node.id && !withEdges.has(node.id)) warnings.push('Node "' + safeLabel(node.id) + '" has no edges (orphan)');
  });
  const nodeTypes = {};
  const edgeTypes = {};
  for (const node of nodes) if (isPlainObject(node) && node.type) nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
  for (const edge of edges) if (isPlainObject(edge) && edge.type) edgeTypes[edge.type] = (edgeTypes[edge.type] || 0) + 1;
  return {
    issues,
    warnings,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      totalLayers: Array.isArray(graph.layers) ? graph.layers.length : 0,
      tourSteps: Array.isArray(graph.tour) ? graph.tour.length : 0,
      nodeTypes,
      edgeTypes,
    },
  };
}
