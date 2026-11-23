// Local, dependency-free embeddings for the standalone code index.
//
// This is deliberately a local lexical embedding, not a neural model: identifier
// subwords are feature-hashed into a signed dense vector. It gives hybrid search a
// vector signal today while keeping the provider interface ready for a model-backed
// implementation later. No source text leaves this module.

export const EMBEDDING_INDEX_VERSION = 1;
export const DEFAULT_EMBEDDING_DIMENSIONS = 256;
export const MAX_EMBEDDING_DIMENSIONS = 4096;
export const MAX_EMBEDDING_VALUE = 1_000_000;
export const MAX_QUERY_LENGTH = 200;
export const MAX_QUERY_TERMS = 16;
export const LOCAL_EMBEDDING_PROVIDER_ID = 'local-hash-v1';
export const MIN_VECTOR_SCORE = 0.35;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_EMBED_TEXT_LENGTH = 2_000_000;
const MAX_EMBED_BATCH = 10_000;
const MAX_FEATURES = 100_000;
const IDENTIFIER = /[A-Za-z][A-Za-z0-9]*/g;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'what', 'where', 'which', 'who',
  'with',
]);

export class EmbeddingIndexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmbeddingIndexError';
  }
}

function fail(message) {
  throw new EmbeddingIndexError(message);
}

function validateDimensions(dimensions) {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_EMBEDDING_DIMENSIONS) {
    fail(`dimensions must be an integer between 1 and ${MAX_EMBEDDING_DIMENSIONS}`);
  }
  return dimensions;
}

function splitIdentifier(value) {
  return value
    .replace(CAMEL_BOUNDARY, '$1 $2')
    .replace(ACRONYM_BOUNDARY, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

function featureTerms(text) {
  if (typeof text !== 'string') fail('embedding text must be a string');
  if (text.length > MAX_EMBED_TEXT_LENGTH) fail('embedding text is too large');
  const features = new Map();
  let count = 0;
  for (const match of text.matchAll(IDENTIFIER)) {
    const full = match[0].toLowerCase();
    if (full.length >= 2 && !STOP_WORDS.has(full)) {
      features.set(full, (features.get(full) ?? 0) + 1);
      count += 1;
    }
    const parts = splitIdentifier(match[0]);
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.length < 2 || STOP_WORDS.has(part)) continue;
        features.set(part, (features.get(part) ?? 0) + 0.6);
        count += 1;
        if (count >= MAX_FEATURES) break;
      }
    }
    if (count >= MAX_FEATURES) break;
  }
  return features;
}

function hash32(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function embedText(text, dimensions) {
  const vector = new Float64Array(dimensions);
  for (const [term, frequency] of featureTerms(text)) {
    const first = hash32(term, 0x811c9dc5);
    const second = hash32(term, 0x9e3779b9);
    const weight = Math.log1p(frequency);
    const sign = (second & 1) === 0 ? 1 : -1;
    vector[first % dimensions] += weight * sign;
    vector[(second >>> 8) % dimensions] += weight * 0.5 * sign;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from(vector);
  return Array.from(vector, (value) => value / norm);
}

export class LocalHashEmbeddingProvider {
  constructor(options = {}) {
    if (arguments.length > 1 || options === null || typeof options !== 'object' || Array.isArray(options)) {
      fail('embedding provider options must be an object');
    }
    const { dimensions = DEFAULT_EMBEDDING_DIMENSIONS } = options;
    this.id = LOCAL_EMBEDDING_PROVIDER_ID;
    this.dimensions = validateDimensions(dimensions);
    this.allowsVectorOnly = false;
    Object.freeze(this);
  }

  async embed(texts) {
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBED_BATCH) {
      fail(`embedding batch must contain between 1 and ${MAX_EMBED_BATCH} texts`);
    }
    return texts.map((text) => embedText(text, this.dimensions));
  }
}

export function validateEmbeddingProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    fail('embeddingProvider must be an object');
  }
  if (typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id)) {
    fail('embeddingProvider.id must be a short lowercase identifier');
  }
  validateDimensions(provider.dimensions);
  if (provider.allowsVectorOnly !== undefined && typeof provider.allowsVectorOnly !== 'boolean') {
    fail('embeddingProvider.allowsVectorOnly must be a boolean');
  }
  if (typeof provider.embed !== 'function') fail('embeddingProvider.embed must be a function');
  return provider;
}

