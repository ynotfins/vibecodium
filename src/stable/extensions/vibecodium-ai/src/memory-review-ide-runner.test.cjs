'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vscode = require('vscode');

const STORE_MODULE = path.join(__dirname, '..', '..', '..', 'context-engine', 'memory-store.mjs');

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('vibecodium.vibecodium-ai');
  assert.ok(extension, 'the vibecodium-ai extension is loaded');
  const api = await extension.activate();
  assert.equal(typeof api.setStore, 'function');
  assert.equal(typeof api.openMemory, 'function');
  assert.equal(typeof api.getMemoryView, 'function');
  assert.equal(typeof api.getMemoryPanelHtml, 'function');
  assert.equal(typeof api.handleMemoryMessage, 'function');
  assert.equal(typeof api.disposeMemory, 'function');

  const { MemoryStore } = await import(pathToFileURL(STORE_MODULE).href);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibecodium-memory-ide-'));
  try {
    const store = new MemoryStore({ root, projectId: 'fixture-app' });
    await store.remember({
      scope: 'project',
      key: 'editor.tabs',
      value: 4,
      origin: 'agent',
      sessionId: 'session-1',
    });

    api.setStore(store);
    const opened = await api.openMemory();
    assert.equal(opened.opened, true);

    const view = api.getMemoryView();
    assert.equal(view.scope, 'project');
    assert.equal(view.status, 'pending');
    assert.equal(view.total, 1);
    const item = view.items.find((entry) => entry.key === 'editor.tabs');
    assert.ok(item, 'the pending fact is on the review page');
    assert.equal(item.status, 'pending');
    assert.equal(item.revision, 1);

    const html = api.getMemoryPanelHtml();
    assert.match(html, /Vibe Memory/);
    assert.match(html, /editor\.tabs/);
    assert.match(html, /status-pending/);
    assert.match(html, /data-action="approve"/);
    assert.ok(html.includes('data-id="' + item.id + '"'), 'the rendered actions carry the reviewed id');
    assert.ok(html.includes('data-revision="' + item.revision + '"'), 'the rendered actions carry the reviewed revision');

    const result = await api.handleMemoryMessage({
      type: 'action',
      action: 'approve',
      id: item.id,
      revision: item.revision,
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'approve');
    assert.equal(api.getMemoryView().total, 0);

    const later = new MemoryStore({ root, projectId: 'fixture-app' });
    const recalled = await later.recall({ scope: 'project', key: 'editor.tabs' });
    assert.equal(recalled.total, 1);
    assert.equal(recalled.matches[0].value, 4);
    assert.equal(recalled.matches[0].status, 'approved');
  } finally {
    try {
      api.disposeMemory();
    } catch {}
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  console.log('MEMORY_REVIEW_IDE_OK');
};
