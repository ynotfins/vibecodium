// Vibecodium product transform: enable the native AI surfaces without GitHub Copilot.
// Dependency-free, pure and idempotent. See docs/vibe/design/m1-ai-surfaces.md.

export const VIBECODIUM_AI_EXTENSION_ID = 'vibecodium.vibecodium-ai';

export const AI_SURFACE_DEFAULTS = Object.freeze({
  'chat.disableAIFeatures': false,
  'chat.titleBar.signIn.enabled': false,
  'chat.welcomePage.signIn.enabled': false,
});

const HOME = 'https://github.com/ynotfins/vibecodium';
const RUNTIME = 'https://vibecodium.invalid';

// The product descriptor the workbench reads for the built-in chat agent. The
// extension id points at our own built-in extension so chat setup never looks
// for, installs or signs in to GitHub Copilot. Runtime endpoints use the
// reserved .invalid TLD: they can never resolve, so a stray request fails fast
// instead of reaching a third party.
export const VIBECODIUM_CHAT_AGENT = Object.freeze({
  extensionId: VIBECODIUM_AI_EXTENSION_ID,
  chatExtensionId: VIBECODIUM_AI_EXTENSION_ID,
  chatExtensionOutputId: `${VIBECODIUM_AI_EXTENSION_ID}.Vibecodium AI.log`,
  chatExtensionOutputExtensionStateCommand: 'vibecodium.ai.extensionState',
  documentationUrl: `${HOME}#readme`,
  termsStatementUrl: `${HOME}/blob/vibe/main/LICENSE`,
  privacyStatementUrl: `${HOME}/blob/vibe/main/docs/vibe/user/README.md`,
  skusDocumentationUrl: `${HOME}#readme`,
  optimizeUsageDocumentationUrl: `${HOME}#readme`,
  publicCodeMatchesUrl: `${HOME}#readme`,
  managePlanUrl: `${HOME}#readme`,
  upgradePlanUrl: `${HOME}#readme`,
  signUpUrl: `${HOME}#readme`,
  provider: Object.freeze({
    default: Object.freeze({ id: 'vibecodium', name: 'Vibecodium' }),
    enterprise: Object.freeze({ id: 'vibecodium-enterprise', name: 'Vibecodium Enterprise' }),
    google: Object.freeze({ id: 'google', name: 'Google' }),
    apple: Object.freeze({ id: 'apple', name: 'Apple' }),
    microsoft: Object.freeze({ id: 'microsoft', name: 'Microsoft' }),
  }),
  providerExtensionId: VIBECODIUM_AI_EXTENSION_ID,
  providerUriSetting: 'vibecodium.providerUri',
  providerScopes: Object.freeze([]),
  entitlementUrl: `${RUNTIME}/entitlement`,
  entitlementSignupLimitedUrl: `${RUNTIME}/entitlement/subscribe`,
  tokenEntitlementUrl: `${RUNTIME}/entitlement/token`,
  mcpRegistryDataUrl: `${RUNTIME}/mcp/registry`,
  mcpConnectorsUrl: `${RUNTIME}/mcp/connectors`,
  managedSettingsUrl: `${RUNTIME}/managed-settings`,
  chatQuotaExceededContext: 'vibecodium.chat.quotaExceeded',
  completionsQuotaExceededContext: 'vibecodium.completions.quotaExceeded',
  walkthroughCommand: 'vibecodium.ai.openWalkthrough',
  completionsMenuCommand: 'vibecodium.ai.toggleStatusMenu',
  chatRefreshTokenCommand: 'vibecodium.ai.refreshToken',
  generateCommitMessageCommand: 'vibecodium.ai.generateCommitMessage',
  resolveMergeConflictsCommand: 'vibecodium.ai.resolveMergeConflicts',
  completionsAdvancedSetting: 'vibecodium.ai.completions.advanced',
  completionsEnablementSetting: 'vibecodium.ai.completions.enabled',
  nextEditSuggestionsSetting: 'vibecodium.ai.nextEditSuggestions.enabled',
});

const GITHUB_COPILOT_ID = /^GitHub\.copilot(?:-|$)/i;
const GITHUB_COPILOT_KEY = /^GitHub\.copilot(?:-|$)/i;
const GITHUB_COPILOT_REFERENCE = /(?:github\.copilot|github-copilot|api\.github\.com\/copilot|copilot_internal|copilot\/mcp_registry|copilot-connectors|GitHub Copilot)/i;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function vibecodiumChatAgent() {
  return structuredClone(VIBECODIUM_CHAT_AGENT);
}

function withoutCopilot(entries) {
  return entries.filter((entry) => !(typeof entry === 'string' && GITHUB_COPILOT_ID.test(entry)));
}

function withoutCopilotAuth(value) {
  if (Array.isArray(value)) return withoutCopilot(value);
  if (!isPlainObject(value)) return value;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && GITHUB_COPILOT_ID.test(entry)) continue;
    next[key] = Array.isArray(entry) ? withoutCopilot(entry) : entry;
  }
  return next;
}

// Returns a new product object. The input is never mutated, and applying the
// transform to its own output produces an equivalent object.
export function applyAISurfaces(product) {
  if (!isPlainObject(product)) throw new TypeError('product must be a plain object');
  const next = structuredClone(product);
  next.defaultChatAgent = vibecodiumChatAgent();
  if (next.trustedExtensionAuthAccess !== undefined) {
    next.trustedExtensionAuthAccess = withoutCopilotAuth(next.trustedExtensionAuthAccess);
  }
  for (const key of ['builtInExtensionsEnabledWithAutoUpdates', 'extensionsEnabledWithApiProposalVersion']) {
    if (Array.isArray(next[key])) next[key] = withoutCopilot(next[key]);
  }
  if (isPlainObject(next.extensionEnabledApiProposals)) {
    for (const key of Object.keys(next.extensionEnabledApiProposals)) {
      if (GITHUB_COPILOT_KEY.test(key)) delete next.extensionEnabledApiProposals[key];
    }
  }
  return next;
}

// Lists every remaining Copilot reference by path, for tests and --check.
export function findCopilotReferences(value, root = 'product') {
  const hits = [];
  const visit = (node, at) => {
    if (typeof node === 'string') {
      if (GITHUB_COPILOT_REFERENCE.test(node)) hits.push(`${at} = ${node}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${at}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, entry] of Object.entries(node)) {
      if (GITHUB_COPILOT_KEY.test(key)) hits.push(`${at}.${key} (key)`);
      visit(entry, `${at}.${key}`);
    }
  };
  visit(value, root);
  return hits;
}
