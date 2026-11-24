'use strict';

const vscode = require('vscode');
const { createGraphPanelController } = require('./graph-panel.cjs');
const { createMemoryReviewController } = require('./memory-review.cjs');

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
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
