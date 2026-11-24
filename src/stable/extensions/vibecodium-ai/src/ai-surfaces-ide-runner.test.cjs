'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');
const { classifyCopilotExtensions } = require('./copilot-extensions.cjs');

// 1.135 exposes the new-chat surface as workbench.action.newChatWindow; 1.143
// renamed it to workbench.action.sessions.newChat. Accept either so the test
// verifies the surface on the host that is actually installed.
const REQUIRED_COMMAND_GROUPS = [
  ['workbench.action.chat.open'],
  ['inlineChat.start'],
  ['workbench.action.openAgentsWindow'],
  ['workbench.action.sessions.newChat', 'workbench.action.newChatWindow'],
  ['workbench.action.chat.restoreLastCheckpoint'],
];

async function githubSession() {
  return vscode.authentication.getSession('github', ['user:email'], { createIfNone: false });
}

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('vibecodium.vibecodium-ai');
  assert.ok(extension, 'the vibecodium-ai extension is loaded');
  await extension.activate();
  assert.equal(extension.isActive, true, 'the vibecodium-ai extension is active');

  const chat = vscode.workspace.getConfiguration('chat');
  assert.equal(chat.get('disableAIFeatures'), false, 'chat.disableAIFeatures must be false');
  assert.equal(chat.get('titleBar.signIn.enabled'), false, 'chat.titleBar.signIn.enabled must be false');
  assert.equal(chat.get('welcomePage.signIn.enabled'), false, 'chat.welcomePage.signIn.enabled must be false');

  // A stock VS Code host may bundle a built-in GitHub Copilot extension and may
  // activate it. What matters for this product is that the clean profile has no
  // user-installed Copilot extension. VIBECODIUM_USER_EXTENSIONS_DIR points at
  // the throwaway profile's extensions folder.
  const { copilot, userInstalled, active } = classifyCopilotExtensions(vscode.extensions.all, process.env.VIBECODIUM_USER_EXTENSIONS_DIR);
  assert.deepEqual(userInstalled.map((candidate) => candidate.id), [], `unexpected user-installed GitHub Copilot extensions: ${userInstalled.map((candidate) => candidate.id).join(', ')}`);
  if (copilot.length) {
    console.log(`AI_SURFACES_HOST_COPILOT=${copilot.map((candidate) => candidate.id).join(',')}`);
    console.log(`AI_SURFACES_HOST_COPILOT_ACTIVE=${active.map((candidate) => candidate.id).join(',')}`);
  }

  const commands = await vscode.commands.getCommands(true);
  const available = new Set(commands);
  const matching = commands.filter((command) => /chat|agent|session|inline/i.test(command)).sort();
  const missing = REQUIRED_COMMAND_GROUPS
    .filter((group) => !group.some((command) => available.has(command)))
    .map((group) => group.join(' or '));
  assert.deepEqual(missing, [], `missing commands: ${missing.join('; ')}; chat/agent/session commands: ${matching.join(', ')}`);

  const before = await githubSession();
  await vscode.commands.executeCommand('workbench.action.chat.open');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await githubSession();
  assert.equal(before, undefined, 'the test profile must start without a GitHub session');
  assert.equal(after, undefined, 'opening chat must not create a GitHub session');

  console.log('AI_SURFACES_IDE_OK');
};
