import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../../src/stable/context-engine/memory-store.mjs';
import {
  MemoryReviewError,
  MemoryReviewModel,
  createMemoryReviewController,
  renderMemoryReviewHtml,
} from '../../src/stable/extensions/vibecodium-ai/src/memory-review.cjs';

async function makeStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibe-memory-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new MemoryStore({ root, projectId: 'fixture-app' }) };
}

function fakeVscode() {
  const panels = [];
  const warnings = [];
  const infos = [];
  const fake = {
    ViewColumn: { Active: 1 },
    Uri: { file: (value) => ({ fsPath: value }) },
    Range: class {
      constructor(...args) { this.args = args; }
    },
    commands: { registerCommand: () => ({ dispose() {} }) },
    window: {
      createWebviewPanel(id, title, column, options) {
        const panel = {
          id,
          title,
          column,
          options,
          revealed: 0,
          webview: {
            html: '',
            handler: null,
            onDidReceiveMessage(handler) {
              this.handler = handler;
              return { dispose() {} };
            },
          },
          onDidDispose(handler) {
            this.disposeHandler = handler;
            return { dispose() {} };
          },
          reveal() { this.revealed += 1; },
          dispose() {
            this.disposed = true;
            if (this.disposeHandler) this.disposeHandler();
          },
        };
        panels.push(panel);
        return panel;
      },
      showWarningMessage(message) { warnings.push(message); },
      showInformationMessage(message) { infos.push(message); },
      async showTextDocument() {},
    },
    workspace: { async openTextDocument() { return {}; } },
  };
  return { fake, panels, warnings, infos };
}

function makeController(store, options = {}) {
  const harness = fakeVscode();
  const controller = createMemoryReviewController({
    vscode: harness.fake,
    storeProvider: () => store,
    ...options,
  });
  return { ...harness, controller };
}

test('the review panel approves a pending fact and a new session recalls it', async (t) => {
  const { root, store } = await makeStore(t);
  await store.remember({
    scope: 'project',
    key: 'build.command',
    value: 'npm test',
    origin: 'agent',
    sessionId: 'session-1',
  });

  const { panels, controller } = makeController(store);
  await controller.open();
  assert.equal(panels.length, 1);
  const html = panels[0].webview.html;
  assert.match(html, /build\.command/);
  assert.match(html, /npm test/);
  assert.match(html, /data-action="approve"/);

  const page = controller.view();
  const item = page.items.find((entry) => entry.key === 'build.command');
  assert.equal(item.status, 'pending');
  assert.equal(item.revision, 1);

  const result = await controller.handleMessage({
    type: 'action',
    action: 'approve',
    id: item.id,
    revision: item.revision,
  });
  assert.equal(result.ok, true);
  assert.equal(controller.view().total, 0);

  const later = new MemoryStore({ root, projectId: 'fixture-app' });
  const recalled = await later.recall({ scope: 'project', key: 'build.command' });
  assert.equal(recalled.total, 1);
  assert.equal(recalled.matches[0].value, 'npm test');
  assert.equal(recalled.matches[0].status, 'approved');
});

test('the review panel pages and filters without losing the total', async (t) => {
  const { store } = await makeStore(t);
  for (const key of ['a', 'b', 'c']) {
    await store.remember({ scope: 'project', key, value: key, origin: 'agent' });
  }

  const { controller } = makeController(store, { limit: 2 });
  await controller.open();
  let view = controller.view();
  assert.equal(view.total, 3);
  assert.equal(view.items.length, 2);
  assert.equal(view.hasMore, true);

  assert.deepEqual(
    await controller.handleMessage({ type: 'page', offset: 10000001 }),
    { handled: false, reason: 'invalid-message' },
  );
  await controller.handleMessage({ type: 'page', offset: 2 });
  view = controller.view();
  assert.equal(view.offset, 2);
  assert.equal(view.items.length, 1);
  assert.equal(view.hasMore, false);

  await controller.handleMessage({ type: 'filter', status: 'approved' });
  view = controller.view();
  assert.equal(view.status, 'approved');
  assert.equal(view.total, 0);
  assert.equal(view.empty, true);

  await controller.handleMessage({ type: 'filter', scope: 'user', status: 'all' });
  view = controller.view();
  assert.equal(view.scope, 'user');
  assert.equal(view.status, 'all');
});

test('a stale review revision is refused and the newer fact stays pending', async (t) => {
  const { store } = await makeStore(t);
  const first = await store.remember({
    scope: 'project',
    key: 'api.base',
    value: 'https://one.example',
    origin: 'agent',
  });

  const { controller, warnings } = makeController(store);
  await controller.open();
  const item = controller.view().items.find((entry) => entry.id === first.id);

  await store.remember({
    scope: 'project',
    key: 'api.base',
    value: 'https://two.example',
    origin: 'agent',
  });

  const result = await controller.handleMessage({
    type: 'action',
    action: 'approve',
    id: item.id,
    revision: item.revision,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'revision-changed');
  assert.equal(warnings.length, 1);

  const current = await store.get('project', first.id);
  assert.equal(current.status, 'pending');
  assert.equal(current.value, 'https://two.example');
  assert.equal(current.revision, 2);
});

test('hostile memory text is escaped before it reaches the webview', async (t) => {
  const { store } = await makeStore(t);
  await store.remember({
    scope: 'project',
    key: '<img src=x onerror=alert(1)>',
    value: '</script><script>alert(1)</script>',
    origin: 'agent',
  });

  const { panels, controller } = makeController(store);
  await controller.open();
  const html = panels[0].webview.html;
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('</script><script>alert(1)</script>'));
  assert.ok(html.includes('&lt;img src=x'));
  assert.ok(html.includes('&lt;/script&gt;'));
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
});

