// Cross-project graph edge layer over the standalone project registry.
//
// The graph is rebuilt from the current indexes plus a bounded read of source,
// manifests, Dockerfiles and compose files. It stores only identifiers, paths,
// route patterns, environment variable names, ports, table names, tool names and
// image names. Source values, environment values and request URLs are never kept.
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { INDEX_VERSION, maskNonCode } from './index-engine.mjs';

export const CROSS_PROJECT_GRAPH_VERSION = 1;
export const MAX_PROJECTS = 32;
export const MAX_FILES_PER_PROJECT = 10_000;
export const MAX_SOURCE_FILES = 10_000;
export const MAX_SOURCE_BYTES = 1_000_000;
export const MAX_TOTAL_SOURCE_BYTES = 64_000_000;
export const MAX_NODES = 20_000;
export const MAX_EDGES = 40_000;
export const MAX_HTTP_CALLS = 5_000;
export const MAX_ROUTE_PATH = 2_048;
export const MAX_NAME_LENGTH = 512;
export const MAX_NODE_ID_LENGTH = 8_192;
export const MAX_ROUTE_SEGMENTS = 64;
export const MAX_TRIE_NODES = 200_000;
const MAX_ROUTE_RANGES = 4_096;
const MAX_HTTP_CANDIDATES_PER_FILE = 20_000;

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,254}$/;

const UNSAFE_FILE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:\\]/u;
const UNSAFE_ROUTE = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>\\]/u;
const INDEXED_SOURCE = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i;
const OPTIONAL_FILES = ['package.json', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const CALLABLE_KINDS = new Set(['function', 'method', 'constructor', 'getter', 'setter']);
const TABLE_STOP_WORDS = new Set(['select', 'where', 'set', 'values', 'if', 'only', 'lateral']);
const MAX_HTTP_CALLS_PER_FILE = 1_000;
const SOURCE_TRUST = 'untrusted-repository-content';
const IDENTIFIER_NAME = /^#?[A-Za-z_$][\w$]*$/;
const INDEX_SYMBOL_KINDS = new Set(['class', 'constructor', 'enum', 'function', 'getter', 'interface', 'method', 'namespace', 'setter', 'type', 'variable']);
const MAX_SYMBOLS_PER_FILE = 2_000;
const SERVER_RECEIVER = /^(?:app|router|route|server|routes|api|express|fastify|hono|koa|e)$/i;
const CLIENT_RECEIVER = /^(?:client|http|axios|request|ky|got|superagent|agent)$/i;

export class CrossProjectGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrossProjectGraphError';
  }
}

function fail(message) {
  throw new CrossProjectGraphError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return value;
}

function validateProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID.test(id)) fail('project id is not valid');
  return id;
}
function isIdentifierCharacter(code, allowDash = false, allowDot = false) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) || code === 95 || code === 36 ||
    (allowDash && code === 45) || (allowDot && code === 46);
}

function isEnvName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 128) return false;
  const first = name.charCodeAt(0);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) return false;
  for (let index = 1; index < name.length; index += 1) {
    if (!isIdentifierCharacter(name.charCodeAt(index))) return false;
  }
  return true;
}

function isTableName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 128) return false;
  const first = name.charCodeAt(0);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) return false;
  for (let index = 1; index < name.length; index += 1) {
    if (!isIdentifierCharacter(name.charCodeAt(index))) return false;
  }
  return true;
}

function isToolName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 128) return false;
  for (let index = 0; index < name.length; index += 1) {
    if (!isIdentifierCharacter(name.charCodeAt(index), true, true)) return false;
  }
  return true;
}

function isImageName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 255) return false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (!isIdentifierCharacter(code, true) && code !== 47 && code !== 58 && code !== 64) return false;
  }
  return true;
}

function validateFileKey(file) {
  if (typeof file !== 'string' || file.length === 0 || file.length > 4_096) fail('file path is not valid');
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.startsWith('//') || UNSAFE_FILE.test(file)) {
    fail('file path is not a safe project-relative path');
  }
  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('file path is not a safe project-relative path');
  }
  return file;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isServerReceiver(receiver) {
  return SERVER_RECEIVER.test(receiver) || /(?:Router|Server|App)$/.test(receiver);
}

function isClientReceiver(receiver) {
  return CLIENT_RECEIVER.test(receiver) || /Client$/i.test(receiver);
}

function isValidIndexedSymbol(symbol) {
  return isPlainObject(symbol) &&
    typeof symbol.name === 'string' && symbol.name.length >= 1 && symbol.name.length <= MAX_NAME_LENGTH &&
    IDENTIFIER_NAME.test(symbol.name) && INDEX_SYMBOL_KINDS.has(symbol.kind) &&
    Number.isInteger(symbol.line) && symbol.line >= 1 && symbol.line <= 10_000_000 &&
    Number.isInteger(symbol.column) && symbol.column >= 1 && symbol.column <= 10_000_000 &&
    (symbol.container === undefined || (
      typeof symbol.container === 'string' && symbol.container.length >= 1 &&
      symbol.container.length <= MAX_NAME_LENGTH && IDENTIFIER_NAME.test(symbol.container)
    ));
}

function idFor(type, ...parts) {
  return `${type}:${parts.map((part) => encodeURIComponent(String(part))).join(':')}`;
}

function edgeId(type, from, to, suffix = '') {
  return `${type}:${from}->${to}${suffix ? `:${suffix}` : ''}`;
}

