import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { applyAISurfaces, vibecodiumChatAgent } from '../../src/stable/security/ai-surfaces.mjs';

const ROOT = path.resolve('.');

test('the branding patch removes the Copilot agent name and setup wording', async () => {
  const patch = await readFile(path.join(ROOT, 'patches/00-brand-remove-branding.patch'), 'utf8');
  const section = patch
    .split(/^(?=diff --git )/m)
    .find((chunk) => chunk.startsWith('diff --git a/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupProviders.ts'));
  assert.ok(section, 'the patch must still change chatSetupProviders.ts');

  const lines = section.split(/\r?\n/);
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---'));

  assert.ok(
    removed.some((line) => line.includes('${defaultChat.provider.default.name} Copilot')),
    'the patch must show the removed Copilot agent-name suffix',
  );
  assert.ok(
    added.some((line) => line.includes('id, defaultChat.provider.default.name /* Do NOT change') && !line.includes(' Copilot`')),
    'the patched agent name must drop the Copilot suffix',
  );
  assert.ok(
    removed.some((line) => line.includes('You need to set up GitHub Copilot and be signed in to use Chat.')),
    'the patch must show the removed Copilot setup wording',
  );
  assert.ok(
    added.some((line) => line.includes('You need to set up a model provider to use Chat.')),
    'the setup banner must no longer ask for GitHub Copilot',
  );
});

test('the Vibecodium chat agent keeps every runtime endpoint off third-party hosts', () => {
  const agent = vibecodiumChatAgent();
  for (const key of [
    'entitlementUrl',
    'entitlementSignupLimitedUrl',
    'tokenEntitlementUrl',
    'mcpRegistryDataUrl',
    'mcpConnectorsUrl',
    'managedSettingsUrl',
  ]) {
    assert.match(agent[key], /^https:\/\/vibecodium\.invalid\//, `${key} must use the reserved .invalid host`);
  }
});

test('trusted auth arrays also lose Copilot entries', () => {
  const product = applyAISurfaces({
    trustedExtensionAuthAccess: ['GitHub.copilot', 'GitHub.copilot-chat', 'vscode.git'],
  });
  assert.deepEqual(product.trustedExtensionAuthAccess, ['vscode.git']);
});
