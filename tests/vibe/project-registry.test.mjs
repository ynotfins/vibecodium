import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ProjectRegistry,
  ProjectRegistryError,
} from '../../src/stable/index-engine/project-registry.mjs';
import { ProjectIndex } from '../../src/stable/index-engine/index-engine.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'repo-ts');
const PROJECT_IDS = ['alpha', 'beta', 'gamma'];

async function makeProjects(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibe-registry-'));
  const roots = {};
  for (const id of PROJECT_IDS) {
    roots[id] = path.join(dir, `repo-${id}`);
    await cp(FIXTURE, roots[id], { recursive: true, dereference: false });
  }
  t.after(() => rm(dir, { recursive: true, force: true }));
  return roots;
}

async function waitFor(predicate, message, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('three registered repositories stay current while edited in parallel', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 50 });
  t.after(() => registry.close());

  for (const id of PROJECT_IDS) {
    await registry.register(roots[id], { id });
  }

  assert.deepEqual(registry.list().map((project) => project.id), PROJECT_IDS);
  for (const id of PROJECT_IDS) {
    assert.equal(registry.get(id).root, roots[id]);
    assert.ok(registry.get(id).symbols().some((symbol) => symbol.name === 'slugify'));
  }

  const markerNames = {};
  await Promise.all(PROJECT_IDS.map(async (id) => {
    const marker = `parallelEdit${id[0].toUpperCase()}${id.slice(1)}`;
    markerNames[id] = marker;
    const target = path.join(roots[id], 'src', 'util', 'strings.ts');
    const original = await readFile(target, 'utf8');
    await writeFile(target, `${original}\nexport function ${marker}(): string {\n  return '${id}';\n}\n`);
  }));

  for (const id of PROJECT_IDS) {
    const marker = markerNames[id];
    await waitFor(
      () => registry.get(id).symbols().some((symbol) => symbol.name === marker),
      `${id} did not index ${marker}`,
    );
  }

  for (const id of PROJECT_IDS) {
    const names = new Set(registry.get(id).symbols().map((symbol) => symbol.name));
    assert.ok(registry.searchText(id, markerNames[id]).length > 0, `${id} text query missed its marker`);
    for (const other of PROJECT_IDS) {
      if (other !== id) {
        assert.ok(!names.has(markerNames[other]), `${id} leaked ${markerNames[other]}`);
        assert.deepEqual(registry.searchText(id, markerNames[other]), [], `${id} leaked ${markerNames[other]} in text`);
      }
    }
  }

  for (const id of PROJECT_IDS) {
    const stats = registry.stats(id);
    assert.equal(stats.watching, true);
    assert.ok(stats.refreshCount > 1, `${id} did not refresh in the background`);
  }
});

test('registry rejects duplicate roots, unsafe ids and unknown projects', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 50 });
  t.after(() => registry.close());

  await registry.register(roots.alpha, { id: 'alpha' });
  await assert.rejects(registry.register(roots.alpha, { id: 'alpha-copy' }), ProjectRegistryError);
  await assert.rejects(registry.register(roots.beta, { id: '../escape' }), ProjectRegistryError);
  await assert.rejects(registry.register(roots.beta, { id: 'CON' }), ProjectRegistryError);
  await assert.rejects(registry.register(roots.beta, { id: '' }), ProjectRegistryError);
  await assert.rejects(registry.register(path.join(roots.alpha, 'missing'), { id: 'missing' }), ProjectRegistryError);
  assert.throws(() => new ProjectRegistry({ maxProjects: 0 }), ProjectRegistryError);
  assert.throws(() => new ProjectRegistry({ watchIntervalMs: 1 }), ProjectRegistryError);
  assert.throws(() => registry.get('missing'), ProjectRegistryError);

  const full = new ProjectRegistry({ maxProjects: 1, watchIntervalMs: 50 });
  t.after(() => full.close());
  await full.register(roots.beta, { id: 'only' });
  await assert.rejects(full.register(roots.gamma, { id: 'second' }), /registry is full/);
});