function normalizeRoutePath(value, label = 'route path') {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ROUTE_PATH) {
    fail(`${label} must be a non-empty string of at most ${MAX_ROUTE_PATH} characters`);
  }
  let withoutQuery = value.split(/[?#]/, 1)[0];
  if (withoutQuery.includes('${')) {
    withoutQuery = withoutQuery.replace(/\$\{[^}]{1,256}\}/g, ':param');
    if (withoutQuery.includes('${') || withoutQuery.length > MAX_ROUTE_PATH) {
      fail(`${label} contains an unsupported template expression`);
    }
  }
  if (!withoutQuery.startsWith('/')) fail(`${label} must start with /`);
  if (UNSAFE_ROUTE.test(withoutQuery)) fail(`${label} contains unsupported characters`);
  if (withoutQuery === '/') return '/';
  const segments = withoutQuery.split('/').slice(1);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`${label} contains an unsafe path segment`);
  }
  return withoutQuery;
}

function normalizeCallerPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ROUTE_PATH) {
    fail('caller URL must be a non-empty string');
  }
  let candidate = value.trim();
  candidate = candidate.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+/i, '');
  candidate = candidate.replace(/^\$\{[A-Za-z_$][\w$]*\}(?=\/)/, '');
  candidate = candidate.split(/[?#]/, 1)[0];
  const templated = /\$\{[^}]{1,256}\}/.test(candidate);
  candidate = candidate.replace(/\$\{[^}]{1,256}\}/g, ':param');
  if (candidate === '') candidate = '/';
  return { path: normalizeRoutePath(candidate, 'caller URL'), confidence: templated ? 'template' : 'static' };
}

function routeSegments(value) {
  return value === '/' ? [] : value.split('/').slice(1);
}

function routeNode() {
  return { children: new Map(), param: null, routes: [] };
}

function addRouteToIndex(root, route, budget) {
  const segments = routeSegments(route.path);
  let node = root;
  for (const segment of segments) {
    if (segment.startsWith(':')) {
      if (!node.param) {
        if (budget.nodes >= MAX_TRIE_NODES) return false;
        node.param = routeNode();
        budget.nodes += 1;
      }
      node = node.param;
    } else {
      if (!node.children.has(segment)) {
        if (budget.nodes >= MAX_TRIE_NODES) return false;
        node.children.set(segment, routeNode());
        budget.nodes += 1;
      }
      node = node.children.get(segment);
    }
  }
  node.routes.push(route);
  return true;
}

function matchRoutes(root, callerPath) {
  const segments = routeSegments(callerPath);
  const matched = [];
  const walk = (node, index) => {
    if (index === segments.length) {
      matched.push(...node.routes);
      return;
    }
    const segment = segments[index];
    if (segment.length === 0) return;
    const exact = node.children.get(segment);
    if (exact) walk(exact, index + 1);
    if (node.param) walk(node.param, index + 1);
  };
  walk(root, 0);
  return matched;
}

function lineStartsOf(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function positionAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return { line: lineIndex + 1, column: offset - starts[lineIndex] + 1 };
}

function isCodeAt(masked, index) {
  const character = masked[index];
  return character !== undefined && !/\s/.test(character);
}

function pushRange(ranges, start, end) {
  const last = ranges[ranges.length - 1];
  if (last && start <= last[1]) {
    if (end > last[1]) last[1] = end;
    return true;
  }
  if (ranges.length >= MAX_ROUTE_RANGES) return false;
  ranges.push([start, end]);
  return true;
}

function isInRanges(index, ranges) {
  let low = 0;
  let high = ranges.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ranges[middle][0] <= index) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found >= 0 && index < ranges[found][1];
}

function maskComments(source) {
  const out = source.split('');
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      out[index] = ' ';
      out[index + 1] = ' ';
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' ';
        index += 1;
      }
      if (index < source.length) {
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 2;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return out.join('');
}

function packageNameOf(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function resolveLocalModule(file, specifier, fileSet) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) return null;
  const candidates = [
    target,
    `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.jsx`, `${target}.mjs`, `${target}.cjs`,
    `${target}/index.ts`, `${target}/index.tsx`, `${target}/index.js`,
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) ?? target;
}

async function readContainedFile(project, file, maxBytes) {
  const absolute = path.join(project.root, file);
  const before = await lstat(absolute).catch(() => null);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.size > maxBytes) return null;
  const real = await realpath(absolute).catch(() => null);
  if (!real || !isContained(project.root, real)) return null;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return null;
    const after = await lstat(absolute).catch(() => null);
    if (!after || !after.isFile() || after.isSymbolicLink() || after.size > maxBytes ||
        after.dev !== opened.dev || after.ino !== opened.ino) return null;
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateRegistry(registry) {
  if (!registry || typeof registry.list !== 'function' || typeof registry.index !== 'function') {
    fail('registry must expose list() and index()');
  }
  let listed;
  try {
    listed = registry.list();
  } catch {
    fail('registry could not list projects');
  }
  if (!Array.isArray(listed)) fail('registry list must be an array');
  if (listed.length === 0) fail('graph requires at least one project');
  if (listed.length > MAX_PROJECTS) fail(`graph supports at most ${MAX_PROJECTS} projects`);
  const seen = new Set();
  return listed.map((project) => {
    if (!isPlainObject(project)) fail('registry project entry is invalid');
    const id = validateProjectId(project.id);
    if (typeof project.root !== 'string' || project.root.length === 0 || project.root.length > 4_096) {
      fail('registry project root is invalid');
    }
    const key = id.toLowerCase();
    if (seen.has(key)) fail('project id is duplicated');
    seen.add(key);
    return { id, root: project.root };
  });
}

