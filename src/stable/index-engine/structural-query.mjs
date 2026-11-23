// Bounded structural answers over a loaded project index.
//
// The graph is derived from the index only: symbols are nodes, call sites recorded by
// `extractCalls` become edges. Answers never include source text, only file paths,
// symbol names, kinds and positions, so an agent can ask a structural question without
// pulling whole files into its context.
import { Buffer } from 'node:buffer';

export const MAX_ANSWER_NODES = 200;
export const MAX_ANSWER_EDGES = 400;
export const MAX_ANSWER_BYTES = 8_192;
export const MAX_DEPTH = 8;
export const MAX_NAME_LENGTH = 512;
export const MAX_FILE_LENGTH = 4_096;
export const MAX_CANDIDATES = 20;
export const MAX_INDEX_FILES = 10_000;
export const MAX_INDEX_SYMBOLS = 500_000;
export const MAX_INDEX_CALLS = 200_000;

const SYMBOL_KINDS = new Set(['class', 'constructor', 'enum', 'function', 'getter', 'interface', 'method', 'namespace', 'setter', 'type', 'variable']);
const CALLABLE_KINDS = new Set(['function', 'method', 'constructor', 'getter', 'setter']);
const UNSAFE_FILE_CHARS = /[\\:\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
const ANSWER_ARRAYS = ['results', 'candidates'];
const IDENTIFIER_NAME = /^#?[A-Za-z_$][\w$]*$/;

export class StructuralQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StructuralQueryError';
  }
}

function fail(message) {
  throw new StructuralQueryError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateOptions(options) {
  if (options === undefined) return {};
  if (!isPlainObject(options)) fail('options must be an object');
  return options;
}

function compareNodes(a, b) {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.name.localeCompare(b.name);
}

function publicNode(node) {
  return {
    file: node.file,
    name: node.name,
    kind: node.kind,
    line: node.line,
    column: node.column,
    ...(node.container ? { container: node.container } : {}),
  };
}

function validateFileKey(file) {
  if (typeof file !== 'string' || file.length === 0 || file.length > MAX_FILE_LENGTH) {
    fail('index has an invalid file entry');
  }
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || UNSAFE_FILE_CHARS.test(file)) {
    fail('index has an invalid file entry');
  }
  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('index has an invalid file entry');
  }
}

function publicSymbol(ref) {
  if (typeof ref === 'string') return ref;
  if (isPlainObject(ref) && typeof ref.name === 'string') return ref.name;
  return undefined;
}

function nodeKey(file, name, line, column) {
  return `${file}\u0000${line}\u0000${column}\u0000${name}`;
}

export class StructuralQuery {
  constructor(index, options = {}) {
    const snapshot = index && typeof index === 'object' && index.current ? index.current : index;
    if (!snapshot || !isPlainObject(snapshot.files) || !Array.isArray(snapshot.symbols)) {
      fail('a loaded index snapshot is required');
    }
    validateOptions(options);
    this.maxNodes = validateInteger('maxNodes', options.maxNodes ?? MAX_ANSWER_NODES, 1, MAX_ANSWER_NODES);
    this.maxBytes = validateInteger('maxBytes', options.maxBytes ?? MAX_ANSWER_BYTES, 256, MAX_ANSWER_BYTES);
    this.nodes = [];
    this.byName = new Map();
    this.byId = new Map();
    this.edges = new Map();
    this.callerEdges = new Map();
    this.edgeKeys = new Set();
    this.modules = new Map();
    this.stats = {
      files: 0,
      symbols: 0,
      calls: 0,
      edges: 0,
      unresolvedCalls: 0,
      ambiguousCalls: 0,
      modules: 0,
    };
    this.#build(snapshot);
  }

