'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

  // A throwaway profile must not load any user-installed GitHub Copilot
  // extension. The stock host may still ship and even activate its own bundled
  // Copilot Chat; that is host wiring, not a profile install. The classifier
  // checks both the full list and the throwaway profile's extensions folder.
  const userExtensionsDir = process.env.VIBECODIUM_USER_EXTENSIONS_DIR;
  const { copilot, userInstalled, active } = classifyCopilotExtensions(vscode.extensions.all, userExtensionsDir);
  assert.deepEqual(
    userInstalled.map((candidate) => candidate.id),
    [],
    `unexpected user-installed Copilot-branded extensions: ${userInstalled.map((candidate) => candidate.id).join(', ')}`,
  );

  // Plant a Copilot extension and confirm the classifier detects it as
  // user-installed. A dead filter or a misclassified profile folder fails the
  // same assertion, instead of passing because the host list happened to be
  // empty.
  const synthetic = {
    id: 'GitHub.copilot-probe',
    extensionPath: path.join(userExtensionsDir || '', 'GitHub.copilot-probe'),
    isActive: false,
  };
  const probe = classifyCopilotExtensions([...vscode.extensions.all, synthetic], userExtensionsDir);
  const hostBundled = copilot.filter((candidate) => !userInstalled.includes(candidate));
  assert.deepEqual(
    {
      userInstalled: userInstalled.map((candidate) => candidate.id).sort(),
      probeDetected: probe.copilot.some((candidate) => candidate.id === synthetic.id),
      probeUserInstalled: probe.userInstalled.map((candidate) => candidate.id).sort(),
    },
    {
      userInstalled: [],
      probeDetected: true,
      probeUserInstalled: [synthetic.id],
    },
    `a throwaway Vibecodium profile must load no user-installed Copilot-branded extension, and the classifier must detect a planted one; host-bundled (informational): ${hostBundled.map((candidate) => `${candidate.id} (active=${active.includes(candidate)})`).join(', ')}`,
  );
  console.log(`AI_SURFACES_COPILOT_IDS=${copilot.map((candidate) => candidate.id).join(',')}`);
  console.log(`AI_SURFACES_USER_COPILOT_IDS=${userInstalled.map((candidate) => candidate.id).join(',')}`);
  console.log(`AI_SURFACES_PROBE_DETECTED=${probe.copilot.map((candidate) => candidate.id).join(',')}`);
  console.log(`AI_SURFACES_EXT_COUNT=${vscode.extensions.all.length}`);
  // The host interleaves stdout chunks, so the acceptance harness reads this
  // artifact instead of scraping console lines.
  const reportPath = process.env.VIBECODIUM_AI_SURFACES_REPORT;
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({
      copilotIds: copilot.map((candidate) => candidate.id).sort(),
      userInstalledIds: userInstalled.map((candidate) => candidate.id).sort(),
      probeIds: probe.copilot.map((candidate) => candidate.id).sort(),
      probeDetected: probe.copilot.some((candidate) => candidate.id === synthetic.id),
      probeUserInstalled: probe.userInstalled.some((candidate) => candidate.id === synthetic.id),
      hostBundledIds: hostBundled.map((candidate) => candidate.id).sort(),
      extensionCount: vscode.extensions.all.length,
    }), 'utf8');
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