async function loadProject(descriptor) {
  const root = await realpath(path.resolve(descriptor.root)).catch(() => null);
  if (!root) fail(`project root does not exist: ${descriptor.id}`);
  const info = await stat(root).catch(() => null);
  if (!info || !info.isDirectory()) fail(`project root must be a directory: ${descriptor.id}`);
  return { id: descriptor.id, root };
}

function addGraphNode(nodes, byId, node) {
  const existing = byId.get(node.id);
  if (existing) {
    if (existing.type !== node.type) fail('graph node id collision');
    return existing;
  }
  if (nodes.length >= MAX_NODES) fail(`graph exceeds ${MAX_NODES} nodes`);
  const stored = Object.freeze({ ...node, sourceTrust: SOURCE_TRUST });
  nodes.push(stored);
  byId.set(stored.id, stored);
  return stored;
}

function addGraphEdge(edges, edgeKeys, edge) {
  if (edges.length >= MAX_EDGES) fail(`graph exceeds ${MAX_EDGES} edges`);
  if (edgeKeys.has(edge.id)) return;
  edgeKeys.add(edge.id);
  edges.push(Object.freeze({ ...edge, sourceTrust: SOURCE_TRUST, at: Object.freeze({ ...edge.at }) }));
}

function addModuleNode(context, project, file) {
  const node = addGraphNode(context.nodes, context.byId, {
    id: idFor('module', project, file),
    type: 'module',
    project,
    file,
  });
  addGraphEdge(context.edges, context.edgeKeys, {
    id: edgeId('project-module', context.projectNodeId, node.id),
    type: 'project-module',
    from: context.projectNodeId,
    to: node.id,
    project,
    at: { file, line: 1, column: 1 },
  });
  return node.id;
}

function addPackageNode(context, project, name) {
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) return null;
  return addGraphNode(context.nodes, context.byId, {
    id: idFor('package', project, name),
    type: 'package',
    project,
    name,
  }).id;
}

function addPortNode(context, project, port, file, line, sourceNodeId) {
  validateInteger('port', port, 1, 65_535);
  const node = addGraphNode(context.nodes, context.byId, {
    id: idFor('port', project, port),
    type: 'port',
    project,
    port,
  });
  addGraphEdge(context.edges, context.edgeKeys, {
    id: edgeId('exposes-port', sourceNodeId, node.id, String(port)),
    type: 'exposes-port',
    from: sourceNodeId,
    to: node.id,
    project,
    port,
    at: { file, line, column: 1 },
  });
  return node.id;
}

function addContainerNode(context, project, image, file, line) {
  if (typeof image !== 'string' || !IMAGE_NAME.test(image) || image === 'scratch') return null;
  const node = addGraphNode(context.nodes, context.byId, {
    id: idFor('container', project, image),
    type: 'container',
    project,
    image,
  });
  addGraphEdge(context.edges, context.edgeKeys, {
    id: edgeId('container-image', context.projectNodeId, node.id),
    type: 'container-image',
    from: context.projectNodeId,
    to: node.id,
    project,
    image,
    at: { file, line, column: 1 },
  });
  return node.id;
}

function extractManifest(context, project, file, source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return;
  }
  if (!isPlainObject(parsed)) return;
  const groups = [
    ['runtime', parsed.dependencies],
    ['development', parsed.devDependencies],
    ['optional', parsed.optionalDependencies],
    ['peer', parsed.peerDependencies],
  ];
  for (const [scope, dependencies] of groups) {
    if (!isPlainObject(dependencies)) continue;
    for (const name of Object.keys(dependencies).sort()) {
      const packageId = addPackageNode(context, project, name);
      if (!packageId) continue;
      addGraphEdge(context.edges, context.edgeKeys, {
        id: edgeId('package-dependency', context.projectNodeId, packageId, scope),
        type: 'package-dependency',
        from: context.projectNodeId,
        to: packageId,
        project,
        name,
        scope,
        at: { file, line: 1, column: 1 },
      });
    }
  }
}

function extractDockerfile(context, project, file, source) {
  const lines = source.split(/\r?\n/);
  let containerId = null;
  for (let index = 0; index < lines.length; index += 1) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?([A-Za-z0-9._/:@-]{1,255})/i.exec(lines[index]);
    if (from) containerId = addContainerNode(context, project, from[1], file, index + 1);
    const expose = /^\s*EXPOSE\s+(.+)$/i.exec(lines[index]);
    if (!expose) continue;
    for (const token of expose[1].trim().split(/\s+/)) {
      const match = /^(\d{1,5})(?:\/(?:tcp|udp))?$/i.exec(token);
      if (!match) continue;
      const sourceNode = containerId ?? addModuleNode(context, project, file);
      addPortNode(context, project, Number(match[1]), file, index + 1, sourceNode);
    }
  }
}

function extractCompose(context, project, file, source) {
  const lines = source.split(/\r?\n/);
  let inPorts = false;
  let containerId = null;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const image = /^image:\s*['"]?([A-Za-z0-9._/:@-]{1,255})['"]?\s*$/.exec(trimmed);
    if (image) {
      containerId = addContainerNode(context, project, image[1], file, index + 1);
      continue;
    }
    if (/^ports:\s*$/.test(trimmed)) {
      inPorts = true;
      continue;
    }
    if (!inPorts) continue;
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!trimmed.startsWith('-')) {
      inPorts = false;
      continue;
    }
    const port = /^-\s*['"]?(\d{1,5})(?::(\d{1,5}))?/.exec(trimmed);
    if (!port) continue;
    const sourceNode = containerId ?? addModuleNode(context, project, file);
    addPortNode(context, project, Number(port[1]), file, index + 1, sourceNode);
    if (port[2]) addPortNode(context, project, Number(port[2]), file, index + 1, sourceNode);
  }
}