  #build(snapshot) {
    const files = Object.entries(snapshot.files);
    if (files.length > MAX_INDEX_FILES) fail('index has too many files');
    this.stats.files = files.length;
    let symbolTotal = 0;
    for (const [file, entry] of files) {
      validateFileKey(file);
      if (!isPlainObject(entry) || !Array.isArray(entry.symbols)) fail('index has an invalid file entry');
      for (const symbol of entry.symbols) {
        this.#validateSymbol(symbol);
        this.#addNode({
          file,
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          column: symbol.column,
          ...(symbol.container ? { container: symbol.container } : {}),
        });
        symbolTotal += 1;
        if (symbolTotal > MAX_INDEX_SYMBOLS) fail('index has too many symbols');
      }
    }
    let callTotal = 0;
    for (const [file, entry] of files) {
      if (entry.calls !== undefined && !Array.isArray(entry.calls)) fail('index has an invalid file entry');
      const symbols = [...entry.symbols].sort((a, b) => a.line - b.line || a.column - b.column);
      const calls = [...(entry.calls ?? [])].sort((a, b) => a.line - b.line || a.column - b.column);
      const cursor = { index: 0, stack: [] };
      for (const call of calls) {
        this.#validateCall(call);
        callTotal += 1;
        if (callTotal > MAX_INDEX_CALLS) fail('index has too many calls');
        this.stats.calls += 1;
        const caller = this.#callerFor(file, symbols, call, cursor);
        const candidates = this.byName.get(call.name) ?? [];
        if (candidates.length === 0) {
          this.stats.unresolvedCalls += 1;
          continue;
        }
        let chosen = candidates.filter((candidate) => candidate.file === file);
        let resolution = 'file';
        if (chosen.length === 0) {
          chosen = caller.container
            ? candidates.filter((candidate) => candidate.container === caller.container)
            : [];
          resolution = 'container';
        }
        if (chosen.length === 0 && candidates.length === 1) {
          chosen = candidates;
          resolution = 'unique';
        }
        if (chosen.length === 0) {
          chosen = candidates;
          resolution = 'ambiguous';
        }
        if (chosen.length > 1 && resolution === 'ambiguous') this.stats.ambiguousCalls += 1;
        for (const target of chosen.slice(0, 4)) this.#addEdge(caller, target, call, resolution);
      }
    }
  }

  #validateSymbol(symbol) {
    if (!isPlainObject(symbol) || typeof symbol.name !== 'string' || symbol.name.length === 0 ||
        symbol.name.length > MAX_NAME_LENGTH || !IDENTIFIER_NAME.test(symbol.name) ||
        !SYMBOL_KINDS.has(symbol.kind) ||
        !Number.isInteger(symbol.line) || symbol.line < 1 ||
        !Number.isInteger(symbol.column) || symbol.column < 1 ||
        (symbol.container !== undefined && (typeof symbol.container !== 'string' ||
          symbol.container.length > MAX_NAME_LENGTH || !IDENTIFIER_NAME.test(symbol.container)))) {
      fail('index has an invalid symbol');
    }
  }

  #validateCall(call) {
    if (!isPlainObject(call) || typeof call.name !== 'string' || call.name.length === 0 ||
        call.name.length > MAX_NAME_LENGTH || !IDENTIFIER_NAME.test(call.name) ||
        (call.kind !== 'call' && call.kind !== 'new') ||
        !Number.isInteger(call.line) || call.line < 1 ||
        !Number.isInteger(call.column) || call.column < 1 ||
        !Number.isInteger(call.endLine) || call.endLine < call.line ||
        !Number.isInteger(call.depth) || call.depth < 0 ||
        (call.receiver !== undefined && (typeof call.receiver !== 'string' ||
          call.receiver.length > MAX_NAME_LENGTH || !IDENTIFIER_NAME.test(call.receiver)))) {
      fail('index has an invalid call site');
    }
  }

  #addNode(node) {
    const key = nodeKey(node.file, node.name, node.line, node.column);
    if (this.byId.has(key)) return this.byId.get(key);
    const stored = { ...node, id: key };
    this.nodes.push(stored);
    this.byId.set(key, stored);
    const named = this.byName.get(stored.name);
    if (named) named.push(stored);
    else this.byName.set(stored.name, [stored]);
    this.stats.symbols += 1;
    return stored;
  }

  #moduleNode(file) {
    const existing = this.modules.get(file);
    if (existing) return existing;
    const module = { file, name: '<module>', kind: 'module', line: 1, column: 1 };
    const stored = this.#addNode(module);
    this.stats.symbols -= 1;
    this.stats.modules += 1;
    this.modules.set(file, stored);
    return stored;
  }

  #callerFor(file, symbols, call, cursor) {
    // Symbols do not store an end line, so attribution uses call depth plus the nearest
    // preceding callable. The stack is never popped; the backwards scan below stays bounded
    // by the number of symbols in the file.
    if (call.depth === 0) return this.#moduleNode(file);
    while (cursor.index < symbols.length && symbols[cursor.index].line <= call.line) {
      cursor.stack.push(symbols[cursor.index]);
      cursor.index += 1;
    }
    let caller = null;
    for (let i = cursor.stack.length - 1; i >= 0; i -= 1) {
      if (CALLABLE_KINDS.has(cursor.stack[i].kind)) {
        caller = cursor.stack[i];
        break;
      }
    }
    if (!caller && cursor.stack.length > 0) caller = cursor.stack[cursor.stack.length - 1];
    if (!caller) return this.#moduleNode(file);
    return this.byId.get(nodeKey(file, caller.name, caller.line, caller.column)) ?? this.#moduleNode(file);
  }

  #addEdge(from, to, call, resolution) {
    const key = `${from.id}\u0000${to.id}\u0000${call.line}\u0000${call.column}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    const edge = {
      to: to.id,
      line: call.line,
      column: call.column,
      kind: call.kind,
      resolution,
      ...(call.receiver ? { receiver: call.receiver } : {}),
    };
    const outgoing = this.edges.get(from.id);
    if (outgoing) outgoing.push(edge);
    else this.edges.set(from.id, [edge]);
    const incoming = this.callerEdges.get(to.id);
    const reverse = { from: from.id, line: call.line, column: call.column, kind: call.kind, resolution };
    if (incoming) incoming.push(reverse);
    else this.callerEdges.set(to.id, [reverse]);
    this.stats.edges += 1;
  }

  #resolve(ref) {
    let name;
    let file;
    let line;
    if (typeof ref === 'string') {
      name = ref;
    } else if (isPlainObject(ref)) {
      name = ref.name;
      file = ref.file;
      line = ref.line;
    } else {
      fail('symbol reference must be a name or an object');
    }
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      fail(`symbol name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
    }
    if (file !== undefined && (typeof file !== 'string' || file.length === 0 || file.length > MAX_FILE_LENGTH)) {
      fail('symbol file must be a non-empty relative path');
    }
    if (line !== undefined && (!Number.isInteger(line) || line < 1)) fail('symbol line must be a positive integer');
    let candidates = this.byName.get(name) ?? [];
    if (file !== undefined) candidates = candidates.filter((candidate) => candidate.file === file);
    if (line !== undefined) candidates = candidates.filter((candidate) => candidate.line === line);
    return candidates;
  }

  #limit(options, name = 'limit') {
    return validateInteger(name, options[name] ?? this.maxNodes, 1, this.maxNodes);
  }

  #syncCounts(answer) {
    if (!isPlainObject(answer.counts)) return;
    if (Array.isArray(answer.results)) answer.counts.returned = answer.results.length;
    if (Array.isArray(answer.candidates)) answer.counts.returned = answer.candidates.length;
  }

  #answer(payload) {
    const answer = { ...payload, bytes: 0 };
    const measure = () => Buffer.byteLength(JSON.stringify(answer));
    const setBytes = () => {
      answer.bytes = 0;
      let total = measure();
      for (let i = 0; i < 6; i += 1) {
        answer.bytes = total;
        const actual = measure();
        if (actual === total) break;
        total = actual;
      }
      answer.bytes = total;
      return total;
    };
    const trim = () => {
      for (const key of ANSWER_ARRAYS) {
        if (Array.isArray(answer[key]) && answer[key].length > 0) {
          answer[key].pop();
          answer.truncated = true;
          this.#syncCounts(answer);
          return true;
        }
      }
      return false;
    };
    for (;;) {
      if (setBytes() <= this.maxBytes) return answer;
      if (!trim()) fail(`answer cannot be represented within ${this.maxBytes} bytes`);
    }
  }

  #ambiguous(kind, symbol, candidates, limit) {
    const shown = Math.min(candidates.length, limit, MAX_CANDIDATES);
    return this.#answer({
      kind,
      symbol,
      ambiguous: true,
      candidates: candidates.slice(0, shown).map(publicNode),
      counts: { candidates: candidates.length, returned: shown },
      truncated: candidates.length > shown,
    });
  }

  statsSnapshot() {
    return { ...this.stats, nodes: this.nodes.length };
  }

  find(name, options = {}) {
    validateOptions(options);
    const limit = this.#limit(options);
    const candidates = this.#resolve(typeof name === 'string' ? { name, file: options.file } : name);
    return this.#answer({
      kind: 'find',
      results: candidates.slice(0, limit).map(publicNode),
      counts: { total: candidates.length, returned: Math.min(candidates.length, limit) },
      truncated: candidates.length > limit,
    });
  }

  callers(ref, options = {}) {
    validateOptions(options);
    const limit = this.#limit(options);
    const nodes = this.#resolve(ref);
    if (nodes.length === 0) {
      return this.#answer({ kind: 'callers', symbol: publicSymbol(ref), found: false, results: [], counts: { total: 0, returned: 0 } });
    }
    if (nodes.length > 1) return this.#ambiguous('callers', publicSymbol(ref), nodes, limit);
    const node = nodes[0];
    const edges = this.callerEdges.get(node.id) ?? [];
    const seen = new Set();
    const results = [];
    let total = 0;
    for (const edge of edges) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      total += 1;
      if (results.length >= limit) continue;
      const caller = this.byId.get(edge.from);
      results.push({
        ...publicNode(caller),
        at: { line: edge.line, column: edge.column, kind: edge.kind, resolution: edge.resolution },
      });
    }
    results.sort((a, b) => compareNodes(a, b));
    return this.#answer({
      kind: 'callers',
      found: true,
      symbol: publicNode(node),
      results,
      counts: { total, returned: results.length },
      truncated: results.length < total,
    });
  }

  callees(ref, options = {}) {
    validateOptions(options);
    const limit = this.#limit(options);
    const nodes = this.#resolve(ref);
    if (nodes.length === 0) {
      return this.#answer({ kind: 'callees', symbol: publicSymbol(ref), found: false, results: [], counts: { total: 0, returned: 0 } });
    }
    if (nodes.length > 1) return this.#ambiguous('callees', publicSymbol(ref), nodes, limit);
    const node = nodes[0];
    const edges = this.edges.get(node.id) ?? [];
    const results = edges.slice(0, limit).map((edge) => {
      const target = this.byId.get(edge.to);
      return {
        ...publicNode(target),
        at: { line: edge.line, column: edge.column, kind: edge.kind, resolution: edge.resolution },
      };
    });
    results.sort((a, b) => compareNodes(a, b));
    return this.#answer({
      kind: 'callees',
      found: true,
      symbol: publicNode(node),
      results,
      counts: { total: edges.length, returned: results.length },
      truncated: results.length < edges.length,
    });
  }

  impact(ref, options = {}) {
    validateOptions(options);
    const limit = this.#limit(options);
    const depth = validateInteger('depth', options.depth ?? 3, 1, MAX_DEPTH);
    const nodes = this.#resolve(ref);
    if (nodes.length === 0) {
      return this.#answer({ kind: 'impact', symbol: publicSymbol(ref), found: false, results: [], counts: { total: 0, returned: 0 } });
    }
    if (nodes.length > 1) return this.#ambiguous('impact', publicSymbol(ref), nodes, limit);
    const root = nodes[0];
    const visited = new Set([root.id]);
    const queue = [{ id: root.id, depth: 0 }];
    const reachable = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= depth) continue;
      for (const edge of this.callerEdges.get(current.id) ?? []) {
        if (visited.has(edge.from)) continue;
        visited.add(edge.from);
        reachable.push({ id: edge.from, depth: current.depth + 1, parent: current.id });
        queue.push({ id: edge.from, depth: current.depth + 1 });
      }
    }
    reachable.sort((a, b) =>
      a.depth - b.depth || compareNodes(this.byId.get(a.id), this.byId.get(b.id)));
    const results = reachable.slice(0, limit).map((entry) => {
      const node = this.byId.get(entry.id);
      const parent = this.byId.get(entry.parent);
      return {
        ...publicNode(node),
        depth: entry.depth,
        via: { file: parent.file, name: parent.name, line: parent.line },
      };
    });
    return this.#answer({
      kind: 'impact',
      found: true,
      symbol: publicNode(root),
      depth,
      results,
      counts: { total: reachable.length, returned: results.length },
      truncated: reachable.length > results.length,
    });
  }

  path(fromRef, toRef, options = {}) {
    validateOptions(options);
    const limit = this.#limit(options);
    const maxDepth = validateInteger('maxDepth', options.maxDepth ?? 6, 1, MAX_DEPTH);
    const fromNodes = this.#resolve(fromRef);
    const toNodes = this.#resolve(toRef);
    if (fromNodes.length === 0 || toNodes.length === 0) {
      return this.#answer({
        kind: 'path',
        from: publicSymbol(fromRef),
        to: publicSymbol(toRef),
        found: false,
        path: [],
        counts: { from: fromNodes.length, to: toNodes.length },
      });
    }
    if (fromNodes.length > 1) return this.#ambiguous('path', publicSymbol(fromRef), fromNodes, limit);
    if (toNodes.length > 1) return this.#ambiguous('path', publicSymbol(toRef), toNodes, limit);
    const targets = new Set(toNodes.map((node) => node.id));
    const start = fromNodes[0];
    const previous = new Map();
    const visited = new Set([start.id]);
    let frontier = [start.id];
    let end = targets.has(start.id) ? start.id : null;
    let depth = 0;
    while (!end && frontier.length > 0 && depth < maxDepth) {
      const next = [];
      for (const id of frontier) {
        for (const edge of this.edges.get(id) ?? []) {
          if (visited.has(edge.to)) continue;
          visited.add(edge.to);
          previous.set(edge.to, { parent: id, edge });
          if (targets.has(edge.to)) {
            end = edge.to;
            break;
          }
          next.push(edge.to);
        }
        if (end) break;
      }
      if (end) break;
      frontier = next;
      depth += 1;
    }
    if (!end) {
      return this.#answer({
        kind: 'path',
        from: publicNode(start),
        to: publicNode(toNodes[0]),
        found: false,
        path: [],
        counts: { visited: visited.size },
        truncated: frontier.length > 0 && depth >= maxDepth,
      });
    }
    const path = [];
    let cursor = end;
    while (cursor !== start.id) {
      const node = this.byId.get(cursor);
      const link = previous.get(cursor);
      if (!node || !link) break;
      path.push(publicNode(node));
      cursor = link.parent;
    }
    path.push(publicNode(start));
    path.reverse();
    return this.#answer({
      kind: 'path',
      from: publicNode(start),
      to: publicNode(toNodes[0]),
      found: true,
      truncated: false,
      path,
      hops: path.length - 1,
      counts: { visited: visited.size },
    });
  }

  describe(ref, options = {}) {
    validateOptions(options);
    const limit = this.#limit(options);
    const nodes = this.#resolve(ref);
    if (nodes.length === 0) {
      return this.#answer({ kind: 'describe', symbol: publicSymbol(ref), found: false });
    }
    if (nodes.length > 1) return this.#ambiguous('describe', publicSymbol(ref), nodes, limit);
    const node = nodes[0];
    return this.#answer({
      kind: 'describe',
      found: true,
      symbol: publicNode(node),
      callers: (this.callerEdges.get(node.id) ?? []).length,
      callees: (this.edges.get(node.id) ?? []).length,
    });
  }

  // Agent entry point: one bounded, JSON-serializable answer per structural question.
  answer(query) {
    if (!isPlainObject(query) || typeof query.kind !== 'string') fail('query must be an object with a kind');
    switch (query.kind) {
      case 'find': return this.find(query.symbol ?? query.name, query);
      case 'callers': return this.callers(query.symbol ?? query.name, query);
      case 'callees': return this.callees(query.symbol ?? query.name, query);
      case 'impact': return this.impact(query.symbol ?? query.name, query);
      case 'path': return this.path(query.from, query.to, query);
      case 'describe': return this.describe(query.symbol ?? query.name, query);
      default: fail('unsupported query kind');
    }
  }
}