test('registry-owned indexes stay in memory and keep their root pin', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  t.after(() => registry.close());
  await registry.register(roots.alpha, { id: 'alpha' });

  await assert.rejects(access(path.join(roots.alpha, '.vibe', 'index', 'index.json')));
  const index = registry.get('alpha');
  assert.equal(index.persist, false);
  await assert.rejects(index.reindexFile('src/util/strings.ts'), /unavailable for pinned indexes/);
});

test('one project failure does not stop the others', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 50 });
  t.after(() => registry.close());

  await registry.register(roots.alpha, { id: 'alpha' });
  await registry.register(roots.beta, { id: 'beta' });
  await registry.waitForIdle();

  await rm(roots.alpha, { recursive: true, force: true });
  await assert.rejects(registry.refresh('alpha'), /root|directory/i);
  await waitFor(() => registry.stats('alpha').lastError !== null, 'alpha failure was not recorded');

  const marker = 'survivesAlphaFailure';
  const target = path.join(roots.beta, 'src', 'util', 'strings.ts');
  const original = await readFile(target, 'utf8');
  await writeFile(target, `${original}\nexport function ${marker}(): string {\n  return 'beta';\n}\n`);

  await waitFor(
    () => registry.searchText('beta', marker).length > 0,
    'beta stopped updating after alpha failed',
  );
  assert.equal(registry.stats('beta').lastError, null);
  assert.ok(registry.symbols('beta').some((symbol) => symbol.name === marker));
});

test('registration is serialized and close releases the registry', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 50 });
  t.after(() => registry.close());

  const results = await Promise.allSettled([
    registry.register(roots.beta, { id: 'beta' }),
    registry.register(roots.beta, { id: 'beta-copy' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.some((result) => result.status ===
    'rejected' && result.reason instanceof ProjectRegistryError));
  await assert.rejects(
    registry.register(roots.gamma, { id: 'BETA' }), ProjectRegistryError);

  await registry.close();
  assert.throws(() => registry.list(), ProjectRegistryError);
  assert.throws(() => registry.get('beta'), ProjectRegistryError);
});

function recursiveWatchSupported() {
  try {
    watch(FIXTURE, { recursive: true, persistent: false }).close();
    return true;
  } catch {
    return false;
  }
}

test('the recursive watcher is primary, not the polling fallback', async (t) => {
  if (!recursiveWatchSupported()) {
    t.skip('recursive fs.watch is unavailable on this platform');
    return;
  }
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  t.after(() => registry.close());

  await registry.register(roots.alpha, { id: 'alpha' });
  const target = path.join(roots.alpha, 'src', 'util', 'strings.ts');
  const original = await readFile(target, 'utf8');
  await writeFile(target, `${original}\nexport function watcherPrimaryProbe(): string {\n  return 'x';\n}\n`);

  await waitFor(
    () => registry.symbols('alpha').some((symbol) => symbol.name === 'watcherPrimaryProbe'),
    'a 60s polling interval cannot explain this update; fs.watch was not primary',
    5000,
  );
});

test('a watcher error falls back to polling and keeps indexing', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 50 });
  t.after(() => registry.close());

  await registry.register(roots.alpha, { id: 'alpha' });
  const record = registry.projects.get('alpha');
  assert.ok(record.watcher, 'expected a recursive watcher before the simulated error');
  record.watcher.emit('error', new Error('simulated watcher failure'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(record.watcher, null);
  assert.notEqual(record.timer, null);
  assert.equal(registry.stats('alpha').watching, true);

  const target = path.join(roots.alpha, 'src', 'util', 'strings.ts');
  const original = await readFile(target, 'utf8');
  await writeFile(target, `${original}\nexport function pollingFallbackProbe(): string {\n  return 'x';\n}\n`);
  await waitFor(
    () => registry.searchText('alpha', 'pollingFallbackProbe').length > 0,
    'polling did not resume after the watcher error',
  );
});