function extractRoutes(context, project, file, source, masked, lineStarts, moduleId) {
  const routes = [];
  const ranges = [];
  let rangesTruncated = false;
  const seen = new Set();
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`\r\n]{1,2048})\3/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (!isCodeAt(masked, match.index)) continue;
    const receiver = match[1];
    if (isClientReceiver(receiver) && !isServerReceiver(receiver)) continue;
    if (!pushRange(ranges, match.index, match.index + match[0].length)) rangesTruncated = true;
    const method = match[2].toUpperCase();
    if (!HTTP_METHODS.has(method)) continue;
    let routePath;
    try {
      routePath = normalizeRoutePath(match[4], 'route path');
    } catch {
      continue;
    }
    if (routeSegments(routePath).length > MAX_ROUTE_SEGMENTS) continue;
    const at = positionAt(lineStarts, match.index);
    const node = addGraphNode(context.nodes, context.byId, {
      id: idFor('route', project, method, routePath),
      type: 'route',
      project,
      method,
      path: routePath,
      file,
      line: at.line,
      column: at.column,
    });
    addGraphEdge(context.edges, context.edgeKeys, {
      id: edgeId('route-definition', moduleId, node.id),
      type: 'route-definition',
      from: moduleId,
      to: node.id,
      project,
      method,
      at: { file, ...at },
    });
    if (!seen.has(node.id)) {
      seen.add(node.id);
      routes.push({ id: node.id, project, method, path: routePath, file, line: at.line });
    }
  }
  return { routes, ranges, rangesTruncated };
}

function extractImports(context, project, file, source, masked, lineStarts, fileSet, moduleId) {
  const patterns = [
    /\bimport\s+(?:[^'"\r\n;]{1,1024}?\s+from\s+)?(['"])([^'"\r\n]{1,1024})\1/g,
    /\bexport\s+[^'"\r\n;]{1,1024}?\s+from\s+(['"])([^'"\r\n]{1,1024})\1/g,
    /\bimport\s*\(\s*(['"])([^'"\r\n]{1,1024})\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"\r\n]{1,1024})\1\s*\)/g,
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (!isCodeAt(masked, match.index)) continue;
      let specifier = match[2].split(/[?#]/, 1)[0];
      if (!specifier || specifier.length > 1_024 || UNSAFE_ROUTE.test(specifier) ||
          specifier.startsWith('/') || specifier.startsWith('\\') || specifier.includes('\\') ||
          specifier.includes(':')) continue;
      const key = `${match.index}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const at = positionAt(lineStarts, match.index);
      if (specifier.startsWith('.')) {
        const target = resolveLocalModule(file, specifier, fileSet);
        if (!target) continue;
        specifier = target;
        const targetId = addModuleNode(context, project, target);
        addGraphEdge(context.edges, context.edgeKeys, {
          id: edgeId('import', moduleId, targetId, specifier),
          type: 'import',
          from: moduleId,
          to: targetId,
          project,
          specifier,
          at: { file, ...at },
        });
        continue;
      }
      const name = packageNameOf(specifier);
      if (!PACKAGE_NAME.test(name)) continue;
      specifier = name;
      const packageId = addPackageNode(context, project, name);
      if (!packageId) continue;
      addGraphEdge(context.edges, context.edgeKeys, {
        id: edgeId('import', moduleId, packageId, specifier),
        type: 'import',
        from: moduleId,
        to: packageId,
        project,
        specifier,
        at: { file, ...at },
      });
    }
  }
}

