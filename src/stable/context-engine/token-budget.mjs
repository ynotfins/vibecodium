import { createHash } from 'node:crypto';

export const SECTION_OVERHEAD_TOKENS = 4;
export const MAX_MODEL_WINDOW = 10_000_000;
export const MAX_SECTION_CHARS = 50_000_000;
export const MAX_SUMMARY_CHARS = 8_000;
export const MAX_SUMMARY_ID_CHARS = 200;
export const MAX_SUMMARY_BLOCKS = 10_000;
export const MAX_SUMMARY_LEVELS = 64;
export const MAX_TAIL_RECORDS = 100_000;
export const MAX_TAIL_RECORD_CHARS = 1_000_000;
export const MAX_RECORD_DEPTH = 32;
export const MAX_RECORD_NODES = 10_000;
export const MAX_RECORD_KEYS = 1_000;
export const MAX_RECORD_ITEMS = 1_000;
export const MAX_RECORD_KEY_CHARS = 200;
export const MAX_TAIL_TOTAL_CHARS = 20_000_000;
export const MAX_SUMMARY_TOTAL_CHARS = 20_000_000;
export const DEFAULT_TOKENIZER_MIN_BYTES_PER_TOKEN = 16;
export const MAX_TOKENIZER_BYTES_PER_TOKEN = 4_096;
export const UNTRUSTED_OPEN = '<<<UNTRUSTED_SESSION_CONTENT>>>';
export const UNTRUSTED_CLOSE = '<<<END_UNTRUSTED_SESSION_CONTENT>>>';

export const SECTION_NAMES = Object.freeze([
  'system',
  'rules',
  'spec',
  'repoMap',
  'summaries',
  'tail',
]);

const SECTION_TRUST = Object.freeze({
  system: 'trusted',
  rules: 'trusted',
  spec: 'trusted',
  repoMap: 'untrusted-repository-content',
  summaries: 'untrusted-session-content',
  tail: 'untrusted-session-content',
});

const RECORD_KINDS = new Set([
  'user',
  'assistant',
  'system',
  'tool_call',
  'tool_result',
]);

const SUMMARY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class ContextBudgetError extends Error {
  constructor(message, { availableTokens = null, requiredTokens = null } = {}) {
    super(message);
    this.name = 'ContextBudgetError';
    this.availableTokens = availableTokens;
    this.requiredTokens = requiredTokens;
  }
}

function utf8Length(text) {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function assertWellFormed(text, name) {
  if (typeof text.isWellFormed === 'function' && !text.isWellFormed()) {
    throw new Error(`${name} must be well-formed Unicode`);
  }
}

export function estimateTokens(text) {
  if (typeof text !== 'string') {
    throw new Error('text must be a string');
  }
  if (text.length === 0) return 0;
  return utf8Length(text) + 1;
}

function assertJsonValue(payload) {
  const state = { seen: new WeakSet(), chars: 0, nodes: 0 };
  const addChars = (count) => {
    state.chars += count;
    if (state.chars > MAX_TAIL_RECORD_CHARS) {
      throw new Error(`tail record payload exceeds ${MAX_TAIL_RECORD_CHARS} characters`);
    }
  };
  const visit = (value, depth, topLevel) => {
    if (depth > MAX_RECORD_DEPTH) {
      throw new Error(`tail record payload nesting exceeds ${MAX_RECORD_DEPTH}`);
    }
    state.nodes += 1;
    if (state.nodes > MAX_RECORD_NODES) {
      throw new Error(`tail record payload exceeds ${MAX_RECORD_NODES} values`);
    }
    if (typeof value === 'string') {
      if (value.length === 0) throw new Error('tail record payload strings must be non-empty');
      addChars(value.length);
      assertWellFormed(value, 'tail record payload');
      return;
    }
    if (typeof value === 'boolean' || value === null) return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new Error('tail record payload numbers must be finite');
      }
      return;
    }
    if (typeof value !== 'object') {
      throw new Error('tail record payload must be JSON-safe');
    }
    if (topLevel && Array.isArray(value)) {
      throw new Error('tail record payload must be a string, boolean, number, null or plain object');
    }
    if (state.seen.has(value)) {
      throw new Error('tail record payload must not contain repeated object references or cycles');
    }
    state.seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_RECORD_ITEMS) {
        throw new Error(`tail record payload arrays may contain at most ${MAX_RECORD_ITEMS} items`);
      }
      for (const item of value) visit(item, depth + 1, false);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('tail record payload must be JSON-safe');
    }
    if (Object.hasOwn(value, 'toJSON')) {
      throw new Error('tail record payload must be JSON-safe');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('tail record payload must be JSON-safe');
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_RECORD_KEYS) {
      throw new Error(`tail record payload objects may contain at most ${MAX_RECORD_KEYS} keys`);
    }
    for (const key of keys) {
      if (key.length > MAX_RECORD_KEY_CHARS) {
        throw new Error(`tail record payload keys may contain at most ${MAX_RECORD_KEY_CHARS} characters`);
      }
      addChars(key.length);
      visit(value[key], depth + 1, false);
    }
  };
  visit(payload, 1, true);
}

