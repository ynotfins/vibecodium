'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createGraphPanelController } = require('./graph-panel.cjs');
const { createMemoryReviewController } = require('./memory-review.cjs');
const { createProviderSetupController } = require('./provider-setup.cjs');

const PROVIDER_CATALOG_PATH = path.join(__dirname, '..', '..', '..', 'gateway', 'provider-presets.mjs');

function listEnvironmentNames() {
  return Object.keys(process.env).filter((name) =>
    /^[A-Z][A-Z0-9_]{0,127}$/.test(name) &&
    typeof process.env[name] === 'string' &&
    process.env[name].length > 0);
}

function loadProviderCatalog(providers) {
  return import(pathToFileURL(PROVIDER_CATALOG_PATH).href)
    .then((module) => providers.setCatalog(module.listProviderPresets()))
    .then(() => true)
    .catch(() => false);
}

function activate(context) {
  let currentGraph = null;
  let currentStore = null;

  const graph = createGraphPanelController({
    vscode,
    extensionUri: context.extensionUri,
    graphProvider: () => currentGraph,
  });
  const memory = createMemoryReviewController({
    vscode,
    extensionUri: context.extensionUri,
    storeProvider: () => currentStore,
  });
  const providers = createProviderSetupController({
    vscode,
    extensionUri: context.extensionUri,
    secretStorage: context.secrets,
    environmentNames: listEnvironmentNames(),
    document: context.globalState?.get?.('vibecodium.providers'),
    saveDocument: context.globalState?.update
      ? (document) => context.globalState.update('vibecodium.providers', document)
      : undefined,
  });
  const catalogReady = context.secrets ? loadProviderCatalog(providers) : Promise.resolve(false);

  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.graph.open', () => graph.open()));
  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.graph.setData', (data) => {
    currentGraph = data;
    graph.setGraph(data);
  }));
  function applyStore(store) {
    if (!store || typeof store !== 'object') {
      vscode.window.showWarningMessage('Vibe Memory: the supplied store is not valid.');
      return undefined;
    }
    currentStore = store;
    return memory.reload();
  }

  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.memory.open', () => memory.open()));
  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.memory.setStore', applyStore));
  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.providers.open', async () => {
    await catalogReady;
    return providers.open();
  }));

  return {
    open: () => graph.open(),
    setGraph: (data) => {
      currentGraph = data;
      graph.setGraph(data);
    },
    getView: () => graph.view(),
    getPanelHtml: () => graph.html(),
    activateNode: (nodeId) => graph.activate(nodeId),
    dispose: () => graph.dispose(),
    openMemory: () => memory.open(),
    setStore: applyStore,
    getMemoryView: () => memory.view(),
    getMemoryPanelHtml: () => memory.html(),
    handleMemoryMessage: (message) => memory.handleMessage(message),
    disposeMemory: () => memory.dispose(),
    openProviders: async () => {
      await catalogReady;
      return providers.open();
    },
    getProviderSetupView: () => providers.view(),
    getProviderSetupHtml: () => providers.html(),
    handleProviderSetupMessage: (message) => providers.handleMessage(message),
    disposeProviders: () => providers.dispose(),
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
