// LanceDB persistence for the standalone index vectors.
//
// The store is driver-injected: this repository ships no package manager and no
// native binary, so the caller supplies the @lancedb/lancedb Node driver it
// installed (pin LANCEDB_NODE_VERSION). Nothing here downloads, loads or bundles
// a native module by itself, and the uri must point at a local database.

import { validateEmbeddingVector } from './embedding-index.mjs';

export const LANCEDB_STORE_VERSION = 1;
export const LANCEDB_NODE_VERSION = '0.41.0';
export const DEFAULT_TABLE_NAME = 'vibecodium_file_vectors';
export const MAX_ROWS = 10_000;
export const MAX_DIMENSIONS = 4_096;
export const MAX_URI_LENGTH = 4_096;
export const MAX_SEARCH_LIMIT = 200;
export const SOURCE_TRUST = 'untrusted-repository-content';

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FILE_PATH = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const UNSAFE_FILE = /[:\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
const UNSAFE_URI = /[\p{Cf}\p{Zl}\p{Zp}<>]/u;
const REMOTE_URI = /^(?:https?|s3|gs|gcs|az|azure|ftp|file):\/\//i;
const SHA256 = /^[a-f0-9]{64}$/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_FILE_LENGTH = 4_096;
const MAX_DISTANCE = 2;
const DELETE_CHUNK = 200;

export class LanceDbStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LanceDbStoreError';
  }
}

function fail(message) {
  throw new LanceDbStoreError(message);
}

function validateDimensions(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSIONS) {
    fail(`dimensions must be an integer between 1 and ${MAX_DIMENSIONS}`);
  }
  return value;
}

function validateProvider(value) {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) {
    fail('provider must be a short lowercase provider id');
  }
  return value;
}

function validateUri(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URI_LENGTH) {
    fail('uri must be a non-empty string');
  }
  if (!FILE_PATH.test(value) || UNSAFE_URI.test(value)) fail('uri contains unsupported characters');
  if (REMOTE_URI.test(value)) fail('uri must point at a local LanceDB database');
  if (/^(?:\\\\|\/\/)/.test(value)) fail('uri must point at a local LanceDB database');
  return value;
}

function validateTableName(value) {
  if (typeof value !== 'string' || !TABLE_NAME.test(value)) {
    fail('tableName must be a short identifier');
  }
  return value;
}

function validateFile(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FILE_LENGTH ||
      !FILE_PATH.test(value) || UNSAFE_FILE.test(value)) {
    fail('file must be a non-empty project-relative path');
  }
  const file = value.replace(/\\/g, '/');
  if (file.startsWith('/') || file.startsWith('//') || /^[A-Za-z]:/.test(file)) fail('file must be project-relative');
  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('file must stay within the project root');
  }
  if (segments.some((segment) => /[. ]$/.test(segment) || RESERVED_NAME.test(segment))) {
    fail('file must be a portable project-relative path');
  }
  return file;
}

function validateHash(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('hash must be a SHA-256 hex digest');
  return value;
}

function escapeFilterLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

export function validateLanceDriver(driver) {
  if (!driver || typeof driver !== 'object' || Array.isArray(driver)) fail('lancedb driver must be an object');
  let connect;
  try {
    connect = driver.connect;
  } catch {
    fail('lancedb driver must expose connect()');
  }
  if (typeof connect !== 'function') fail('lancedb driver must expose connect()');
  return driver;
}

function validateTable(table) {
  if (!table || typeof table !== 'object') fail('lancedb table is invalid');
  let shape;
  try {
    shape = [table.vectorSearch, table.delete, table.mergeInsert].map((value) => typeof value === 'function');
  } catch {
    fail('lancedb table is invalid');
  }
  if (!shape[0]) fail('lancedb table must expose vectorSearch()');
  if (!shape[1]) fail('lancedb table must expose delete()');
  if (!shape[2]) fail('lancedb table must expose mergeInsert()');
  return table;
}