function renderPayload(payload) {
  assertJsonValue(payload);
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

function escapeUntrustedMarkers(content) {
  return content
    .replaceAll(UNTRUSTED_OPEN, '{UNTRUSTED_SESSION_CONTENT}')
    .replaceAll(UNTRUSTED_CLOSE, '{END_UNTRUSTED_SESSION_CONTENT}');
}

function wrapUntrusted(content) {
  return `${UNTRUSTED_OPEN}\n${escapeUntrustedMarkers(content)}\n${UNTRUSTED_CLOSE}`;
}

function renderTailRecord(record) {
  const text = wrapUntrusted(`[${record.kind} #${record.sequence}] ${renderPayload(record.payload)}`);
  if (text.length > MAX_TAIL_RECORD_CHARS) {
    throw new Error(`tail record ${record.sequence} exceeds ${MAX_TAIL_RECORD_CHARS} characters`);
  }
  return text;
}

function renderSummaryBlock(block) {
  return wrapUntrusted(`[summary ${block.id} records ${block.startSequence}-${block.endSequence}] ${block.summary}`);
}

function validateModelWindow(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MODEL_WINDOW) {
    throw new Error(`modelWindow must be an integer between 1 and ${MAX_MODEL_WINDOW}`);
  }
}

function validateReserve(value, modelWindow) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('reserveTokens must be a non-negative integer');
  }
  if (value >= modelWindow) {
    throw new Error('reserveTokens must be smaller than modelWindow');
  }
}

function validateOptionalText(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > MAX_SECTION_CHARS) {
    throw new Error(`${name} exceeds ${MAX_SECTION_CHARS} characters`);
  }
  if (value.trim().length === 0) return '';
  assertWellFormed(value, name);
  return value;
}

function validateSystem(value) {
  if (typeof value !== 'string') throw new Error('system must be a string');
  if (value.trim().length === 0) throw new Error('system must be a non-empty string');
  if (value.length > MAX_SECTION_CHARS) {
    throw new Error(`system exceeds ${MAX_SECTION_CHARS} characters`);
  }
  assertWellFormed(value, 'system');
  return value;
}

function normalizeSummaries(value) {
  if (!Array.isArray(value)) throw new Error('summaries must be an array');
  if (value.length > MAX_SUMMARY_BLOCKS) {
    throw new Error(`summaries exceeds ${MAX_SUMMARY_BLOCKS} blocks`);
  }
  const blocks = value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('summary blocks must be objects');
    }
    if (!Number.isInteger(raw.startSequence) || raw.startSequence < 0) {
      throw new Error('summary startSequence must be a non-negative integer');
    }
    if (!Number.isInteger(raw.endSequence) || raw.endSequence < raw.startSequence) {
      throw new Error('summary endSequence must be an integer at or after startSequence');
    }
    if (raw.level !== undefined && (!Number.isInteger(raw.level) || raw.level < 0 || raw.level > MAX_SUMMARY_LEVELS)) {
      throw new Error(`summary level must be an integer between 0 and ${MAX_SUMMARY_LEVELS}`);
    }
    if (typeof raw.summary !== 'string' || raw.summary.trim().length === 0) {
      throw new Error('summary must be a non-empty string');
    }
    if (raw.summary.length > MAX_SUMMARY_CHARS) {
      throw new Error(`summary exceeds ${MAX_SUMMARY_CHARS} characters`);
    }
    assertWellFormed(raw.summary, 'summary');
    const id = raw.id ?? `summary:${raw.startSequence}-${raw.endSequence}`;
    if (typeof id !== 'string' || !SUMMARY_ID.test(id) || id.length > MAX_SUMMARY_ID_CHARS) {
      throw new Error('summary id must match the bounded summary-id format');
    }
    return {
      id,
      level: raw.level ?? 0,
      startSequence: raw.startSequence,
      endSequence: raw.endSequence,
      summary: raw.summary,
    };
  });

  blocks.sort((left, right) => (
    left.startSequence - right.startSequence ||
    left.endSequence - right.endSequence ||
    left.level - right.level ||
    left.id.localeCompare(right.id)
  ));

  const seen = new Set();
  let totalChars = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (seen.has(block.id)) throw new Error(`duplicate summary id: ${block.id}`);
    seen.add(block.id);
    if (index > 0 && block.startSequence <= blocks[index - 1].endSequence) {
      throw new Error('summary blocks must not overlap');
    }
    totalChars += block.summary.length;
    if (totalChars > MAX_SUMMARY_TOTAL_CHARS) {
      throw new Error(`summaries exceeds ${MAX_SUMMARY_TOTAL_CHARS} characters`);
    }
  }
  return blocks;
}