test('refresh awaits queued work and never overlaps index refreshes', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  t.after(() => registry.close());

  await registry.register(roots.alpha, { id: 'alpha' });
  const record = registry.projects.get('alpha');
  const originalRefresh = record.index.refresh.bind(record.index);
  let active = 0;
  let maxConcurrent = 0;
  record.index.refresh = async (...args) => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return await originalRefresh(...args);
    } finally {
      active -= 1;
    }
  };

  const target = path.join(roots.alpha, 'src', 'util', 'strings.ts');
  const original = await readFile(target, 'utf8');
  await writeFile(target, `${original}\nexport function refreshQueuedProbe(): string {\n  return 'x';\n}\n`);
  registry.scheduleRefresh(record);

  const started = Date.now();
  await registry.refresh('alpha');
  const elapsed = Date.now() - started;

  assert.ok(registry.symbols('alpha').some((symbol) => symbol.name === 'refreshQueuedProbe'));
  assert.ok(elapsed >= 100, 'refresh resolved without waiting for the in-flight drain');
  assert.equal(maxConcurrent, 1, 'two index refreshes ran at the same time');
});

test('explicit refresh awaits only its own queued run', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  const gates = [];
  t.after(async () => {
    for (const release of gates) release();
    await registry.close();
  });

  await registry.register(roots.alpha, { id: 'alpha' });
  const record = registry.projects.get('alpha');
  let active = 0;
  let maxConcurrent = 0;
  record.index.refresh = async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    gates.push(release);
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    try {
      await gate;
    } finally {
      active -= 1;
    }
    return { changed: 0 };
  };

  const explicit = registry.refresh('alpha');
  await waitFor(() => gates.length === 1, 'explicit refresh did not start');
  assert.equal(record.pending, 1);

  const early = await Promise.race([
    explicit.then(() => 'resolved'),
    delay(50).then(() => 'pending'),
  ]);
  assert.equal(early, 'pending', 'explicit refresh resolved before its own run finished');

  const later = registry.scheduleRefresh(record);
  gates[0]();

  const outcome = await Promise.race([
    explicit.then(() => 'resolved'),
    delay(500).then(() => 'blocked'),
  ]);
  assert.equal(outcome, 'resolved', 'explicit refresh waited for a later queued run');

  await waitFor(() => gates.length === 2, 'the later refresh did not queue behind the explicit one');
  assert.equal(maxConcurrent, 1, 'two index refreshes ran at the same time');
  gates[1]();
  await later;
  assert.equal(active, 0);
});

test('a directory moved into a project is indexed', async (t) => {
  if (!recursiveWatchSupported()) {
    t.skip('recursive fs.watch is unavailable on this platform');
    return;
  }
  const roots = await makeProjects(t);
  const incomingRoot = await mkdtemp(path.join(os.tmpdir(), 'vibe-incoming-'));
  t.after(() => rm(incomingRoot, { recursive: true, force: true }));
  await writeFile(
    path.join(incomingRoot, 'moved.ts'),
    'export function movedFolderProbe(): string {\n  return \'moved\';\n}\n',
  );

  const registry = new ProjectRegistry();
  t.after(() => registry.close());
  await registry.register(roots.alpha, { id: 'alpha' });

  await rename(incomingRoot, path.join(roots.alpha, 'src', 'incoming'));

  await waitFor(
    () => registry.symbols('alpha').some((symbol) => symbol.name === 'movedFolderProbe'),
    'moving a folder into the project did not refresh the index',
    3000,
  );
});

