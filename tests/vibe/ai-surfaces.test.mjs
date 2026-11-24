import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  VIBECODIUM_AI_EXTENSION_ID,
  applyAISurfaces,
  findCopilotReferences,
} from '../../src/stable/security/ai-surfaces.mjs';
import { applyToFile } from '../../vibe/tools/apply-ai-surfaces.mjs';

const ROOT = path.resolve('.');

function upstreamProduct() {
  return {
    nameShort: 'VSCodium',
    trustedExtensionAuthAccess: {
      github: ['GitHub.copilot-chat'],
      'github-enterprise': ['GitHub.copilot-chat'],
      microsoft: ['vscode.github-authentication'],
    },
    builtInExtensionsEnabledWithAutoUpdates: ['GitHub.copilot-chat', 'vscode.git'],
    extensionsEnabledWithApiProposalVersion: ['GitHub.copilot-chat', 'vscode.git'],
    extensionEnabledApiProposals: {
      'GitHub.copilot-chat': ['chatParticipant'],
      'vscode.git': ['scm'],
    },
    defaultChatAgent: {
      extensionId: 'GitHub.copilot',
      chatExtensionId: 'GitHub.copilot-chat',
      providerExtensionId: 'vscode.github-authentication',
      provider: { default: { id: 'github', name: 'GitHub' } },
      entitlementUrl: 'https://api.github.com/copilot_internal/user',
      documentationUrl: 'https://aka.ms/github-copilot-overview',
    },
  };
}

test('the product transform replaces the Copilot chat agent and removes Copilot wiring', () => {
  const input = upstreamProduct();
  const before = structuredClone(input);
  const product = applyAISurfaces(input);

  assert.deepEqual(input, before, 'applyAISurfaces must not mutate its input');
  assert.equal(product.defaultChatAgent.extensionId, VIBECODIUM_AI_EXTENSION_ID);
  assert.equal(product.defaultChatAgent.chatExtensionId, VIBECODIUM_AI_EXTENSION_ID);
  assert.equal(product.defaultChatAgent.providerExtensionId, VIBECODIUM_AI_EXTENSION_ID);
  assert.equal(product.defaultChatAgent.provider.default.id, 'vibecodium');
  assert.equal(product.defaultChatAgent.provider.default.name, 'Vibecodium');
  assert.deepEqual(findCopilotReferences(product), []);
  assert.deepEqual(product.trustedExtensionAuthAccess, { github: [], 'github-enterprise': [], microsoft: ['vscode.github-authentication'] });
  assert.deepEqual(product.builtInExtensionsEnabledWithAutoUpdates, ['vscode.git']);
  assert.deepEqual(product.extensionsEnabledWithApiProposalVersion, ['vscode.git']);
  assert.deepEqual(product.extensionEnabledApiProposals, { 'vscode.git': ['scm'] });
});

test('the product transform is idempotent', () => {
  const once = applyAISurfaces(upstreamProduct());
  const twice = applyAISurfaces(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(findCopilotReferences(twice), []);
});

test('findCopilotReferences reports Copilot keys, values and URLs', () => {
  const hits = findCopilotReferences({
    builtInExtensionsEnabledWithAutoUpdates: ['GitHub.copilot-chat'],
    extensionEnabledApiProposals: { 'GitHub.copilot': [] },
    defaultChatAgent: { entitlementUrl: 'https://api.github.com/copilot_internal/user' },
  });
  assert.ok(hits.some((hit) => hit.includes('GitHub.copilot-chat')));
  assert.ok(hits.some((hit) => hit.includes('GitHub.copilot (key)')));
  assert.ok(hits.some((hit) => hit.includes('api.github.com/copilot_internal/user')));
});

test('applyAISurfaces rejects values that are not plain objects', () => {
  assert.throws(() => applyAISurfaces([]), TypeError);
  assert.throws(() => applyAISurfaces(null), TypeError);
  assert.throws(() => applyAISurfaces('product.json'), TypeError);
});

test('the vibecodium-ai manifest contributes the AI-surface defaults', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'src/stable/extensions/vibecodium-ai/package.json'), 'utf8'));
  assert.deepEqual(manifest.contributes.configurationDefaults, {
    'chat.disableAIFeatures': false,
    'chat.titleBar.signIn.enabled': false,
    'chat.welcomePage.signIn.enabled': false,
  });
  const welcome = manifest.contributes.configuration.properties['chat.welcomePage.signIn.enabled'];
  assert.equal(welcome.default, false, 'the extension registers the welcome-page default for hosts that predate the setting');
});

test('prepare_vscode.sh applies the transform after merging product.json', async () => {
  const prepare = await readFile(path.join(ROOT, 'prepare_vscode.sh'), 'utf8');
  const merge = prepare.indexOf('jsonTmp=$( jq -s');
  const apply = prepare.indexOf('node ../vibe/tools/apply-ai-surfaces.mjs --product product.json');
  const patches = prepare.indexOf('for file in ../patches/*.patch');
  assert.ok(merge >= 0, 'prepare_vscode.sh must merge the Vibecodium product.json');
  assert.ok(apply > merge, 'the AI-surface transform must run after the product merge');
  assert.ok(patches > apply, 'the AI-surface transform must run before the source patches');
});

test('apply-ai-surfaces updates a file once and --check then reports it unchanged', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibecodium-ai-surfaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'product.json');
  await writeFile(file, `${JSON.stringify(upstreamProduct(), null, 2)}\n`);

  const first = applyToFile(file);
  assert.equal(first.changed, true);
  assert.deepEqual(first.copilotReferences, []);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.defaultChatAgent.extensionId, VIBECODIUM_AI_EXTENSION_ID);

  const second = applyToFile(file, { check: true });
  assert.equal(second.changed, false);
  assert.deepEqual(second.copilotReferences, []);
});
