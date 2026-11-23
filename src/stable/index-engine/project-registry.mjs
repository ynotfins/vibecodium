import { watch as watchFs } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { ProjectIndex } from './index-engine.mjs';

export const MAX_PROJECTS = 32;
export const MIN_WATCH_INTERVAL_MS = 25;
export const MAX_WATCH_INTERVAL_MS = 60_000;
const MAX_PENDING_RUNS = 32;

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WATCH_IGNORED_DIRECTORIES = new Set([
  '.cache', '.git', '.next', '.vibe', 'build', 'coverage', 'dist', 'node_modules', 'out', 'vendor',
]);
const RESERVED_WINDOWS_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export class ProjectRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectRegistryError';
  }
}

function fail(message) {
  throw new ProjectRegistryError(message);
}

function validateInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeId(id) {
  if (typeof id !== 'string' || !PROJECT_ID.test(id) || /[ .]$/.test(id)) {
    fail('id must be a simple project id');
  }
  if (RESERVED_WINDOWS_NAMES.has(id.split('.')[0].toUpperCase())) {
    fail('id must not be a Windows device name');
  }
  return id;
}

function rootKey(root) {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function isRelevantWatchPath(filename, record) {
  const normalized = String(filename).replaceAll(String.fromCharCode(92), String.fromCharCode(47));
  if (normalized.length === 0 || normalized.includes('\0')) return false;
  const segments = normalized.split(String.fromCharCode(47)).filter(Boolean).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => WATCH_IGNORED_DIRECTORIES.has(segment))) return false;
  const indexSegments = record.indexDir.split(String.fromCharCode(47)).filter(Boolean).map((segment) => segment.toLowerCase());
  if (indexSegments.length <= segments.length && indexSegments.every((segment, index) => segments[index] === segment)) {
    const generated = segments.slice(indexSegments.length);
    if (generated.length === 1) {
      const indexFile = record.indexFile.toLowerCase();
      const name = generated[0];
      if (name === indexFile || (name.startsWith(`${indexFile}.`) && name.endsWith('.tmp'))) return false;
    }
  }
  return true;
}

async function validateRoot(record) {
  const resolved = await realpath(record.root).catch(() => null);
  if (!resolved || rootKey(resolved) !== rootKey(record.root)) {
    fail('project root changed after registration');
  }
  const info = await stat(resolved).catch(() => null);
  if (!info || !info.isDirectory() || info.dev !== record.rootDev || info.ino !== record.rootIno) {
    fail('project root changed after registration');
  }
}