test('refresh fails closed if a registered root is swapped', async (t) => {
  const roots = await makeProjects(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vibe-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'moved.ts'), 'export function outsideRootProbe(): string { return "outside"; }\n');

  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  t.after(() => registry.close());
  const victim = roots.alpha;
  const backup = path.join(path.dirname(victim), 'alpha-backup');
  await registry.register(victim, { id: 'alpha' });
  await rename(victim, backup);
  try {
    await symlink(outside, victim, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    await rename(backup, victim);
    t.skip('directory symlinks are not available on this platform');
    return;
  }
  t.after(async () => {
    await unlink(victim).catch(() => {});
    await rename(backup, victim).catch(() => {});
  });

  await assert.rejects(registry.refresh('alpha'), /root changed/);
  assert.ok(registry.symbols('alpha').some((symbol) => symbol.name === 'slugify'));
  assert.ok(!registry.symbols('alpha').some((symbol) => symbol.name === 'outsideRootProbe'));
  await assert.rejects(access(path.join(outside, '.vibe')));
});

test('registration fails closed if the root is swapped during indexing', async (t) => {
  const roots = await makeProjects(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vibe-register-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'moved.ts'), 'export function registerSwapProbe(): string { return "outside"; }\n');

  const victim = roots.alpha;
  const backup = path.join(path.dirname(victim), 'alpha-register-backup');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const probe = path.join(path.dirname(victim), 'symlink-probe');
  try {
    await symlink(outside, probe, linkType);
    await unlink(probe);
  } catch {
    t.skip('directory symlinks are not available on this platform');
    return;
  }

  const original = ProjectIndex.prototype.refresh;
  let swapped = false;
  ProjectIndex.prototype.refresh = async function (...args) {
    if (swapped) return original.apply(this, args);
    swapped = true;
    await rename(victim, backup);
    try {
      await symlink(outside, victim, linkType);
      return await original.apply(this, args);
    } finally {
      await unlink(victim).catch(() => {});
      await rename(backup, victim).catch(() => {});
    }
  };
  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  t.after(async () => {
    ProjectIndex.prototype.refresh = original;
    await registry.close();
    await unlink(victim).catch(() => {});
    await rename(backup, victim).catch(() => {});
  });

  await assert.rejects(registry.register(victim, { id: 'alpha' }), /root changed/);
  assert.deepEqual(registry.list(), []);
  await assert.rejects(access(path.join(outside, '.vibe')));
});

test('refresh rejects a root swap during indexing without outside writes', async (t) => {
  const roots = await makeProjects(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vibe-refresh-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'moved.ts'), 'export function refreshSwapProbe(): string { return "outside"; }\n');

  const victim = roots.alpha;
  const backup = path.join(path.dirname(victim), 'alpha-refresh-backup');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const probe = path.join(path.dirname(victim), 'symlink-probe');
  try {
    await symlink(outside, probe, linkType);
    await unlink(probe);
  } catch {
    t.skip('directory symlinks are not available on this platform');
    return;
  }

  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  await registry.register(victim, { id: 'alpha' });
  t.after(async () => {
    await registry.close();
    await unlink(victim).catch(() => {});
    await rename(backup, victim).catch(() => {});
  });

  const record = registry.projects.get('alpha');
  const original = record.index.refresh.bind(record.index);
  let swapped = false;
  record.index.refresh = async (...args) => {
    if (swapped) return original(...args);
    swapped = true;
    await rename(victim, backup);
    try {
      await symlink(outside, victim, linkType);
      return await original(...args);
    } finally {
      await unlink(victim).catch(() => {});
      await rename(backup, victim).catch(() => {});
    }
  };

  await assert.rejects(registry.refresh('alpha'), /root changed/);
  assert.ok(registry.symbols('alpha').some((symbol) => symbol.name === 'slugify'));
  assert.ok(!registry.symbols('alpha').some((symbol) => symbol.name === 'refreshSwapProbe'));
  await assert.rejects(access(path.join(outside, '.vibe')));
});

