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

// A Copilot-free product must not mention Copilot anywhere. The Copilot chat
// extensions use the GitHub publisher, but related extensions are branded
// differently (for example the Azure GitHub Copilot tools and the Copilot
// vision preview), so match the brand token instead of only the publisher id.
const COPILOT_BRAND = /copilot/i;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function vibecodiumChatAgent() {
  return structuredClone(VIBECODIUM_CHAT_AGENT);
}

function extensionIdOf(entry) {
  if (typeof entry === 'string') return entry;
  if (!isPlainObject(entry)) return undefined;
  for (const key of ['name', 'extensionId', 'id']) {
    if (typeof entry[key] === 'string') return entry[key];
  }
  return undefined;
}

// Removes every Copilot-branded entry from a product section, in any shape:
// object keys, id strings, and objects that carry an id in `name`, `id` or
// `extensionId`. Everything else is copied, and empty containers are kept so
// the section shape stays stable.
const MAX_DEPTH = 64;

// An entry is kept unless it is itself Copilot-branded: a string id or an
// object whose `name`, `id` or `extensionId` matches. This covers both array
// containers and object containers keyed by index.
function keepCopilotFree(entry) {
  if (typeof entry === 'string') return !COPILOT_BRAND.test(entry);
  const id = extensionIdOf(entry);
  return !(id !== undefined && COPILOT_BRAND.test(id));
}

function withoutCopilotBrand(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new RangeError(`product.json nesting exceeds ${MAX_DEPTH} levels`);
  if (Array.isArray(value)) {
    return value
      .filter(keepCopilotFree)
      .map((entry) => (isPlainObject(entry) ? withoutCopilotBrand(entry, depth + 1) : entry));
  }
  if (isPlainObject(value)) {
    const entries = [];
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (COPILOT_BRAND.test(key)) continue;
      if (!keepCopilotFree(entry)) continue;
      entries.push([key, withoutCopilotBrand(entry, depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

// The product sections this transform owns. Copilot must not appear in any of
// them: they decide which chat agent loads, which extensions are built in,
// recommended or allowed in a session, which extensions are trusted for auth,
// and which API proposals are granted. The rest of product.json carries only two inert
// Copilot stores (the gallery telemetry SKUs and the workspace-trust copy) that
// neither load nor authorize Copilot, so this transform leaves
// them alone. See docs/vibe/design/m1-ai-surfaces.md.
export const COPILOT_OWNED_SECTIONS = Object.freeze([
  'defaultChatAgent',
  'trustedExtensionAuthAccess',
  'builtInExtensions',
  'builtInExtensionsEnabledWithAutoUpdates',
  'extensionsEnabledWithApiProposalVersion',
  'extensionRecommendations',
  'sessionsWindowAllowedExtensions',
  'extensionEnabledApiProposals',
  'extensionProperties',
  'extensionsForceVersionByQuality',
  'languageExtensionTips',
  'exeBasedExtensionTips',
  'remoteDefaultExtensionsIfInstalledLocally',
  'chatSessionRecommendations',
  'inheritAuthAccountPreference',
  'extensionConfigurationPolicy',
]);

// Returns a new product object. The input is never mutated, and applying the
// transform to its own output produces an equivalent object.
export function applyAISurfaces(product) {
  if (!isPlainObject(product)) throw new TypeError('product must be a plain object');
  const next = structuredClone(product);
  for (const key of Object.keys(next)) if (COPILOT_BRAND.test(key)) delete next[key];
  next.defaultChatAgent = vibecodiumChatAgent();
  for (const section of COPILOT_OWNED_SECTIONS) {
    if (section === 'defaultChatAgent') continue;
    if (next[section] !== undefined) next[section] = withoutCopilotBrand(next[section]);
  }
  return next;
}

// Lists every remaining Copilot reference in the owned sections, for tests and
// --check. Scoped on purpose: flagging inert strings elsewhere would make the
// build fail for metadata that changes no behaviour.
export function findCopilotReferences(product) {
  const hits = [];
  const visit = (node, at) => {
    if (typeof node === 'string') {
      if (COPILOT_BRAND.test(node)) hits.push(`${at} = ${node}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${at}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, entry] of Object.entries(node)) {
      if (COPILOT_BRAND.test(key)) hits.push(`${at}.${key} (key)`);
      visit(entry, `${at}.${key}`);
    }
  };
  if (!isPlainObject(product)) return hits;
  for (const key of Object.keys(product)) if (COPILOT_BRAND.test(key)) hits.push(`${key} (key)`);
  for (const section of COPILOT_OWNED_SECTIONS) {
    if (product[section] !== undefined) visit(product[section], section);
  }
  return hits;
}