test('the review panel forgets a fact only at the reviewed revision', async (t) => {
  const { store } = await makeStore(t);
  await store.remember({ scope: 'project', key: 'temp', value: 1, origin: 'user' });
  const { controller } = makeController(store);
  await controller.open();
  const item = controller.view().items.find((entry) => entry.key === 'temp');

  const wrong = await controller.handleMessage({
    type: 'action',
    action: 'forget',
    id: item.id,
    revision: 99,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'stale-view');
  assert.notEqual(await store.get('project', item.id), null);

  const result = await controller.handleMessage({
    type: 'action',
    action: 'forget',
    id: item.id,
    revision: item.revision,
  });
  assert.equal(result.ok, true);
  assert.equal(await store.get(item.scope, item.id), null);
});

test('the review panel refuses an unknown action and an unconnected store', async (t) => {
  const { store } = await makeStore(t);
  await store.remember({ scope: 'project', key: 'k', value: 'v', origin: 'agent' });
  const { controller } = makeController(store);
  await controller.open();
  const item = controller.view().items[0];
  assert.deepEqual(
    await controller.handleMessage({ type: 'action', action: 'delete', id: item.id, revision: 1 }),
    { handled: false, reason: 'invalid-message' },
  );
  const missing = await controller.handleMessage({ type: 'action', action: 'approve', id: 'missing', revision: 1 });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'not-found');

  const unconnected = makeController(null);
  await unconnected.controller.open();
  assert.equal(unconnected.panels.length, 0);
  assert.equal(unconnected.infos.length, 1);
  assert.equal(unconnected.controller.view(), null);
});

test('malformed review pages fail closed', async (t) => {
  const { store } = await makeStore(t);
  await store.remember({ scope: 'project', key: 'safe', value: 'ok', origin: 'agent' });
  const page = await store.review({ scope: 'project' });
  assert.doesNotThrow(() => new MemoryReviewModel(page));

  const cases = [
    { ...page, items: [page.items[0], page.items[0]] },
    { ...page, items: [{ ...page.items[0], scope: 'user' }] },
    { ...page, items: [{ ...page.items[0], sourceTrust: 'trusted' }] },
    { ...page, items: [{ ...page.items[0], revision: 0 }] },
    { ...page, items: [{ ...page.items[0], status: 'maybe' }] },
    { ...page, items: [{ ...page.items[0], id: '<script>' }] },
    { ...page, items: [{ ...page.items[0], key: '\u202Eevil' }] },
    { ...page, items: [{ ...page.items[0], createdAt: 'x'.repeat(100) }] },
    {
      ...page,
      items: [{
        ...page.items[0],
        value: Object.fromEntries(Array.from({ length: 9 }, (_, index) => ['k' + index, 'x'.repeat(8000)])),
      }],
    },
    { ...page, total: -1 },
    { ...page, limit: 501 },
    { ...page, hasMore: 'yes' },
    { ...page, status: 'everything' },
  ];
  for (const candidate of cases) {
    assert.throws(() => new MemoryReviewModel(candidate), MemoryReviewError);
  }
});

test('the renderer rejects an unsafe nonce and oversized views', () => {
  const view = {
    version: 1,
    scope: 'project',
    status: 'pending',
    total: 0,
    offset: 0,
    limit: 100,
    hasMore: false,
    counts: { pending: 0, approved: 0, rejected: 0 },
    items: [],
    notice: '',
  };
  assert.doesNotThrow(() => renderMemoryReviewHtml(view));
  assert.throws(() => renderMemoryReviewHtml(view, { nonce: 'bad nonce' }), MemoryReviewError);
  assert.throws(
    () => renderMemoryReviewHtml({ ...view, items: new Array(501).fill(view.items[0]) }),
    MemoryReviewError,
  );
});
test('a disconnected store is reported instead of a stale successful refresh', async (t) => {
  const { store } = await makeStore(t);
  await store.remember({ scope: 'project', key: 'k', value: 'v', origin: 'agent' });
  const harness = fakeVscode();
  let current = store;
  const controller = createMemoryReviewController({
    vscode: harness.fake,
    storeProvider: () => current,
  });
  await controller.open();
  current = null;

  const refreshed = await controller.handleMessage({ type: 'refresh' });
  assert.deepEqual(refreshed, { handled: true, ok: false, code: 'no-store' });
  assert.equal(harness.warnings.length, 1);

  const reopened = await controller.open();
  assert.equal(reopened.refreshed, false);
  assert.equal(reopened.reason, 'no-store');
  assert.equal(controller.view(), null);
});