test('snapshot verification rejects content that did not come from the root', async (t) => {
  const roots = await makeProjects(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vibe-snapshot-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideContent = 'export function outsideSnapshotProbe(): string { return "outside"; }\n';
  await writeFile(path.join(outside, 'moved.ts'), outsideContent);

  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  t.after(() => registry.close());
  await registry.register(roots.alpha, { id: 'alpha' });

  const record = registry.projects.get('alpha');
  const current = record.index.current;
  const outsideHash = createHash('sha256').update(outsideContent).digest('hex');
  const forged = {
    ...current,
    files: {
      ...current.files,
      'src/util/strings.ts': {
        ...current.files['src/util/strings.ts'],
        hash: outsideHash,
        bytes: Buffer.byteLength(outsideContent),
      },
    },
  };
  await assert.rejects(
    record.index.verifySnapshot(forged, {
      rootKey: record.rootKey,
      rootDev: record.rootDev,
      rootIno: record.rootIno,
    }),
    /snapshot does not match/,
  );
});

test('a watcher event without a usable filename falls back to polling', async (t) => {
  if (!recursiveWatchSupported()) {
    t.skip('recursive fs.watch is unavailable on this platform');
    return;
  }
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 50 });
  t.after(() => registry.close());
  await registry.register(roots.alpha, { id: 'alpha' });

  const record = registry.projects.get('alpha');
  assert.ok(record.watcher, 'expected a recursive watcher');
  record.watcher.emit('change', 'change', Buffer.alloc(0));
  assert.equal(record.watcher, null);
  assert.ok(record.timer, 'polling did not start after a filename-less event');

  const marker = 'filenameLessFallbackProbe';
  const target = path.join(roots.alpha, 'src', 'util', 'strings.ts');
  const original = await readFile(target, 'utf8');
  await writeFile(target, `${original}\nexport function ${marker}(): string { return 'fallback'; }\n`);
  await waitFor(
    () => registry.symbols('alpha').some((symbol) => symbol.name === marker),
    'polling did not keep the project current',
  );
});

test('a custom index directory watches source files without feeding itself', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({
    watchIntervalMs: 60000,
    projectOptions: { indexDir: 'src/custom-index' },
  });
  t.after(() => registry.close());
  await registry.register(roots.alpha, { id: 'alpha' });
  await registry.refresh('alpha');
  const before = registry.stats('alpha').refreshCount;

  await mkdir(path.join(roots.alpha, 'src', 'custom-index'), { recursive: true });
  await writeFile(
    path.join(roots.alpha, 'src', 'custom-index', 'feature.ts'),
    'export function customIndexSourceProbe(): string { return "watched"; }\n',
  );
  await waitFor(
    () => registry.stats('alpha').refreshCount > before &&
      registry.symbols('alpha').some((symbol) => symbol.name === 'customIndexSourceProbe'),
    'source inside the custom index directory was not watched',
  );
  await registry.waitForIdle();
  const settled = registry.stats('alpha').refreshCount;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(registry.stats('alpha').refreshCount - settled <= 1, 'index writes triggered a refresh loop');

  const indexRoot = path.join(roots.alpha, 'src', 'custom-index');
  await writeFile(path.join(indexRoot, 'index.json'), '{}\n');
  await writeFile(path.join(indexRoot, 'index.json.123.abcdef.tmp'), '{}\n');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(registry.stats('alpha').refreshCount, settled, 'generated index files fed the watcher');
});

test('ignored watch directories are case-insensitive', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  t.after(() => registry.close());
  await registry.register(roots.alpha, { id: 'alpha' });
  const before = registry.stats('alpha').refreshCount;
  await mkdir(path.join(roots.alpha, 'Node_Modules'), { recursive: true });
  await writeFile(path.join(roots.alpha, 'Node_Modules', 'ignored.ts'), 'export const ignoredProbe = 1;\n');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(registry.stats('alpha').refreshCount, before);
});

test('pending refresh work is bounded', async (t) => {
  const roots = await makeProjects(t);
  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  t.after(() => registry.close());
  await registry.register(roots.alpha, { id: 'alpha' });
  const record = registry.projects.get('alpha');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  record.index.refresh = async () => gate;

  const tasks = Array.from({ length: 34 }, () => registry.refresh('alpha'));
  await assert.rejects(tasks[33], /too many pending refreshes/);
  release();
  await Promise.allSettled(tasks);
});

