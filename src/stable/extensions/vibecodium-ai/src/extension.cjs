'use strict';

const vscode = require('vscode');
const { createGraphPanelController } = require('./graph-panel.cjs');
const { createMemoryReviewController } = require('./memory-review.cjs');
const { createProviderSetupController } = require('./provider-setup.cjs');
const { createFirstRunController } = require('./first-run.cjs');

function activate(context) {
  let currentGraph = null;
  let currentStore = null;
  let currentProviderSetup = null;
  let currentFirstRun = null;

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
    setupProvider: () => currentProviderSetup,
  });
  const firstRun = createFirstRunController({
    vscode,
    extensionUri: context.extensionUri,
    wizardProvider: () => currentFirstRun,
  });

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

  function applySetup(setup) {
    if (!setup || typeof setup.view !== 'function') {
      vscode.window.showWarningMessage('Vibe Providers: the supplied setup service is not valid.');
      return undefined;
    }
    currentProviderSetup = setup;
    return providers.view();
  }

  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.providers.open', () => providers.open()));
  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.providers.setSetup', applySetup));

  function applyFirstRun(wizard) {
    if (!wizard || typeof wizard.view !== 'function') {
      vscode.window.showWarningMessage('Vibe Setup: the supplied first-run wizard is not valid.');
      return undefined;
    }
    currentFirstRun = wizard;
    return firstRun.view();
  }

  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.firstRun.open', () => firstRun.open()));
  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.firstRun.setWizard', applyFirstRun));

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
    openProviders: () => providers.open(),
    setProviderSetup: applySetup,
    getProviderView: () => providers.view(),
    getProviderPanelHtml: () => providers.html(),
    handleProviderMessage: (message) => providers.handleMessage(message),
    disposeProviders: () => providers.dispose(),
    openFirstRun: () => firstRun.open(),
    setFirstRunWizard: applyFirstRun,
    getFirstRunView: () => firstRun.view(),
    getFirstRunPanelHtml: () => firstRun.html(),
    handleFirstRunMessage: (message) => firstRun.handleMessage(message),
    disposeFirstRun: () => firstRun.dispose(),
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