export class ProjectRegistry {
  constructor(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      fail('options must be an object');
    }
    const projectOptions = options.projectOptions ?? {};
    if (projectOptions === null || typeof projectOptions !== 'object' || Array.isArray(projectOptions)) {
      fail('projectOptions must be an object');
    }
    this.maxProjects = validateInteger('maxProjects', options.maxProjects ?? MAX_PROJECTS, 1, MAX_PROJECTS);
    this.watchIntervalMs = validateInteger(
      'watchIntervalMs',
      options.watchIntervalMs ?? 250,
      MIN_WATCH_INTERVAL_MS,
      MAX_WATCH_INTERVAL_MS,
    );
    this.projectOptions = { ...projectOptions };
    this.projects = new Map();
    this.projectsByRoot = new Map();
    this.closed = false;
    this.registerQueue = Promise.resolve();
    this.registerPending = 0;
  }

  register(root, options = {}) {
    if (this.registerPending >= MAX_PENDING_RUNS) {
      return Promise.reject(new ProjectRegistryError('too many pending registrations'));
    }
    this.registerPending += 1;
    const next = this.registerQueue.then(() => this.registerOne(root, options));
    this.registerQueue = next.then(
      () => { this.registerPending -= 1; },
      () => { this.registerPending -= 1; },
    );
    return next;
  }

  async registerOne(root, options = {}) {
    if (this.closed) fail('registry is closed');
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      fail('options must be an object');
    }
    const { id } = options;
    normalizeId(id);
    const key = id.toLowerCase();
    if (this.projects.has(key)) fail('project id is already registered');
    if (this.projects.size >= this.maxProjects) fail('registry is full');
    if (typeof root !== 'string' || root.length === 0 || root.length > 4096 || root.includes('\0')) {
      fail('root must be a non-empty path string');
    }

    const realRoot = await realpath(path.resolve(root)).catch(() => null);
    if (!realRoot) fail('project root does not exist');
    const info = await stat(realRoot).catch(() => null);
    if (!info || !info.isDirectory()) fail('project root must be a directory');
    const projectRootKey = rootKey(realRoot);
    if (this.projectsByRoot.has(projectRootKey)) fail('project root is already registered');

    const expectedRoot = { rootKey: projectRootKey, rootDev: info.dev, rootIno: info.ino };
    const index = new ProjectIndex(realRoot, {
      ...this.projectOptions,
      persist: false,
      expectedRoot,
    });
    await index.refresh();
    if (this.closed) fail('registry is closed');
    await validateRoot({ root: realRoot, rootDev: info.dev, rootIno: info.ino, rootKey: projectRootKey });
    const record = {
      id,
      key,
      root: realRoot,
      rootDev: info.dev,
      rootIno: info.ino,
      indexDir: path.relative(realRoot, index.indexDir).split(path.sep).join(String.fromCharCode(47)),
      indexFile: index.indexFile,
      rootKey: projectRootKey,
      index,
      timer: null,
      watchers: new Map(),
      watchLimitHit: false,
      autoQueued: false,
      autoAgain: false,
      refreshQueue: Promise.resolve(),
      pending: 0,
      lastError: null,
      lastRefreshAt: Date.now(),
      refreshCount: 1,
    };
    this.projects.set(key, record);
    this.projectsByRoot.set(projectRootKey, key);
    try {
      await this.startWatcher(record);
      const catchUp = await this.enqueueRun(record);
      if (catchUp?.error) throw catchUp.error;
    } catch (error) {
      if (record.timer) clearInterval(record.timer);
      record.timer = null;
      this.closeWatchers(record);
      this.projects.delete(key);
      this.projectsByRoot.delete(projectRootKey);
      throw error;
    }
    return this.describe(record);
  }

  list() {
    if (this.closed) fail('registry is closed');
    return [...this.projects.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((record) => this.describe(record));
  }

  get(id) {
    if (this.closed) fail('registry is closed');
    return this.require(id).index;
  }

  index(id) {
    const index = this.get(id);
    if (!index.current) fail('project index is not loaded');
    return index.current;
  }

  symbols(id, options) {
    return this.get(id).symbols(options);
  }

  searchText(id, query, options) {
    return this.get(id).searchText(query, options);
  }

  stats(id) {
    const record = this.require(id);
    return {
      id: record.id,
      root: record.root,
      watching: record.timer !== null || record.watchers.size > 0,
      mode: record.timer !== null ? 'poll' : record.watchers.size > 0 ? 'watch' : 'none',
      watchers: record.watchers.size,
      dirty: record.pending > 0,
      refreshing: record.pending > 0,
      refreshCount: record.refreshCount,
      lastRefreshAt: record.lastRefreshAt,
      lastError: record.lastError ? { name: record.lastError.name, message: record.lastError.message } : null,
    };
  }

  async refresh(id) {
    if (this.closed) fail('registry is closed');
    const record = this.require(id);
    const result = await this.enqueueRun(record);
    if (result?.error) throw result.error;
    return this.describe(record);
  }

  async refreshAll() {
    if (this.closed) fail('registry is closed');
    await Promise.all([...this.projects.values()].map((record) => this.refresh(record.id)));
  }

  async waitForIdle() {
    for (;;) {
      const records = [...this.projects.values()];
      const queues = records.map((record) => record.refreshQueue);
      await Promise.all(queues);
      if (this.closed || records.length !== this.projects.size ||
          records.every((record, index) => record.refreshQueue === queues[index])) return;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.registerQueue.catch(() => {});
    const pending = [];
    for (const record of this.projects.values()) {
      if (record.timer) clearInterval(record.timer);
      record.timer = null;
      this.closeWatchers(record);
      pending.push(record.refreshQueue);
    }
    await Promise.allSettled(pending);
    this.projects.clear();
    this.projectsByRoot.clear();
  }

  require(id) {
    if (this.closed) fail('registry is closed');
    normalizeId(id);
    const record = this.projects.get(id.toLowerCase());
    if (!record) fail('project is not registered');
    return record;
  }

  describe(record) {
    return { id: record.id, root: record.root };
  }

  async startWatcher(record) {
    if (process.platform === 'win32') {
      this.startPolling(record);
      return;
    }
    await this.addWatcherTree(record, '');
    if (record.watchers.size === 0) this.startPolling(record);
  }

  async addWatcherTree(record, relativeDir) {
    if (this.closed || record.watchers.has(relativeDir)) return;
    if (record.watchLimitHit) return;
    if (record.watchers.size >= record.index.options.maxDirs) {
      record.watchLimitHit = true;
      this.fallbackToPolling(record);
      return;
    }
    const directory = relativeDir ? path.join(record.root, relativeDir) : record.root;
    let watcher;
    try {
      watcher = watchFs(directory, { persistent: false }, (eventType, filename) => {
        this.handleWatchEvent(record, relativeDir, eventType, filename);
      });
      if (typeof watcher.unref === 'function') watcher.unref();
      watcher.on('error', () => this.fallbackToPolling(record));
      record.watchers.set(relativeDir, watcher);
    } catch {
      this.fallbackToPolling(record);
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      this.fallbackToPolling(record);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (WATCH_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const child = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      await this.addWatcherTree(record, child);
    }
  }

  handleWatchEvent(record, relativeDir, eventType, filename) {
    if (this.closed) return;
    if (filename == null || filename.length === 0) {
      this.fallbackToPolling(record);
      return;
    }
    const relative = relativeDir ? `${relativeDir}/${String(filename)}` : String(filename);
    if (eventType === 'rename') void this.reconcileWatchPath(record, relative);
    if (!isRelevantWatchPath(relative, record)) return;
    this.scheduleRefresh(record);
  }

  async reconcileWatchPath(record, relative) {
    if (this.closed) return;
    const absolute = path.join(record.root, relative);
    const info = await lstat(absolute).catch(() => null);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) {
      this.removeWatchersUnder(record, relative);
      return;
    }
    const segments = relative.split(String.fromCharCode(47));
    if (segments.some((segment) => WATCH_IGNORED_DIRECTORIES.has(segment.toLowerCase()))) {
      this.removeWatchersUnder(record, relative);
      return;
    }
    await this.addWatcherTree(record, relative);
    // A refresh triggered by the same rename can finish before these nested
    // watches attach, so files created in the gap would stay unindexed until
    // the next unrelated event. Refresh once more now that watches are ready.
    this.scheduleRefresh(record);
  }

  removeWatchersUnder(record, relative) {
    const prefix = `${relative}/`;
    for (const [watched, watcher] of record.watchers) {
      if (watched !== relative && !watched.startsWith(prefix)) continue;
      try {
        watcher.close();
      } catch {
        // The watcher may already be closed by the platform.
      }
      record.watchers.delete(watched);
    }
  }

  closeWatchers(record) {
    for (const watcher of record.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // The watcher may already be closed by the platform.
      }
    }
    record.watchers.clear();
  }

  fallbackToPolling(record) {
    record.watchLimitHit = true;
    this.closeWatchers(record);
    this.startPolling(record);
  }

  startPolling(record) {
    if (this.closed || record.timer) return;
    record.timer = setInterval(() => this.scheduleRefresh(record), this.watchIntervalMs);
    if (typeof record.timer.unref === 'function') record.timer.unref();
  }

  scheduleRefresh(record) {
    if (this.closed || !this.projects.has(record.key)) return Promise.resolve();
    if (record.autoQueued) {
      record.autoAgain = true;
      return record.refreshQueue;
    }
    record.autoQueued = true;
    return this.enqueueRun(record).then(
      () => this.finishAuto(record),
      () => this.finishAuto(record),
    );
  }

  finishAuto(record) {
    record.autoQueued = false;
    if (record.autoAgain && !this.closed) {
      record.autoAgain = false;
      this.scheduleRefresh(record);
    }
  }

  enqueueRun(record) {
    if (record.pending >= MAX_PENDING_RUNS) {
      return Promise.resolve({ error: new ProjectRegistryError('too many pending refreshes') });
    }
    const task = record.refreshQueue.then(async () => {
      if (this.closed || !this.projects.has(record.key)) return { skipped: true };
      const previous = record.index.current;
      let candidate;
      try {
        await validateRoot(record);
        await record.index.refresh({
          expectedRoot: { rootKey: record.rootKey, rootDev: record.rootDev, rootIno: record.rootIno },
        });
        candidate = record.index.current;
        record.index.current = previous;
        await validateRoot(record);
        record.index.current = candidate;
        record.lastError = null;
        record.lastRefreshAt = Date.now();
        record.refreshCount += 1;
        return { skipped: false };
      } catch (error) {
        record.index.current = previous;
        record.lastError = error;
        return { error };
      }
    });
    record.pending += 1;
    record.refreshQueue = task.then(
      () => { record.pending -= 1; },
      () => { record.pending -= 1; },
    );
    return task;
  }
}