export function validateLanceVectorStore(store, embeddingProvider) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) fail('vectorStore must be an object');
  let methods;
  try {
    methods = [store.upsert, store.delete, store.search].map((value) => typeof value === 'function');
  } catch {
    fail('vectorStore must expose upsert(), delete() and search()');
  }
  if (!methods[0] || !methods[1] || !methods[2]) {
    fail('vectorStore must expose upsert(), delete() and search()');
  }
  if (!embeddingProvider || typeof embeddingProvider !== 'object') fail('embeddingProvider is required');
  let provider;
  let dimensions;
  try {
    provider = store.provider;
    dimensions = store.dimensions;
  } catch {
    fail('vectorStore metadata is unreadable');
  }
  if (provider !== embeddingProvider.id) fail('vectorStore provider does not match the embedding provider');
  if (dimensions !== embeddingProvider.dimensions) fail('vectorStore dimensions do not match the embedding provider');
  return store;
}

export function validateVectorHits(hits, { limit = MAX_SEARCH_LIMIT } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    fail(`limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
  }
  if (!Array.isArray(hits)) fail('vector search results must be an array');
  if (hits.length > limit) fail('vector search returned too many results');
  const output = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) fail('vector search result is invalid');
    let fileValue;
    let score;
    let distance;
    let hash;
    try {
      fileValue = hit.file;
      score = hit.score;
      distance = hit.distance;
      hash = hit.hash;
    } catch {
      fail('vector search result is unreadable');
    }
    const file = validateFile(fileValue);
    if (!Number.isFinite(score) || score < 0 || score > 1) fail('vector search score is invalid');
    if (!Number.isFinite(distance) || distance < 0 || distance > MAX_DISTANCE) fail('vector search distance is invalid');
    if (hash !== undefined && (typeof hash !== 'string' || !SHA256.test(hash))) fail('vector search hash is invalid');
    output.push({ file, score, distance, ...(hash === undefined ? {} : { hash }), sourceTrust: SOURCE_TRUST });
  }
  return output
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, limit);
}

export class LanceDbVectorStore {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options must be an object');
    const { driver, uri, tableName = DEFAULT_TABLE_NAME, dimensions, provider } = options;
    this.driver = validateLanceDriver(driver);
    this.uri = validateUri(uri);
    this.tableName = validateTableName(tableName);
    this.dimensions = validateDimensions(dimensions);
    this.provider = validateProvider(provider);
    this.db = null;
    this.table = null;
    this.opening = null;
  }

  async open() {
    await this.#table();
    return this;
  }

  async #connect() {
    if (this.db) return this.db;
    let db;
    try {
      db = await this.driver.connect(this.uri);
    } catch {
      fail('lancedb connect failed');
    }
    let shape;
    try {
      shape = db && typeof db === 'object' &&
        [db.createTable, db.openTable, db.tableNames].every((value) => typeof value === 'function');
    } catch {
      shape = false;
    }
    if (!shape) {
      fail('lancedb connection has an unsupported shape');
    }
    this.db = db;
    return db;
  }

  async #table() {
    if (this.table) return this.table;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const db = await this.#connect();
      let names;
      try {
        names = await db.tableNames();
      } catch {
        fail('lancedb table list failed');
      }
      let valid;
      try {
        valid = Array.isArray(names) && names.every((name) => typeof name === 'string');
      } catch {
        valid = false;
      }
      if (!valid) {
        fail('lancedb table list is invalid');
      }
      let exists;
      try {
        exists = names.includes(this.tableName);
      } catch {
        fail('lancedb table list is invalid');
      }
      if (exists) {
        let table;
        try {
          table = await db.openTable(this.tableName);
        } catch {
          fail('lancedb table could not be opened');
        }
        validateTable(table);
        this.table = table;
      }
      return this.table;
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  async #create(records) {
    const db = await this.#connect();
    let table;
    try {
      table = await db.createTable(this.tableName, records);
    } catch {
      fail('lancedb table could not be created');
    }
    validateTable(table);
    this.table = table;
    return table;
  }

  async upsert(rows) {
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) {
      fail(`upsert must contain between 1 and ${MAX_ROWS} rows`);
    }
    const records = rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('upsert row must be an object');
      let fileValue;
      let hashValue;
      let vectorValue;
      try {
        fileValue = row.file;
        hashValue = row.hash;
        vectorValue = row.vector;
      } catch {
        fail('upsert row is unreadable');
      }
      const file = validateFile(fileValue);
      const hash = validateHash(hashValue);
      const vector = validateEmbeddingVector(vectorValue, this.dimensions, `embedding for ${file}`);
      return {
        id: file,
        file,
        hash,
        provider: this.provider,
        dimensions: this.dimensions,
        vector: Array.from(vector),
        sourceTrust: SOURCE_TRUST,
      };
    });
    const ids = new Set();
    for (const record of records) {
      if (ids.has(record.id)) fail('upsert rows must have unique file ids');
      ids.add(record.id);
    }
    const table = this.table ?? await this.#table();
    if (!table) {
      const created = await this.#create(records);
      this.table = created;
      return records.length;
    }
    try {
      if (typeof table.mergeInsert !== 'function') fail('lancedb table must expose mergeInsert()');
      let builder = table.mergeInsert('id');
      if (!builder || typeof builder.whenMatchedUpdateAll !== 'function' ||
          typeof builder.whenNotMatchedInsertAll !== 'function' || typeof builder.execute !== 'function') {
        fail('lancedb mergeInsert builder is invalid');
      }
      builder = builder.whenMatchedUpdateAll();
      builder = builder.whenNotMatchedInsertAll();
      await builder.execute(records);
    } catch (error) {
      if (error instanceof LanceDbStoreError) throw error;
      fail('lancedb upsert failed');
    }
    return records.length;
  }

  async delete(files) {
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_ROWS) {
      fail(`delete must contain between 1 and ${MAX_ROWS} files`);
    }
    const unique = [];
    const seen = new Set();
    for (const value of files) {
      const file = validateFile(value);
      if (seen.has(file)) continue;
      seen.add(file);
      unique.push(file);
    }
    const table = this.table ?? await this.#table();
    if (!table) return 0;
    try {
      for (let index = 0; index < unique.length; index += DELETE_CHUNK) {
        const chunk = unique.slice(index, index + DELETE_CHUNK);
        const filter = chunk.length === 1
          ? `id = ${escapeFilterLiteral(chunk[0])}`
          : `id IN (${chunk.map(escapeFilterLiteral).join(', ')})`;
        await table.delete(filter);
      }
    } catch {
      fail('lancedb delete failed');
    }
    return unique.length;
  }

  async search(vector, { limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      fail(`limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
    }
    const query = validateEmbeddingVector(vector, this.dimensions, 'query embedding');
    const table = this.table ?? await this.#table();
    if (!table) return [];
    let rows;
    try {
      let request = table.vectorSearch(Array.from(query));
      if (!request || typeof request.limit !== 'function' || typeof request.toArray !== 'function') {
        fail('lancedb vector query is invalid');
      }
      if (typeof request.distanceType === 'function') request = request.distanceType('cosine');
      rows = await request.limit(limit).toArray();
    } catch (error) {
      if (error instanceof LanceDbStoreError) throw error;
      fail('lancedb vector search failed');
    }
    if (!Array.isArray(rows)) fail('lancedb vector search result is invalid');
    if (rows.length > limit) fail('lancedb vector search returned too many rows');
    const hits = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('lancedb vector search row is invalid');
      let fileValue;
      let distance;
      let hash;
      try {
        fileValue = row.file ?? row.id;
        distance = row._distance ?? row.distance;
        hash = row.hash;
      } catch {
        fail('lancedb vector search row is unreadable');
      }
      const file = validateFile(fileValue);
      if (!Number.isFinite(distance) || distance < 0 || distance > MAX_DISTANCE) {
        fail('lancedb vector search distance is invalid');
      }
      const score = Math.max(0, Math.min(1, 1 - distance));
      if (hash !== undefined && (typeof hash !== 'string' || !SHA256.test(hash))) {
        fail('lancedb vector search hash is invalid');
      }
      hits.push({ file, score, distance, ...(hash === undefined ? {} : { hash }), sourceTrust: SOURCE_TRUST });
    }
    return validateVectorHits(hits, { limit });
  }
}

export async function openLanceDbVectorStore(options) {
  const store = new LanceDbVectorStore(options);
  await store.open();
  return store;
}
