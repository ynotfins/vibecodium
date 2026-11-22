export const DEFAULT_LEAF_SIZE = 8;
export const DEFAULT_FANOUT = 4;
export const DEFAULT_TAIL_COUNT = 10;
export const DEFAULT_EXPAND_LIMIT = 20;
export const MAX_EXPAND_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1_000;
export const MAX_SUMMARY_CHARS = 8_000;
export const MAX_QUERY_CHARS = 500;

const RECORD_KINDS = new Set([
  'user',
  'assistant',
  'system',
  'tool_call',
  'tool_result',
]);

function validateOptions({ leafSize, fanout, tailCount, maxLevels }) {
  if (!Number.isInteger(leafSize) || leafSize < 1) {
    throw new Error('leafSize must be a positive integer');
  }
  if (!Number.isInteger(fanout) || fanout < 2) {
    throw new Error('fanout must be at least 2');
  }
  if (!Number.isInteger(tailCount) || tailCount < 0) {
    throw new Error('tailCount must be a non-negative integer');
  }
  if (!Number.isInteger(maxLevels) || maxLevels < 1) {
    throw new Error('maxLevels must be a positive integer');
  }
}

function validateRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error('records must be an array');
  }
  let previous = null;
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      throw new Error('record must be an object');
    }
    if (!RECORD_KINDS.has(record.kind)) {
      throw new Error(`invalid record kind: ${record.kind}`);
    }
    if (!Number.isInteger(record.sequence) || record.sequence < 0) {
      throw new Error('invalid record sequence');
    }
    if (previous !== null && record.sequence !== previous + 1) {
      throw new Error('record sequences must be contiguous');
    }
    if (!Object.hasOwn(record, 'payload')) {
      throw new Error('record payload is missing');
    }
    previous = record.sequence;
  }
}

function payloadText(payload) {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    throw new Error('record payload cannot be rendered for recall');
  }
}

function snippetAround(text, index, length) {
  const radius = 100;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + Math.max(length, 0) + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

async function createSummary(summarize, context) {
  const summary = await summarize(context);
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('summary must be a non-empty string');
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new Error(`summary exceeds ${MAX_SUMMARY_CHARS} characters`);
  }
  return summary;
}

function nodeId(level, startSequence, endSequence) {
  return `summary:l${level}:${startSequence}-${endSequence}`;
}

function publicNode(node) {
  return {
    id: node.id,
    kind: node.kind,
    level: node.level,
    startSequence: node.startSequence,
    endSequence: node.endSequence,
    recordCount: node.recordCount,
    summary: node.summary,
    childIds: [...node.childIds],
    sourceTrust: 'untrusted-session-content',
  };
}

class SummaryDag {
  constructor({ records, nodes, rootId, tail }) {
    this.records = records;
    this.tail = tail;
    this.rootId = rootId;
    this.nodes = new Map(nodes.map((node) => [node.id, node]));
    this.leafBySequence = new Map();
    for (const node of nodes.filter((candidate) => candidate.kind === 'leaf')) {
      for (let sequence = node.startSequence; sequence <= node.endSequence; sequence += 1) {
        this.leafBySequence.set(sequence, node.id);
      }
    }
    this.summarizedRecordCount = rootId ? this.nodes.get(rootId).recordCount : 0;
    const tailCount = tail.length;
    this.stats = {
      leaves: nodes.filter((node) => node.kind === 'leaf').length,
      condensed: nodes.filter((node) => node.kind === 'condensed').length,
      nodes: nodes.length,
      summarizedRecords: this.summarizedRecordCount,
      tailCount,
    };
  }

  get root() {
    return this.rootId ? this.describe(this.rootId) : null;
  }