function extractEnv(context, project, file, source, masked, lineStarts, moduleId) {
  const patterns = [
    /\b(?:process\.env|import\.meta\.env)\.([A-Za-z_][A-Za-z0-9_]{0,127})/g,
    /\b(?:process\.env|import\.meta\.env)\[\s*(['"])([A-Za-z_][A-Za-z0-9_]{0,127})\1\s*\]/g,
  ];
  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
    const pattern = patterns[patternIndex];
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (!isCodeAt(masked, match.index)) continue;
      const name = patternIndex === 0 ? match[1] : match[2];
      if (!isEnvName(name)) continue;
      const at = positionAt(lineStarts, match.index);
      const node = addGraphNode(context.nodes, context.byId, {
        id: idFor('env', project, name),
        type: 'env',
        project,
        name,
      });
      addGraphEdge(context.edges, context.edgeKeys, {
        id: edgeId('env-use', moduleId, node.id),
        type: 'env-use',
        from: moduleId,
        to: node.id,
        project,
        name,
        at: { file, ...at },
      });
    }
  }
}

function extractPorts(context, project, file, source, masked, lineStarts, moduleId) {
  const patterns = [
    /\blisten\s*\(\s*(?:Number\s*\(\s*)?(\d{1,5})\b/g,
    /\blisten\s*\([^)]{0,200}?(?:\?\?|=|:)\s*(\d{1,5})\b/g,
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (!isCodeAt(masked, match.index)) continue;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535 || seen.has(port)) continue;
      seen.add(port);
      const at = positionAt(lineStarts, match.index);
      addPortNode(context, project, port, file, at.line, moduleId);
    }
  }
}

function extractSqlTables(context, project, file, source, lineStarts, moduleId) {
  const withoutComments = maskComments(source);
  const pattern = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/gi;
  let match;
  while ((match = pattern.exec(withoutComments)) !== null) {
    const table = match[1].split('.').pop();
    if (!isTableName(table) || TABLE_STOP_WORDS.has(table.toLowerCase())) continue;
    const at = positionAt(lineStarts, match.index);
    const node = addGraphNode(context.nodes, context.byId, {
      id: idFor('database-table', project, table),
      type: 'database-table',
      project,
      name: table,
    });
    addGraphEdge(context.edges, context.edgeKeys, {
      id: edgeId('database-table-use', moduleId, node.id),
      type: 'database-table-use',
      from: moduleId,
      to: node.id,
      project,
      name: table,
      at: { file, ...at },
    });
  }
}

function extractMcpTools(context, project, file, source, masked, lineStarts, moduleId) {
  const pattern = /\b[A-Za-z_$][\w$]*\s*\.\s*tool\s*\(\s*(['"])([A-Za-z0-9_.-]{1,128})\1/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (!isCodeAt(masked, match.index)) continue;
    const name = match[2];
    if (!isToolName(name)) continue;
    const at = positionAt(lineStarts, match.index);
    const node = addGraphNode(context.nodes, context.byId, {
      id: idFor('mcp-tool', project, name),
      type: 'mcp-tool',
      project,
      name,
    });
    addGraphEdge(context.edges, context.edgeKeys, {
      id: edgeId('mcp-tool', moduleId, node.id),
      type: 'mcp-tool',
      from: moduleId,
      to: node.id,
      project,
      name,
      at: { file, ...at },
    });
  }
}

function callerNodeId(context, project, file, entry, line, moduleId) {
  let chosen = null;
  for (const symbol of Array.isArray(entry.symbols) ? entry.symbols : []) {
    if (!isPlainObject(symbol) || !CALLABLE_KINDS.has(symbol.kind)) continue;
    if (!Number.isInteger(symbol.line) || symbol.line > line) continue;
    if (!chosen || symbol.line > chosen.line || (symbol.line === chosen.line && symbol.column > chosen.column)) {
      chosen = symbol;
    }
  }
  if (!chosen) return moduleId;
  return addGraphNode(context.nodes, context.byId, {
    id: idFor('symbol', project, file, chosen.line, chosen.column, chosen.name),
    type: 'symbol',
    project,
    name: chosen.name,
    kind: chosen.kind,
    file,
    line: chosen.line,
    column: chosen.column,
    ...(chosen.container ? { container: chosen.container } : {}),
  }).id;
}

function fetchMethod(source, after) {
  let index = after;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== ',') return 'GET';
  let depth = 0;
  let end = source.length;
  for (let i = index; i < source.length && i < index + 4_096; i += 1) {
    const character = source[i];
    if (character === '(') depth += 1;
    else if (character === ')') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth -= 1;
    }
  }
  const match = /\bmethod\s*:\s*(['"])([A-Za-z]+)\1/.exec(source.slice(index, end));
  const method = match?.[2]?.toUpperCase();
  return method && HTTP_METHODS.has(method) ? method : 'GET';
}

function extractHttpCalls(context, project, file, source, masked, lineStarts, entry, moduleId, routeRanges,
    rangesTruncated) {
  if (rangesTruncated) return [];
  const calls = [];
  const seen = new Set();
  const fetchPattern = /\bfetch\s*\(\s*(['"`])([^'"`\r\n]{1,2048})\1/g;
  let match;
  let candidates = 0;
  while (calls.length < MAX_HTTP_CALLS_PER_FILE && candidates < MAX_HTTP_CANDIDATES_PER_FILE &&
      (match = fetchPattern.exec(source)) !== null) {
    candidates += 1;
    if (!isCodeAt(masked, match.index) || isInRanges(match.index, routeRanges)) continue;
    let normalized;
    try {
      normalized = normalizeCallerPath(match[2]);
    } catch {
      continue;
    }
    const at = positionAt(lineStarts, match.index);
    const method = fetchMethod(source, match.index + match[0].length);
    const key = `${method}:${normalized.path}:${at.line}:${at.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({
      project,
      file,
      line: at.line,
      column: at.column,
      method,
      path: normalized.path,
      confidence: normalized.confidence,
      callerId: callerNodeId(context, project, file, entry, at.line, moduleId),
    });
  }

  const clientPattern = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`\r\n]{1,2048})\3/gi;
  candidates = 0;
  while (calls.length < MAX_HTTP_CALLS_PER_FILE && candidates < MAX_HTTP_CANDIDATES_PER_FILE &&
      (match = clientPattern.exec(source)) !== null) {
    candidates += 1;
    if (!isCodeAt(masked, match.index)) continue;
    const receiver = match[1];
    if (isServerReceiver(receiver) && !isClientReceiver(receiver)) continue;
    if (isInRanges(match.index, routeRanges)) continue;
    let normalized;
    try {
      normalized = normalizeCallerPath(match[4]);
    } catch {
      continue;
    }
    const method = match[2].toUpperCase();
    const at = positionAt(lineStarts, match.index);
    const key = `${method}:${normalized.path}:${at.line}:${at.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({
      project,
      file,
      line: at.line,
      column: at.column,
      method,
      path: normalized.path,
      confidence: normalized.confidence,
      callerId: callerNodeId(context, project, file, entry, at.line, moduleId),
    });
  }
  return calls;
}

function extractSourceFacts(context, project, file, source, entry, fileSet) {
  const masked = maskNonCode(source);
  const lineStarts = lineStartsOf(source);
  const moduleId = addModuleNode(context, project, file);
  const routeResult = extractRoutes(context, project, file, source, masked, lineStarts, moduleId);
  extractImports(context, project, file, source, masked, lineStarts, fileSet, moduleId);
  extractEnv(context, project, file, source, masked, lineStarts, moduleId);
  extractPorts(context, project, file, source, masked, lineStarts, moduleId);
  extractSqlTables(context, project, file, source, lineStarts, moduleId);
  extractMcpTools(context, project, file, source, masked, lineStarts, moduleId);
  const httpCalls = extractHttpCalls(
    context, project, file, source, masked, lineStarts, entry, moduleId, routeResult.ranges,
    routeResult.rangesTruncated,
  );
  return { routes: routeResult.routes, httpCalls };
}

function validateIndexSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || snapshot.version !== INDEX_VERSION || !isPlainObject(snapshot.files)) {
    fail('project index is invalid');
  }
  const files = Object.entries(snapshot.files);
  if (files.length > MAX_FILES_PER_PROJECT) fail(`project index exceeds ${MAX_FILES_PER_PROJECT} files`);
  for (const [file, entry] of files) {
    validateFileKey(file);
    if (!isPlainObject(entry) || !Array.isArray(entry.symbols) ||
        entry.symbols.length > MAX_SYMBOLS_PER_FILE) {
      fail('project index file entry is invalid');
    }
    for (const symbol of entry.symbols) {
      if (!isValidIndexedSymbol(symbol)) fail(`project index symbol is invalid: ${file}`);
    }
  }
  return files;
}

export async function buildCrossProjectGraph(registry, options = {}) {
  if (!isPlainObject(options)) fail('options must be an object');
  const descriptors = validateRegistry(registry);
  const projects = [];
  const nodes = [];
  const edges = [];
  const byId = new Map();
  const edgeKeys = new Set();
  const routes = [];
  const httpCalls = [];
  let fileCount = 0;
  let byteCount = 0;
  let skipped = 0;

  for (const descriptor of descriptors) {
    const project = await loadProject(descriptor);
    const projectNodeId = addGraphNode(nodes, byId, {
      id: idFor('project', project.id),
      type: 'project',
      project: project.id,
    }).id;
    projects.push(Object.freeze({ id: project.id }));

    let snapshot;
    try {
      snapshot = registry.index(project.id);
    } catch {
      fail(`project index could not be loaded: ${project.id}`);
    }
    const entries = validateIndexSnapshot(snapshot);
    const fileSet = new Set(entries.map(([file]) => file));
    const sourceFiles = entries.map(([file]) => file).filter((file) => INDEXED_SOURCE.test(file));
    if (fileCount + sourceFiles.length > MAX_SOURCE_FILES) fail(`graph exceeds ${MAX_SOURCE_FILES} source files`);
    const readFiles = [...sourceFiles];
    for (const optional of OPTIONAL_FILES) {
      if (!readFiles.includes(optional)) readFiles.push(optional);
    }
    const context = { nodes, byId, edges, edgeKeys, projectNodeId };

    for (const file of readFiles) {
      const source = await readContainedFile(project, file, MAX_SOURCE_BYTES);
      if (source === null) {
        skipped += 1;
        continue;
      }
      byteCount += Buffer.byteLength(source, 'utf8');
      if (byteCount > MAX_TOTAL_SOURCE_BYTES) fail(`graph exceeds ${MAX_TOTAL_SOURCE_BYTES} source bytes`);
      fileCount += 1;
      const basename = path.basename(file).toLowerCase();
      if (basename === 'package.json') {
        extractManifest(context, project.id, file, source);
        continue;
      }
      if (basename === 'dockerfile' || basename.endsWith('.dockerfile')) {
        extractDockerfile(context, project.id, file, source);
        continue;
      }
      if (/^(?:docker-)?compose\.ya?ml$/.test(basename)) {
        extractCompose(context, project.id, file, source);
        continue;
      }
      if (!INDEXED_SOURCE.test(file)) continue;
      const entry = snapshot.files[file];
      const result = extractSourceFacts(context, project.id, file, source, entry, fileSet);
      routes.push(...result.routes);
      for (const call of result.httpCalls) {
        if (httpCalls.length >= MAX_HTTP_CALLS) break;
        httpCalls.push(call);
      }
    }
  }

  const routeIndex = new Map();
  const trieBudget = { nodes: 0 };
  let routeNodesIndexed = 0;
  for (const route of routes) {
    let root = routeIndex.get(route.method);
    if (!root) {
      if (trieBudget.nodes >= MAX_TRIE_NODES) break;
      root = routeNode();
      trieBudget.nodes += 1;
      routeIndex.set(route.method, root);
    }
    if (addRouteToIndex(root, route, trieBudget)) routeNodesIndexed += 1;
  }
  for (const call of httpCalls) {
    const root = routeIndex.get(call.method);
    if (!root) continue;
    for (const route of matchRoutes(root, call.path)) {
      addGraphEdge(edges, edgeKeys, {
        id: edgeId('http-route-caller', call.callerId, route.id, call.method),
        type: 'http-route-caller',
        from: call.callerId,
        to: route.id,
        project: call.project,
        method: call.method,
        confidence: call.confidence,
        at: { file: call.file, line: call.line, column: call.column },
      });
    }
  }

  const stats = Object.freeze({
    projects: projects.length,
    files: fileCount,
    bytes: byteCount,
    routes: routes.length,
    routesIndexed: routeNodesIndexed,
    httpCallers: httpCalls.length,
    nodes: nodes.length,
    edges: edges.length,
    skipped,
  });
  return new CrossProjectGraph({ projects, nodes, edges, stats });
}

function publicRoute(node) {
  return {
    id: node.id,
    type: 'route',
    project: node.project,
    method: node.method,
    path: node.path,
    file: node.file,
    line: node.line,
    sourceTrust: SOURCE_TRUST,
  };
}

const GRAPH_NODE_TYPES = new Set([
  'project', 'module', 'symbol', 'route', 'package', 'env', 'port', 'database-table', 'mcp-tool', 'container',
]);
const GRAPH_EDGE_TYPES = new Set([
  'project-module', 'route-definition', 'import', 'package-dependency', 'env-use', 'exposes-port',
  'database-table-use', 'mcp-tool', 'container-image', 'http-route-caller',
]);
const GRAPH_NODE_FIELDS = new Set([
  'id', 'type', 'project', 'file', 'name', 'kind', 'line', 'column', 'container', 'method', 'path', 'port',
  'image', 'sourceTrust',
]);
const GRAPH_EDGE_FIELDS = new Set([
  'id', 'type', 'from', 'to', 'project', 'method', 'confidence', 'at', 'sourceTrust', 'specifier', 'name',
  'scope', 'port', 'image',
]);
const GRAPH_POSITION_FIELDS = new Set(['file', 'line', 'column']);
const GRAPH_STATS_FIELDS = new Set([
  'projects', 'files', 'bytes', 'routes', 'routesIndexed', 'httpCallers', 'nodes', 'edges', 'skipped',
]);
const GRAPH_SCOPES = new Set(['runtime', 'development', 'optional', 'peer']);

const GRAPH_TOP_FIELDS = new Set(['version', 'sourceTrust', 'projects', 'nodes', 'edges', 'stats']);
const SAFE_ID = /^[A-Za-z0-9%:._~!*'()>/@-]+$/;

function checkSnapshotFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(label + ' has an unexpected field');
  }
}

function validateSnapshotPosition(at, label) {
  if (!isPlainObject(at)) fail(label + ' position is invalid');
  checkSnapshotFields(at, GRAPH_POSITION_FIELDS, label + ' position');
  validateFileKey(at.file);
  validateInteger('line', at.line, 1, 10_000_000);
  validateInteger('column', at.column, 1, 10_000_000);
}

function validateSnapshotName(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_NAME_LENGTH ||
      UNSAFE_ROUTE.test(value)) {
    fail(label + ' is invalid');
  }
}

function validateSnapshotNode(node, projectIds) {
  if (!isPlainObject(node)) fail('graph node is invalid');
  checkSnapshotFields(node, GRAPH_NODE_FIELDS, 'graph node');
  if (typeof node.id !== 'string' || node.id.length < 1 || node.id.length > MAX_NODE_ID_LENGTH ||
      !SAFE_ID.test(node.id)) {
    fail('graph node id is invalid');
  }
  if (!GRAPH_NODE_TYPES.has(node.type)) fail('graph node type is invalid');
  if (!projectIds.has(node.project)) fail('graph node project is invalid');
  if (node.file !== undefined) validateFileKey(node.file);
  if (node.line !== undefined) validateInteger('line', node.line, 1, 10_000_000);
  if (node.column !== undefined) validateInteger('column', node.column, 1, 10_000_000);
  switch (node.type) {
    case 'project':
      break;
    case 'module':
      if (node.file === undefined) fail('graph module has no file');
      break;
    case 'symbol':
      if (!IDENTIFIER_NAME.test(node.name) || !CALLABLE_KINDS.has(node.kind) ||
          node.file === undefined || node.line === undefined || node.column === undefined) {
        fail('graph symbol is invalid');
      }
      if (node.container !== undefined && !IDENTIFIER_NAME.test(node.container)) {
        fail('graph symbol container is invalid');
      }
      break;
    case 'route': {
      if (!HTTP_METHODS.has(node.method)) fail('graph route method is invalid');
      const normalized = normalizeRoutePath(node.path, 'route path');
      if (normalized !== node.path || node.file === undefined || node.line === undefined ||
          node.column === undefined) {
        fail('graph route is invalid');
      }
      break;
    }
    case 'package':
      if (!PACKAGE_NAME.test(node.name)) fail('graph package is invalid');
      break;
    case 'env':
      if (!isEnvName(node.name)) fail('graph env is invalid');
      break;
    case 'port':
      validateInteger('port', node.port, 1, 65_535);
      break;
    case 'database-table':
      if (!isTableName(node.name)) fail('graph table is invalid');
      break;
    case 'mcp-tool':
      if (!isToolName(node.name)) fail('graph tool is invalid');
      break;
    case 'container':
      if (!isImageName(node.image)) fail('graph container is invalid');
      break;
    default:
      fail('graph node type is invalid');
  }
  return node;
}

function validateSnapshotEdge(edge, nodeIds, projectIds) {
  if (!isPlainObject(edge)) fail('graph edge is invalid');
  checkSnapshotFields(edge, GRAPH_EDGE_FIELDS, 'graph edge');
  if (typeof edge.id !== 'string' || edge.id.length < 1 || edge.id.length > MAX_NODE_ID_LENGTH ||
      !SAFE_ID.test(edge.id)) {
    fail('graph edge id is invalid');
  }
  if (!GRAPH_EDGE_TYPES.has(edge.type)) fail('graph edge type is invalid');
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) fail('graph edge references a missing node');
  if (!projectIds.has(edge.project)) fail('graph edge project is invalid');
  validateSnapshotPosition(edge.at, 'graph edge');
  if (edge.method !== undefined && !HTTP_METHODS.has(edge.method)) fail('graph edge method is invalid');
  if (edge.confidence !== undefined && edge.confidence !== 'static' && edge.confidence !== 'template') {
    fail('graph edge confidence is invalid');
  }
  if (edge.port !== undefined) validateInteger('port', edge.port, 1, 65_535);
  if (edge.scope !== undefined && !GRAPH_SCOPES.has(edge.scope)) fail('graph edge scope is invalid');
  if (edge.image !== undefined && !isImageName(edge.image)) fail('graph edge image is invalid');
  if (edge.name !== undefined) validateSnapshotName(edge.name, 'graph edge name');
  if (edge.specifier !== undefined) {
    if (typeof edge.specifier !== 'string' || edge.specifier.length < 1) fail('graph edge specifier is invalid');
    if (!PACKAGE_NAME.test(edge.specifier)) validateFileKey(edge.specifier);
  }
}

export class CrossProjectGraph {
  #byId;

  constructor(snapshot) {
    if (!isPlainObject(snapshot) || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.nodes) ||
        !Array.isArray(snapshot.edges) || !isPlainObject(snapshot.stats)) {
      fail('graph snapshot is invalid');
    }
    checkSnapshotFields(snapshot, GRAPH_TOP_FIELDS, 'graph snapshot');
    if (snapshot.version !== undefined && snapshot.version !== CROSS_PROJECT_GRAPH_VERSION) {
      fail('graph snapshot version is invalid');
    }
    if (snapshot.sourceTrust !== undefined && snapshot.sourceTrust !== SOURCE_TRUST) {
      fail('graph snapshot trust marker is invalid');
    }
    if (snapshot.projects.length === 0 || snapshot.projects.length > MAX_PROJECTS) {
      fail('graph snapshot project count is invalid');
    }
    if (snapshot.nodes.length > MAX_NODES || snapshot.edges.length > MAX_EDGES) {
      fail('graph snapshot exceeds the node or edge cap');
    }
    checkSnapshotFields(snapshot.stats, GRAPH_STATS_FIELDS, 'graph stats');
    for (const key of GRAPH_STATS_FIELDS) validateInteger(key, snapshot.stats[key], 0, 10_000_000_000);
    const seenProjects = new Set();
    const projects = snapshot.projects.map((project) => {
      if (!isPlainObject(project)) fail('graph project is invalid');
      checkSnapshotFields(project, new Set(['id']), 'graph project');
      const id = validateProjectId(project.id);
      if (seenProjects.has(id.toLowerCase())) fail('graph project is duplicated');
      seenProjects.add(id.toLowerCase());
      return Object.freeze({ id });
    });
    const projectIds = new Set(projects.map((project) => project.id));
    const nodes = snapshot.nodes.map((node) => {
      validateSnapshotNode(node, projectIds);
      return Object.freeze({ ...node, sourceTrust: SOURCE_TRUST });
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    if (nodeIds.size !== nodes.length) fail('graph node id is duplicated');
    const edgeIds = new Set();
    const edges = snapshot.edges.map((edge) => {
      validateSnapshotEdge(edge, nodeIds, projectIds);
      if (edgeIds.has(edge.id)) fail('graph edge id is duplicated');
      edgeIds.add(edge.id);
      return Object.freeze({ ...edge, sourceTrust: SOURCE_TRUST, at: Object.freeze({ ...edge.at }) });
    });
    this.version = CROSS_PROJECT_GRAPH_VERSION;
    this.projects = Object.freeze(projects);
    this.nodes = Object.freeze(nodes);
    this.edges = Object.freeze(edges);
    this.stats = Object.freeze({ ...snapshot.stats });
    this.#byId = new Map(nodes.map((node) => [node.id, node]));
  }

  static async build(registry, options = {}) {
    return buildCrossProjectGraph(registry, options);
  }

  node(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_NODE_ID_LENGTH) fail('node id is invalid');
    const node = this.#byId.get(id);
    if (!node) fail('node is not in the graph');
    return node;
  }

  routeCallers(value, options = {}) {
    if (!isPlainObject(options)) fail('options must be an object');
    const routePath = normalizeRoutePath(value, 'route path');
    const method = String(options.method ?? 'GET').toUpperCase();
    if (!HTTP_METHODS.has(method)) fail('method must be a supported HTTP method');
    const matchedRoutes = this.nodes
      .filter((node) => node.type === 'route' && node.method === method && node.path === routePath)
      .sort((left, right) => left.project.localeCompare(right.project) || left.file.localeCompare(right.file));
    if (matchedRoutes.length === 0) {
      return { kind: 'route-callers', found: false, route: null, callers: [], counts: { total: 0, returned: 0 } };
    }
    const routeIds = new Set(matchedRoutes.map((route) => route.id));
    const seen = new Set();
    const callers = [];
    for (const edge of this.edges) {
      if (edge.type !== 'http-route-caller' || !routeIds.has(edge.to) || seen.has(edge.from)) continue;
      const node = this.#byId.get(edge.from);
      if (!node) continue;
      seen.add(edge.from);
      callers.push({
        id: node.id,
        project: node.project,
        symbol: node.name,
        kind: node.kind,
        file: node.file,
        line: node.line,
        column: node.column,
        method: edge.method,
        confidence: edge.confidence,
        sourceTrust: SOURCE_TRUST,
        at: { ...edge.at },
      });
    }
    return {
      kind: 'route-callers',
      found: true,
      route: publicRoute(matchedRoutes[0]),
      callers,
      counts: { total: callers.length, returned: callers.length },
    };
  }

  toJSON() {
    return {
      version: this.version,
      sourceTrust: SOURCE_TRUST,
      projects: this.projects,
      nodes: this.nodes,
      edges: this.edges,
      stats: this.stats,
    };
  }
}
