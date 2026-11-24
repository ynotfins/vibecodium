import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const TRUST_LABEL = 'untrusted-documentation-content';
export const MAX_SOURCES = 32;
export const MAX_DOCUMENTS = 10_000;
export const MAX_DOCUMENT_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 64_000_000;
export const MAX_QUERY_CHARS = 300;
export const MAX_RESULTS = 20;
export const DEFAULT_RESULTS = 10;
export const MAX_SNIPPET_CHARS = 800;
export const DEFAULT_SNIPPET_CHARS = 320;
export const MAX_READ_CHARS = 32_000;
export const DEFAULT_READ_CHARS = 8_000;

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MARKDOWN_FILE = /\.(?:md|markdown|mdx)$/i;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\u{E0001}\u{E0020}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
const QUERY_TOKEN = /[\p{L}\p{N}_]+/gu;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.vibe']);

export class DocsIndexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocsIndexError';
  }
}

function fail(message) {
  throw new DocsIndexError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitise(text) {
  return text.replace(UNSAFE_CONTROL, '\uFFFD');
}

function integerOption(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return value;
}

function normaliseRelative(file) {
  const parts = file.split(path.sep);
  if (parts.some((part) => part.length === 0 || part === '..' || part === '.')) {
    fail('docs document path is not valid');
  }
  const relative = parts.join('/');
  if (sanitise(relative) !== relative) fail('docs document path contains control characters');
  return relative;
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !relative.startsWith('../')
    && !path.isAbsolute(relative);
}

function documentTitle(content, relativePath) {
  for (const line of content.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+/.exec(line);
    if (heading) {
      const text = line.slice(heading[0].length);
      let end = text.length;
      while (end > 0 && text.charCodeAt(end - 1) === 35) end -= 1;
      const title = sanitise(text.slice(0, end)).trim().slice(0, 200);
      if (title.length > 0) return title;
    }
  }
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return sanitise(base.replace(/\.[^.]+$/, '')).slice(0, 200) || 'Documentation';
}

function normaliseRoots(roots) {
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > MAX_SOURCES) {
    fail('roots must contain at least one docs source and at most ' + MAX_SOURCES);
  }
  const seen = new Set();
  const result = roots.map((root) => {
    if (!isPlainObject(root)) fail('each docs root must be an object');
    if (typeof root.id !== 'string' || !SOURCE_ID.test(root.id)) {
      fail('docs source id is not valid');
    }
    if (seen.has(root.id)) fail('duplicate docs source id: ' + root.id);
    seen.add(root.id);
    if (typeof root.path !== 'string' || !path.isAbsolute(root.path)) {
      fail('docs source path must be absolute');
    }
    if (root.title !== undefined && (typeof root.title !== 'string' || root.title.trim().length === 0 || root.title.length > 200)) {
      fail('docs source title is not valid');
    }
    return {
      id: root.id,
      path: path.resolve(root.path),
      title: root.title === undefined ? root.id : sanitise(root.title).trim(),
    };
  });
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function occurrenceCount(haystack, needle) {
  let count = 0;
  let offset = 0;
  while (offset < haystack.length) {
    const found = haystack.indexOf(needle, offset);
    if (found === -1) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function queryTokens(query) {
  const tokens = [...new Set((query.toLowerCase().match(QUERY_TOKEN) || []))]
    .filter((token) => token.length > 0)
    .slice(0, 32);
  if (tokens.length === 0) fail('query must contain at least one letter or number');
  return tokens;
}

function snippetFor(document, phrase, tokens, limit) {
  const lower = document.searchLower;
  const positions = [phrase, ...tokens]
    .filter((needle) => needle.length > 0)
    .map((needle) => lower.indexOf(needle))
    .filter((offset) => offset >= 0);
  const first = positions.length === 0 ? 0 : Math.min(...positions);
  const start = Math.max(0, first - Math.floor(limit / 3));
  return document.content.slice(start, start + limit);
}

export class DocsIndex {
  constructor(options = {}) {
    if (!isPlainObject(options)) fail('docs index options must be an object');
    for (const key of Object.keys(options)) {
      if (!['roots', 'documentLimit', 'maxDocumentBytes', 'maxTotalBytes', 'snippetLimit'].includes(key)) {
        fail('unexpected docs index option: ' + key);
      }
    }
    this.roots = normaliseRoots(options.roots);
    this.documentLimit = integerOption('documentLimit', options.documentLimit ?? MAX_DOCUMENTS, 1, MAX_DOCUMENTS);
    this.maxDocumentBytes = integerOption('maxDocumentBytes', options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES, 1, MAX_DOCUMENT_BYTES);
    this.maxTotalBytes = integerOption('maxTotalBytes', options.maxTotalBytes ?? MAX_TOTAL_BYTES, 1, MAX_TOTAL_BYTES);
    this.snippetLimit = integerOption('snippetLimit', options.snippetLimit ?? DEFAULT_SNIPPET_CHARS, 40, MAX_SNIPPET_CHARS);
    this.documents = null;
    this.sources = null;
    this.bytes = 0;
  }

  async refresh() {
    const documents = [];
    const sources = [];
    let totalBytes = 0;

    for (const root of this.roots) {
      const details = await stat(root.path).catch((error) => {
        if (error.code === 'ENOENT') fail('docs root does not exist: ' + root.id);
        fail('docs root is not readable: ' + root.id);
      });
      if (!details.isDirectory()) fail('docs root is not a directory: ' + root.id);
      const canonical = await realpath(root.path).catch(() => fail('docs root is not readable: ' + root.id));
      const files = await this.collectFiles(canonical, '');
      let sourceBytes = 0;

      for (const relativePath of files) {
        const fullPath = path.join(canonical, ...relativePath.split('/'));
        const found = await lstat(fullPath).catch(() => null);
        if (!found || !found.isFile() || found.isSymbolicLink()) continue;
        if (found.size > this.maxDocumentBytes) {
          fail('docs document exceeds ' + this.maxDocumentBytes + ' bytes: ' + root.id + '/' + relativePath);
        }
        const canonicalFile = await realpath(fullPath).catch(() => null);
        if (!canonicalFile || !isInsideRoot(canonical, canonicalFile)) continue;
        const raw = await readFile(canonicalFile, 'utf8').catch(() => {
          fail('docs document is not readable: ' + root.id + '/' + relativePath);
        });
        const after = await lstat(canonicalFile).catch(() => null);
        if (!after || !after.isFile() || after.isSymbolicLink() || after.size !== found.size) continue;
        const content = sanitise(raw);
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > this.maxDocumentBytes) {
          fail('docs document exceeds ' + this.maxDocumentBytes + ' bytes: ' + root.id + '/' + relativePath);
        }
        totalBytes += bytes;
        if (documents.length + 1 > this.documentLimit) {
          fail('docs index exceeds documentLimit of ' + this.documentLimit);
        }
        if (totalBytes > this.maxTotalBytes) {
          fail('docs index exceeds maxTotalBytes of ' + this.maxTotalBytes);
        }
        sourceBytes += bytes;
        const documentId = root.id + ':' + relativePath.split('/').map(encodeURIComponent).join('/');
        const searchLower = content.toLowerCase();
        documents.push({
          id: documentId,
          sourceId: root.id,
          path: relativePath,
          title: documentTitle(content, relativePath),
          content,
          contentBytes: bytes,
          searchLower,
        });
      }

      sources.push({
        id: root.id,
        title: root.title,
        documentCount: files.length,
        bytes: sourceBytes,
      });
    }

    documents.sort((left, right) => left.id.localeCompare(right.id));
    this.documents = documents;
    this.sources = sources;
    this.bytes = totalBytes;
    return this.list();
  }

  async collectFiles(canonicalRoot, relativeDirectory) {
    const directory = relativeDirectory.length === 0
      ? canonicalRoot
      : path.join(canonicalRoot, ...relativeDirectory.split('/'));
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      fail('cannot read docs directory: ' + (error.code || 'unknown'));
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const files = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        const nested = relativeDirectory.length === 0 ? entry.name : relativeDirectory + '/' + entry.name;
        files.push(...await this.collectFiles(canonicalRoot, nested));
        if (files.length > this.documentLimit) {
          fail('docs index exceeds documentLimit of ' + this.documentLimit);
        }
      } else if (entry.isFile() && MARKDOWN_FILE.test(entry.name)) {
        const relativePath = normaliseRelative(
          relativeDirectory.length === 0 ? entry.name : path.join(relativeDirectory, entry.name),
        );
        files.push(relativePath);
        if (files.length > this.documentLimit) {
          fail('docs index exceeds documentLimit of ' + this.documentLimit);
        }
      }
    }
    return files;
  }

  list() {
    if (this.documents === null) fail('docs index has not been refreshed');
    return {
      sources: this.sources.map((source) => ({ ...source })),
      documents: this.documents.length,
      bytes: this.bytes,
      sourceTrust: TRUST_LABEL,
    };
  }

  find(options = {}) {
    if (!isPlainObject(options)) fail('docs search options must be an object');
    for (const key of Object.keys(options)) {
      if (!['query', 'source', 'limit', 'snippetLimit'].includes(key)) {
        fail('unexpected docs search option: ' + key);
      }
    }
    if (typeof options.query !== 'string' || options.query.trim().length === 0) {
      fail('query must be a non-empty string');
    }
    if (options.query.length > MAX_QUERY_CHARS) fail('query exceeds ' + MAX_QUERY_CHARS + ' characters');
    const query = sanitise(options.query).trim();
    const phrase = query.toLowerCase().replace(/\s+/g, ' ');
    const tokens = queryTokens(query);
    const limit = integerOption('limit', options.limit ?? DEFAULT_RESULTS, 1, MAX_RESULTS);
    const snippetLimit = integerOption('snippetLimit', options.snippetLimit ?? this.snippetLimit, 40, MAX_SNIPPET_CHARS);
    if (options.source !== undefined) {
      if (typeof options.source !== 'string' || !this.roots.some((root) => root.id === options.source)) {
        fail('unknown docs source: ' + String(options.source));
      }
    }
    if (this.documents === null) fail('docs index has not been refreshed');

    const matches = [];
    for (const document of this.documents) {
      if (options.source !== undefined && document.sourceId !== options.source) continue;
      let score = 0;
      let matched = false;
      if (document.searchLower.includes(phrase)) {
        score += 10;
        matched = true;
      }
      for (const token of tokens) {
        const count = occurrenceCount(document.searchLower, token);
        if (count > 0) {
          matched = true;
          score += Math.min(count, 20);
        }
        if (document.title.toLowerCase().includes(token)) score += 4;
      }
      if (!matched) continue;
      matches.push({ document, score });
    }
    matches.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.document.id.localeCompare(right.document.id);
    });

    const results = matches.slice(0, limit).map(({ document, score }) => ({
      documentId: document.id,
      sourceId: document.sourceId,
      path: document.path,
      title: document.title,
      snippet: snippetFor(document, phrase, tokens, snippetLimit),
      score,
      sourceTrust: TRUST_LABEL,
    }));
    return {
      query,
      total: matches.length,
      returned: results.length,
      hasMore: matches.length > results.length,
      results,
      sourceTrust: TRUST_LABEL,
    };
  }

  read(options = {}) {
    if (!isPlainObject(options)) fail('docs read options must be an object');
    for (const key of Object.keys(options)) {
      if (!['documentId', 'characterLimit'].includes(key)) {
        fail('unexpected docs read option: ' + key);
      }
    }
    if (typeof options.documentId !== 'string' || options.documentId.length < 1 || options.documentId.length > 2_048) {
      fail('documentId must be a non-empty string');
    }
    const characterLimit = integerOption(
      'characterLimit',
      options.characterLimit ?? DEFAULT_READ_CHARS,
      1,
      MAX_READ_CHARS,
    );
    if (this.documents === null) fail('docs index has not been refreshed');
    const document = this.documents.find((item) => item.id === options.documentId);
    if (!document) fail('unknown docs document: ' + options.documentId);
    const content = document.content.slice(0, characterLimit);
    return {
      documentId: document.id,
      sourceId: document.sourceId,
      path: document.path,
      title: document.title,
      content,
      contentBytes: document.contentBytes,
      returnedBytes: Buffer.byteLength(content, 'utf8'),
      truncated: content.length < document.content.length,
      sourceTrust: TRUST_LABEL,
    };
  }
}