function normalizeTail(value) {
  if (!Array.isArray(value)) throw new Error('tail must be an array');
  if (value.length > MAX_TAIL_RECORDS) {
    throw new Error(`tail exceeds ${MAX_TAIL_RECORDS} records`);
  }
  let previous = null;
  let totalChars = 0;
  return value.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('tail records must be objects');
    }
    if (typeof record.kind !== 'string' || record.kind.length > 32) {
      throw new Error('tail record kind must be a string of at most 32 characters');
    }
    if (!RECORD_KINDS.has(record.kind)) {
      throw new Error('invalid record kind');
    }
    if (!Number.isInteger(record.sequence) || record.sequence < 0) {
      throw new Error('invalid record sequence');
    }
    if (previous !== null && record.sequence !== previous + 1) {
      throw new Error('tail sequences must be contiguous');
    }
    if (!Object.hasOwn(record, 'payload')) {
      throw new Error(`tail record ${record.sequence} is missing its payload`);
    }
    previous = record.sequence;
    const text = renderTailRecord(record);
    totalChars += text.length;
    if (totalChars > MAX_TAIL_TOTAL_CHARS) {
      throw new Error(`tail exceeds ${MAX_TAIL_TOTAL_CHARS} characters`);
    }
    return {
      kind: record.kind,
      payload: record.payload,
      sequence: record.sequence,
      text,
    };
  });
}

function validatePreviousPrefixHashes(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length !== SECTION_NAMES.length) {
    throw new Error(`previousPrefixHashes must contain ${SECTION_NAMES.length} entries`);
  }
  for (const hash of value) {
    if (hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error('previousPrefixHashes entries must be sha256 hex strings or null');
    }
  }
  return [...value];
}

function resolveCountTokens(tokenizer, minBytesPerToken) {
  if (tokenizer === undefined || tokenizer === null) return estimateTokens;
  if (typeof tokenizer !== 'function') throw new Error('tokenizer must be a function');
  if (!Number.isInteger(minBytesPerToken) || minBytesPerToken < 1 || minBytesPerToken > MAX_TOKENIZER_BYTES_PER_TOKEN) {
    throw new Error(
      `tokenizerMinBytesPerToken must be an integer between 1 and ${MAX_TOKENIZER_BYTES_PER_TOKEN}`,
    );
  }
  return (text) => {
    const value = tokenizer(text);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('tokenizer must return a non-negative integer');
    }
    if (text.length === 0) {
      if (value !== 0) throw new Error('tokenizer must return 0 for empty text');
      return value;
    }
    if (value === 0) {
      throw new Error('tokenizer under-counted: 0 tokens for non-empty text');
    }
    const floor = Math.ceil(utf8Length(text) / minBytesPerToken);
    if (value < floor) {
      throw new Error(
        `tokenizer under-counted: ${value} tokens for ${utf8Length(text)} UTF-8 bytes at a ${minBytesPerToken}-byte minimum per token`,
      );
    }
    return value;
  };
}

function makeCost(countTokens) {
  return (text) => countTokens(text) + SECTION_OVERHEAD_TOKENS;
}

function joinSections(parts) {
  return parts.filter((content) => content !== null && content !== '').join('\n\n');
}