  list({ level, kind, offset = 0, limit = DEFAULT_LIST_LIMIT } = {}) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('offset must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
    }
    return [...this.nodes.values()]
      .filter((node) => (level === undefined || node.level === level) && (kind === undefined || node.kind === kind))
      .sort((left, right) => left.level - right.level || left.startSequence - right.startSequence)
      .slice(offset, offset + limit)
      .map(publicNode);
  }

  describe(id = this.rootId) {
    if (id === undefined || id === null) return null;
    if (typeof id !== 'string') {
      throw new Error('summary node id must be a string');
    }
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`summary node not found: ${id}`);
    }
    return publicNode(node);
  }

  grep(query, { limit = DEFAULT_EXPAND_LIMIT, includeTail = false } = {}) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('query must be a non-empty string');
    }
    if (query.length > MAX_QUERY_CHARS) {
      throw new Error(`query exceeds ${MAX_QUERY_CHARS} characters`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPAND_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_EXPAND_LIMIT}`);
    }
    if (typeof includeTail !== 'boolean') {
      throw new Error('includeTail must be a boolean');
    }

    const needle = query.toLowerCase();
    const lastSummarizedSequence = this.rootId
      ? this.nodes.get(this.rootId).endSequence
      : -1;
    const pool = includeTail
      ? this.records
      : this.records.filter((record) => record.sequence <= lastSummarizedSequence);
    const matches = [];
    let total = 0;
    for (const record of pool) {
      const text = payloadText(record.payload);
      const index = text.toLowerCase().indexOf(needle);
      if (index === -1) continue;
      total += 1;
      if (matches.length >= limit) continue;
      matches.push({
        sequence: record.sequence,
        kind: record.kind,
        nodeId: this.leafBySequence.get(record.sequence) ?? null,
        snippet: snippetAround(text, index, query.length),
        sourceTrust: 'untrusted-session-content',
      });
    }
    return { query, total, matches };
  }

  expand(target, { offset = 0, limit = DEFAULT_EXPAND_LIMIT } = {}) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('offset must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPAND_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_EXPAND_LIMIT}`);
    }
    let node;
    if (typeof target === 'string') {
      node = this.nodes.get(target);
      if (!node) throw new Error(`summary node not found: ${target}`);
    } else if (target && typeof target === 'object' && Number.isInteger(target.sequence)) {
      const id = this.leafBySequence.get(target.sequence);
      if (!id) throw new Error(`no summary node covers sequence ${target.sequence}`);
      node = this.nodes.get(id);
    } else {
      throw new Error('expand target must be a summary node id or { sequence }');
    }

    const covered = this.records.filter(
      (record) => record.sequence >= node.startSequence && record.sequence <= node.endSequence,
    );
    const records = covered.slice(offset, offset + limit);
    return {
      node: publicNode(node),
      total: covered.length,
      offset,
      limit,
      hasMore: offset + records.length < covered.length,
      records,
      sourceTrust: 'untrusted-session-content',
    };
  }
}

export async function buildSummaryDag(records, options = {}) {
  const {
    summarize,
    leafSize = DEFAULT_LEAF_SIZE,
    fanout = DEFAULT_FANOUT,
    tailCount = DEFAULT_TAIL_COUNT,
    maxLevels = 32,
  } = options;

  validateOptions({ leafSize, fanout, tailCount, maxLevels });
  validateRecords(records);

  const tail = tailCount === 0 ? [] : records.slice(-tailCount);
  const oldRecords = tailCount === 0
    ? records
    : records.slice(0, Math.max(0, records.length - tailCount));
  if (oldRecords.length === 0) {
    return new SummaryDag({ records, nodes: [], rootId: null, tail });
  }
  if (typeof summarize !== 'function') {
    throw new Error('summarize must be a function when there are summarized records');
  }

  const nodes = [];
  let current = [];
  for (let index = 0; index < oldRecords.length; index += leafSize) {
    const chunk = oldRecords.slice(index, index + leafSize);
    const startSequence = chunk[0].sequence;
    const endSequence = chunk.at(-1).sequence;
    const summary = await createSummary(summarize, {
      kind: 'leaf',
      level: 0,
      startSequence,
      endSequence,
      recordCount: chunk.length,
      records: chunk,
      children: [],
    });
    const node = {
      id: nodeId(0, startSequence, endSequence),
      kind: 'leaf',
      level: 0,
      startSequence,
      endSequence,
      recordCount: chunk.length,
      summary,
      childIds: [],
    };
    nodes.push(node);
    current.push(node);
  }

  let level = 0;
  while (current.length > 1) {
    if (level >= maxLevels) {
      throw new Error(`summary DAG exceeds ${maxLevels} levels`);
    }
    level += 1;
    const next = [];
    for (let index = 0; index < current.length; index += fanout) {
      const group = current.slice(index, index + fanout);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const startSequence = group[0].startSequence;
      const endSequence = group.at(-1).endSequence;
      const recordCount = group.reduce((sum, child) => sum + child.recordCount, 0);
      const children = group.map(publicNode);
      const summary = await createSummary(summarize, {
        kind: 'condensed',
        level,
        startSequence,
        endSequence,
        recordCount,
        records: [],
        children,
      });
      const node = {
        id: nodeId(level, startSequence, endSequence),
        kind: 'condensed',
        level,
        startSequence,
        endSequence,
        recordCount,
        summary,
        childIds: children.map((child) => child.id),
      };
      nodes.push(node);
      next.push(node);
    }
    current = next;
  }

  return new SummaryDag({ records, nodes, rootId: current[0].id, tail });
}

export async function buildSummaryDagFromStore(store, options = {}) {
  if (!store || typeof store.readAll !== 'function') {
    throw new Error('store must provide readAll()');
  }
  const records = await store.readAll();
  return buildSummaryDag(records, options);
}