export function validateEmbeddingVector(vector, dimensions, label = 'embedding') {
  if (!vector || typeof vector !== 'object' || typeof vector.length !== 'number' || vector.length !== dimensions) {
    fail(`${label} must contain exactly ${dimensions} values`);
  }
  for (let index = 0; index < dimensions; index += 1) {
    const value = vector[index];
    if (!Number.isFinite(value) || Math.abs(value) > MAX_EMBEDDING_VALUE) {
      fail(`${label} must contain finite numbers within ${MAX_EMBEDDING_VALUE}`);
    }
  }
  return vector;
}

export function cosineSimilarity(left, right) {
  if (!left || !right || typeof left.length !== 'number' || typeof right.length !== 'number') {
    fail('cosine inputs must be arrays of numbers');
  }
  if (left.length !== right.length) fail('cosine inputs must have the same length');
  let leftScale = 0;
  let rightScale = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > MAX_EMBEDDING_VALUE || Math.abs(b) > MAX_EMBEDDING_VALUE) {
      fail('cosine inputs must contain finite bounded numbers');
    }
    leftScale = Math.max(leftScale, Math.abs(a));
    rightScale = Math.max(rightScale, Math.abs(b));
  }
  if (leftScale === 0 || rightScale === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] / leftScale;
    const b = right[index] / rightScale;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const similarity = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  if (!Number.isFinite(similarity)) return 0;
  return similarity < -1 ? -1 : similarity > 1 ? 1 : similarity;
}

function queryTerms(query) {
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > MAX_QUERY_LENGTH) {
    fail(`query must be a non-empty string of at most ${MAX_QUERY_LENGTH} characters`);
  }
  const terms = [...featureTerms(query).keys()];
  if (terms.length === 0) fail('query must contain at least one meaningful word');
  return terms.slice(0, MAX_QUERY_TERMS);
}

function lexicalMatch(entry, terms) {
  const tokens = Object.keys(entry.tokens);
  const matched = [];
  const lines = new Set();
  for (const term of terms) {
    let best;
    for (const token of tokens) {
      if (term.length < 3 ? token !== term : !token.includes(term)) continue;
      const tokenLines = entry.tokens[token];
      if (!best || tokenLines.length > best.length) best = tokenLines;
    }
    if (best) {
      matched.push(term);
      for (const line of best.slice(0, 20)) lines.add(line);
    }
  }
  return { matched, lines: [...lines].sort((a, b) => a - b).slice(0, 20) };
}

export async function hybridSearch(index, query, { limit = 20 } = {}) {
  const files = index?.files ?? index?.current?.files;
  const embedding = index?.embedding ?? index?.current?.embedding;
  if (!index || typeof index !== 'object' || !files || !embedding || !index.embeddingProvider) {
    fail('hybridSearch requires a loaded ProjectIndex');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('limit must be between 1 and 100');
  const terms = queryTerms(query);
  const [queryVector] = await index.embeddingProvider.embed([query]);
  const vector = validateEmbeddingVector(queryVector, embedding.dimensions, 'query embedding');
  const allowsVectorOnly = index.embeddingProvider.allowsVectorOnly === true;
  const hits = [];
  for (const [file, entry] of Object.entries(files)) {
    const fileVector = validateEmbeddingVector(entry.embedding, embedding.dimensions, `embedding for ${file}`);
    const lexical = lexicalMatch(entry, terms);
    const lexicalScore = lexical.matched.length / terms.length;
    const vectorScore = Math.max(0, cosineSimilarity(vector, fileVector));
    if (!Number.isFinite(lexicalScore) || !Number.isFinite(vectorScore)) continue;
    if (lexicalScore === 0 && (!allowsVectorOnly || vectorScore < MIN_VECTOR_SCORE)) continue;
    const score = Math.min(1, lexicalScore * 0.6 + vectorScore * 0.4);
    if (Number.isFinite(score)) hits.push({ file, lines: lexical.lines, score, lexicalScore, vectorScore });
  }
  return hits
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, limit);
}