function hashContent(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sectionRecord(name, fit) {
  return {
    name,
    included: fit.included,
    tokens: fit.included ? fit.tokens : 0,
    chars: fit.included ? fit.content.length : 0,
    sourceTrust: SECTION_TRUST[name],
  };
}

export function assembleContext(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('assembleContext options must be an object');
  }
  const {
    modelWindow,
    reserveTokens = 0,
    tokenizer,
    tokenizerMinBytesPerToken = DEFAULT_TOKENIZER_MIN_BYTES_PER_TOKEN,
    system,
    rules,
    spec,
    repoMap,
    summaries = [],
    tail = [],
    previousPrefixHashes,
  } = options;

  validateModelWindow(modelWindow);
  validateReserve(reserveTokens, modelWindow);
  const countTokens = resolveCountTokens(tokenizer, tokenizerMinBytesPerToken);
  const systemText = validateSystem(system);
  const rulesText = validateOptionalText(rules, 'rules');
  const specText = validateOptionalText(spec, 'spec');
  const repoMapText = validateOptionalText(repoMap, 'repoMap');
  const summaryBlocks = normalizeSummaries(summaries);
  const tailRecords = normalizeTail(tail);
  if (tailRecords.length > 0) {
    const firstTailSequence = tailRecords[0].sequence;
    if (summaryBlocks.some((block) => block.endSequence >= firstTailSequence)) {
      throw new Error('summary blocks must end before the fresh tail');
    }
  }
  const previousHashes = validatePreviousPrefixHashes(previousPrefixHashes);

  const availableTokens = modelWindow - reserveTokens;
  const cost = makeCost(countTokens);

  const systemTokens = countTokens(systemText);
  if (systemTokens > availableTokens) {
    throw new ContextBudgetError(
      `system requires ${systemTokens} tokens but only ${availableTokens} are available`,
      { availableTokens, requiredTokens: systemTokens },
    );
  }

  const requiredParts = [systemText];
  let requiredTokens = systemTokens;
  const rulesTokens = rulesText.length === 0 ? 0 : countTokens(rulesText);
  if (rulesText.length > 0) {
    requiredParts.push(rulesText);
    requiredTokens = countTokens(joinSections(requiredParts));
    if (requiredTokens > availableTokens) {
      throw new ContextBudgetError(
        `rules require ${requiredTokens} tokens but only ${availableTokens} are available`,
        { availableTokens, requiredTokens },
      );
    }
  }

  const specFit = specText.length === 0
    ? { included: false, content: null, tokens: 0 }
    : { included: true, content: specText, tokens: countTokens(specText) };
  if (specFit.included) {
    requiredParts.push(specText);
    requiredTokens = countTokens(joinSections(requiredParts));
    if (requiredTokens > availableTokens) {
      throw new ContextBudgetError(
        `spec requires ${requiredTokens} tokens but only ${availableTokens} are available`,
        { availableTokens, requiredTokens },
      );
    }
  }
  let remaining = availableTokens - requiredTokens;

  const repoMapContent = repoMapText.length === 0 ? '' : wrapUntrusted(repoMapText);
  const repoMapTokens = repoMapContent.length === 0 ? 0 : cost(repoMapContent);
  let repoMapFit = repoMapTokens === 0 || repoMapTokens > remaining
    ? { included: false, content: null, tokens: 0 }
    : { included: true, content: repoMapContent, tokens: repoMapTokens };
  remaining -= repoMapFit.tokens;

  const includedSummaries = [];
  let summaryClosed = false;
  for (const block of summaryBlocks) {
    if (summaryClosed) continue;
    const rendered = renderSummaryBlock(block);
    const tokens = cost(rendered);
    if (tokens > remaining) {
      summaryClosed = true;
      continue;
    }
    remaining -= tokens;
    includedSummaries.push({ block, rendered, tokens });
  }

  const includedTail = [];
  for (let index = tailRecords.length - 1; index >= 0; index -= 1) {
    const record = tailRecords[index];
    const tokens = cost(record.text);
    if (tokens > remaining) break;
    remaining -= tokens;
    includedTail.unshift({ record, tokens });
  }

  const renderSections = (tailStart = 0, summaryCount = includedSummaries.length) => joinSections([
    ...requiredParts,
    repoMapFit.content,
    includedSummaries.slice(0, summaryCount).map(({ rendered }) => rendered).join('\n'),
    includedTail.slice(tailStart).map(({ record }) => record.text).join('\n'),
  ]);
  const measure = (tailStart = 0, summaryCount = includedSummaries.length) => {
    const rendered = renderSections(tailStart, summaryCount);
    return { text: rendered, tokens: countTokens(rendered) };
  };

  let { text, tokens: totalTokens } = measure();
  if (totalTokens > availableTokens) {
    let low = 0;
    let high = includedTail.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (measure(mid, includedSummaries.length).tokens <= availableTokens) high = mid;
      else low = mid + 1;
    }
    includedTail.splice(0, low);
    ({ text, tokens: totalTokens } = measure());
  }
  if (totalTokens > availableTokens) {
    let low = 0;
    let high = includedSummaries.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (measure(0, mid).tokens <= availableTokens) low = mid;
      else high = mid - 1;
    }
    includedSummaries.length = low;
    ({ text, tokens: totalTokens } = measure());
  }
  if (totalTokens > availableTokens && repoMapFit.included) {
    repoMapFit = { included: false, content: null, tokens: 0 };
    ({ text, tokens: totalTokens } = measure());
  }
  if (totalTokens > availableTokens) {
    throw new ContextBudgetError(
      `required context requires ${totalTokens} tokens but only ${availableTokens} are available`,
      { availableTokens, requiredTokens: totalTokens },
    );
  }

  const summaryContent = includedSummaries.map(({ rendered }) => rendered).join('\n');
  const tailContent = includedTail.map(({ record }) => record.text).join('\n');
  const summaryTokens = includedSummaries.reduce((sum, item) => sum + item.tokens, 0);
  const tailTokens = includedTail.reduce((sum, item) => sum + item.tokens, 0);
  const includedSummaryIds = new Set(includedSummaries.map(({ block }) => block.id));
  const droppedSummaryIds = summaryBlocks
    .filter((block) => !includedSummaryIds.has(block.id))
    .map((block) => block.id);
  const includedTailSequences = new Set(includedTail.map(({ record }) => record.sequence));
  const droppedTailSequences = tailRecords
    .filter((record) => !includedTailSequences.has(record.sequence))
    .map((record) => record.sequence);

  const sections = [
    sectionRecord('system', { included: true, content: systemText, tokens: systemTokens }),
    rulesText.length === 0
      ? { name: 'rules', included: false, tokens: 0, chars: 0, sourceTrust: SECTION_TRUST.rules }
      : sectionRecord('rules', { included: true, content: rulesText, tokens: rulesTokens }),
    sectionRecord('spec', specFit),
    sectionRecord('repoMap', repoMapFit),
    {
      name: 'summaries',
      included: includedSummaries.length > 0,
      tokens: summaryTokens,
      chars: summaryContent.length,
      sourceTrust: SECTION_TRUST.summaries,
      ids: includedSummaries.map(({ block }) => block.id),
      droppedIds: droppedSummaryIds,
    },
    {
      name: 'tail',
      included: includedTail.length > 0,
      tokens: tailTokens,
      chars: tailContent.length,
      sourceTrust: SECTION_TRUST.tail,
      sequences: includedTail.map(({ record }) => record.sequence),
      droppedSequences: droppedTailSequences,
    },
  ];

  const prefixHashes = [
    systemText.length > 0 ? hashContent(systemText) : null,
    rulesText.length > 0 ? hashContent(rulesText) : null,
    specFit.included ? hashContent(specFit.content) : null,
    repoMapFit.included ? hashContent(repoMapFit.content) : null,
    includedSummaries.length > 0 ? hashContent(summaryContent) : null,
    includedTail.length > 0 ? hashContent(tailContent) : null,
  ];

  let firstChangedSection;
  if (previousHashes === null) {
    firstChangedSection = 0;
  } else {
    firstChangedSection = prefixHashes.findIndex((hash, index) => hash !== previousHashes[index]);
    if (firstChangedSection === -1) firstChangedSection = null;
  }
  const reusablePrefixSections = firstChangedSection === null ? SECTION_NAMES.length : firstChangedSection;
  const changedSections = firstChangedSection === null ? [] : SECTION_NAMES.slice(firstChangedSection);

  const includedSections = sections.filter((section) => section.included).map((section) => section.name);
  const omittedSections = sections.filter((section) => !section.included).map((section) => section.name);

  return {
    text,
    sections,
    report: {
      modelWindow,
      reserveTokens,
      availableTokens,
      totalTokens,
      fits: totalTokens <= availableTokens,
      estimator: tokenizer === undefined || tokenizer === null ? 'utf8-byte-upper-bound' : 'provided',
      includedSections,
      omittedSections,
      summaries: {
        sourceTrust: SECTION_TRUST.summaries,
        includedIds: includedSummaries.map(({ block }) => block.id),
        droppedIds: droppedSummaryIds,
      },
      tail: {
        sourceTrust: SECTION_TRUST.tail,
        includedSequences: includedTail.map(({ record }) => record.sequence),
        droppedSequences: droppedTailSequences,
      },
      cache: {
        prefixHashes,
        firstChangedSection,
        reusablePrefixSections,
        changedSections,
      },
    },
  };
}

export function summaryBlocksFromDag(dag) {
  if (!dag || typeof dag !== 'object') {
    throw new Error('summary DAG must be an object');
  }
  const root = dag.root;
  if (!root) return [];
  return [{
    id: root.id,
    level: root.level,
    startSequence: root.startSequence,
    endSequence: root.endSequence,
    summary: root.summary,
  }];
}