test('pending registration work is bounded', async (t) => {
  const registry = new ProjectRegistry({ watchIntervalMs: 60000 });
  t.after(() => registry.close());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  registry.registerOne = async () => gate;

  const tasks = Array.from({ length: 33 }, () => registry.register('unused', { id: 'bounded' }));
  await assert.rejects(tasks[32], /too many pending registrations/);
  release();
  await Promise.allSettled(tasks);
});

async function rootIdentity(root) {
  const real = await realpath(root);
  const info = await stat(real);
  return {
    real,
    identity: {
      rootKey: process.platform === 'win32' ? real.toLowerCase() : real,
      rootDev: info.dev,
      rootIno: info.ino,
    },
  };
}

test('constructor root pin is a frozen copy of the caller identity', async (t) => {
  const roots = await makeProjects(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vibe-pin-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(
    path.join(outside, 'moved.ts'),
    'export function callerPinProbe(): string { return "outside"; }\n',
  );

  const { identity } = await rootIdentity(roots.alpha);
  const index = new ProjectIndex(roots.alpha, { expectedRoot: identity, persist: false });
  await index.refresh();

  const victim = roots.alpha;
  const backup = path.join(path.dirname(victim), 'alpha-pin-backup');
  await rename(victim, backup);
  try {
    await symlink(outside, victim, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    await rename(backup, victim);
    t.skip('directory symlinks are not available on this platform');
    return;
  }
  t.after(async () => {
    await unlink(victim).catch(() => {});
    await rename(backup, victim).catch(() => {});
  });

  const swapped = await rootIdentity(outside);
  identity.rootKey = swapped.identity.rootKey;
  identity.rootDev = swapped.identity.rootDev;
  identity.rootIno = swapped.identity.rootIno;

  await assert.rejects(index.refresh(), /root changed/);
  assert.ok(!index.symbols().some((symbol) => symbol.name === 'callerPinProbe'));
});

test('pinned load verifies the snapshot before publishing it', async (t) => {
  const roots = await makeProjects(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vibe-load-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideContent = 'export function outsideLoadProbe(): string { return "outside"; }\n';
  await writeFile(path.join(outside, 'moved.ts'), outsideContent);

  const { identity } = await rootIdentity(roots.alpha);
  const index = new ProjectIndex(roots.alpha, { expectedRoot: identity });
  await index.refresh();
  const loaded = await index.load();
  assert.ok(loaded.stats.files > 0);
  const before = index.current;

  const indexPath = path.join(roots.alpha, '.vibe', 'index', 'index.json');
  const raw = JSON.parse(await readFile(indexPath, 'utf8'));
  const target = 'src/util/strings.ts';
  assert.ok(raw.files[target]);
  raw.files[target].hash = createHash('sha256').update(outsideContent).digest('hex');
  await writeFile(indexPath, JSON.stringify(raw));

  await assert.rejects(index.load(), /snapshot does not match/);
  assert.equal(index.current, before);
});

test('a pinned index enforces its stored identity over a caller-supplied pin', async (t) => {
  const roots = await makeProjects(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vibe-pin-override-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(
    path.join(outside, 'outside.ts'),
    'export function callerOverrideProbe(): string { return "outside"; }\n',
  );

  const { identity } = await rootIdentity(roots.alpha);
  const index = new ProjectIndex(roots.alpha, { expectedRoot: identity, persist: false });
  await index.refresh();

  const { identity: outsideIdentity } = await rootIdentity(outside);
  await index.refresh({ expectedRoot: outsideIdentity });

  assert.ok(index.symbols().some((symbol) => symbol.name === 'slugify'));
  assert.ok(!index.symbols().some((symbol) => symbol.name === 'callerOverrideProbe'));
});
