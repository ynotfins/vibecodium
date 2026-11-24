'use strict';

const vscode = require('vscode');
const { createGraphPanelController } = require('./graph-panel.cjs');

function activate(context) {
  let current = null;
  const controller = createGraphPanelController({
    vscode,
    extensionUri: context.extensionUri,
    graphProvider: () => current,
  });
  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.graph.open', () => controller.open()));
  context.subscriptions.push(vscode.commands.registerCommand('vibecodium.graph.setData', (data) => {
    current = data;
    controller.setGraph(data);
  }));
  return {
    open: () => controller.open(),
    setGraph: (data) => {
      current = data;
      controller.setGraph(data);
    },
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
