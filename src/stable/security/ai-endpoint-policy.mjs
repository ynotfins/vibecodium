// M1 AI endpoint policy core.
//
// Deny-by-default policy for outbound requests made by Vibecodium's AI services. The inventory is
// derived from a read-only audit of the pinned upstream source (microsoft/vscode 1.143.1) across
// `src/vs/platform/agentHost`, `src/vs/sessions`, `src/vs/platform/mcp`,
// `src/vs/platform/telemetry` and `src/vs/workbench/contrib/chat`. It contains no source text,
// credentials or query strings, and nothing here performs network I/O: callers decide how to apply
// a decision. Local model servers stay allowed by default; every remote family is denied until a
// caller explicitly opts in. Documentation/help hosts are listed for the audit but are not fetch
// targets.
//
// Wiring into the Bifrost gateway and the agent host is M2/M6 work; this module is the shared
// decision core for those callers and for tests.

export const AI_ENDPOINT_POLICY_VERSION = '1.1.2';
export const MAX_ENDPOINT_URL_CHARS = 1024;
export const MAX_OPTION_STRING_CHARS = 253;
export const MAX_REDACTED_PATH_CHARS = 512;

// Reject C0/C1 controls, all Unicode format characters (zero-width, bidi controls, BOM, Arabic
// letter mark and friends), and the line/paragraph separators. A URL never needs any of them.
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const ENCODED_SEPARATOR_OR_DOT = /%(?:2f|5c|2e)/i;

function freezeEntry(entry) {
  return Object.freeze({
    ...entry,
    paths: entry.paths ? Object.freeze([...entry.paths]) : undefined,
    upstreamFiles: Object.freeze([...entry.upstreamFiles]),
  });
}

// Every remote family that the audited AI services can reach. `disposition` is the audit verdict
// (`block` = Vibecodium must not send traffic; `user-authorized` = the user's own account/consent
// decides; `allow` = fetch is acceptable). `allowedByDefault` is what this policy enforces.
export const AI_ENDPOINT_INVENTORY = Object.freeze([
  freezeEntry({
    id: 'copilot-capi-default',
    host: 'api.githubcopilot.com',
    category: 'copilot-capi',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/v1/messages', '/v1/chat/completions', '/v1/responses', '/responses', '/chat/completions', '/models', '/copilot_internal/user'],
    purpose: 'GitHub Copilot CAPI default origin (chat, models, responses and token discovery).',
    upstreamFiles: [
      'src/vs/platform/agentHost/node/copilot/copilotAgent.ts',
      'src/vs/platform/agentHost/node/shared/copilotApiService.ts',
    ],
  }),
  freezeEntry({
    id: 'copilot-capi-individual',
    host: 'api.individual.githubcopilot.com',
    category: 'copilot-capi',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/v1/messages', '/v1/chat/completions', '/v1/responses', '/models', '/copilot_internal/user'],
    purpose: 'CAPI consumer origin used by the local-model bridge router.',
    upstreamFiles: ['src/vs/platform/agentHost/node/copilot/localModelBridge/shim/requestRouter.ts'],
  }),
  freezeEntry({
    id: 'copilot-capi-business',
    host: 'api.business.githubcopilot.com',
    category: 'copilot-capi',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/v1/messages', '/v1/chat/completions', '/v1/responses', '/models', '/copilot_internal/user'],
    purpose: 'CAPI business origin used by the local-model bridge router.',
    upstreamFiles: ['src/vs/platform/agentHost/node/copilot/localModelBridge/shim/requestRouter.ts'],
  }),
  freezeEntry({
    id: 'copilot-capi-enterprise',
    host: 'api.enterprise.githubcopilot.com',
    category: 'copilot-capi',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/v1/messages', '/v1/chat/completions', '/v1/responses', '/models', '/copilot_internal/user'],
    purpose: 'CAPI enterprise origin used by the local-model bridge router and token discovery.',
    upstreamFiles: [
      'src/vs/platform/agentHost/node/copilot/localModelBridge/shim/requestRouter.ts',
      'src/vs/platform/agentHost/node/shared/copilotApiService.ts',
    ],
  }),
  freezeEntry({
    id: 'copilot-telemetry',
    host: 'copilot-telemetry.githubusercontent.com',
    category: 'copilot-telemetry',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/telemetry'],
    purpose: 'Copilot restricted telemetry fallback endpoint.',
    upstreamFiles: ['src/vs/platform/agentHost/node/agentHostRestrictedTelemetry.ts'],
  }),
  freezeEntry({
    id: 'microsoft-1ds-telemetry',
    host: 'mobile.events.data.microsoft.com',
    category: 'microsoft-telemetry',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/OneCollector', '/ping'],
    purpose: 'Microsoft 1DS telemetry collector and health ping.',
    upstreamFiles: ['src/vs/platform/telemetry/common/1dsAppender.ts'],
  }),
  freezeEntry({
    id: 'microsoft-model-catalog',
    host: 'api.catalog.azureml.ms',
    category: 'microsoft-model-catalog',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/asset-gallery', '/modelregistry'],
    purpose: 'Azure ML model catalog used by the Copilot local-model bridge shim.',
    upstreamFiles: ['src/vs/platform/agentHost/node/copilot/localModelBridge/shim/constants.ts'],
  }),
  freezeEntry({
    id: 'vscode-update-feed',
    host: 'update.code.visualstudio.com',
    category: 'vscode-update',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/api/update'],
    purpose: 'Upstream VS Code update feed; Vibecodium ships its own feed (G2).',
    upstreamFiles: ['src/vs/platform/agentHost/node/sshRemoteAgentHostHelpers.ts'],
  }),
  freezeEntry({
    id: 'github-rest-api',
    host: 'api.github.com',
    category: 'github-api',
    disposition: 'user-authorized',
    allowedByDefault: false,
    paths: ['/repos', '/graphql'],
    purpose: 'GitHub REST/GraphQL used for the user\'s own repositories and changesets.',
    upstreamFiles: [
      'src/vs/platform/agentHost/common/agent.ts',
      'src/vs/platform/agentHost/node/agentHostGitHubEndpointService.ts',
    ],
  }),
  freezeEntry({
    id: 'github-web',
    host: 'github.com',
    category: 'github-api',
    disposition: 'user-authorized',
    allowedByDefault: false,
    purpose: 'GitHub web host referenced by agent changeset and account UI.',
    upstreamFiles: [
      'src/vs/platform/agentHost/node/copilot/copilotGitProject.ts',
      'src/vs/sessions/browser/accountTitleBarState.ts',
    ],
  }),
  freezeEntry({
    id: 'github-raw-content',
    host: 'raw.githubusercontent.com',
    category: 'github-content',
    disposition: 'block',
    allowedByDefault: false,
    purpose: 'Raw repository content used by the agent plugin/marketplace views.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/common/plugins/pluginMarketplaceService.ts'],
  }),
  freezeEntry({
    id: 'github-gist-content',
    host: 'gist.githubusercontent.com',
    category: 'github-content',
    disposition: 'block',
    allowedByDefault: false,
    purpose: 'Gist content used by chat prompt/plugin surfaces.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/browser/promptSyntax/promptUrlHandler.ts'],
  }),
  freezeEntry({
    id: 'github-avatars',
    host: 'avatars.githubusercontent.com',
    category: 'github-content',
    disposition: 'block',
    allowedByDefault: false,
    purpose: 'Avatar images used by the MCP registry and account UI.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/browser/aiCustomization/githubMcpRegistryIcons.ts'],
  }),
  freezeEntry({
    id: 'chatgpt-backend',
    host: 'chatgpt.com',
    category: 'external-provider',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/backend-api'],
    purpose: 'ChatGPT/Codex account and profile backend used by the Codex agent provider.',
    upstreamFiles: ['src/vs/platform/agentHost/node/codex/codexProfileImage.ts'],
  }),
  freezeEntry({
    id: 'openai-api',
    host: 'api.openai.com',
    category: 'external-provider',
    disposition: 'block',
    allowedByDefault: false,
    paths: ['/v1', '/auth'],
    purpose: 'OpenAI API used by the Codex agent provider.',
    upstreamFiles: ['src/vs/platform/agentHost/node/codex/codexProfileImage.ts'],
  }),
  freezeEntry({
    id: 'openai-web',
    host: 'openai.com',
    category: 'external-provider',
    disposition: 'block',
    allowedByDefault: false,
    purpose: 'OpenAI web host used for authenticated Codex profile images.',
    upstreamFiles: ['src/vs/platform/agentHost/node/codex/codexProfileImage.ts'],
  }),
  freezeEntry({
    id: 'microsoft-aka',
    host: 'aka.ms',
    category: 'microsoft-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'Microsoft help/documentation short links opened by the browser.',
    upstreamFiles: ['src/vs/platform/telemetry/common/telemetryService.ts'],
  }),
  freezeEntry({
    id: 'vs-code-docs',
    host: 'code.visualstudio.com',
    category: 'microsoft-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'VS Code documentation links opened by the browser.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/browser/tools/languageModelToolsService.ts'],
  }),
  freezeEntry({
    id: 'microsoft-docs',
    host: 'docs.microsoft.com',
    category: 'microsoft-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'Microsoft documentation links opened by the browser.',
    upstreamFiles: ['src/vs/platform/telemetry/common/telemetryUtils.ts'],
  }),
  freezeEntry({
    id: 'vs-marketplace',
    host: 'marketplace.visualstudio.com',
    category: 'microsoft-marketplace',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'Marketplace links in chat help text; the product uses Open VSX.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/browser/tools/languageModelToolsService.ts'],
  }),
  freezeEntry({
    id: 'github-docs',
    host: 'docs.github.com',
    category: 'github-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'GitHub documentation links opened by the browser.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/common/languageModels.ts'],
  }),
  freezeEntry({
    id: 'github-support',
    host: 'support.github.com',
    category: 'github-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'GitHub support link in chat error text.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/common/chatErrorMessages.ts'],
  }),
  freezeEntry({
    id: 'open-plugins-docs',
    host: 'open-plugins.com',
    category: 'external-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'Agent plugin documentation links opened by the browser.',
    upstreamFiles: ['src/vs/platform/agentHost/common/state/protocol/channels-session/state.ts'],
  }),
  freezeEntry({
    id: 'anthropic-docs',
    host: 'docs.anthropic.com',
    category: 'external-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'Anthropic documentation link in prompt/provider help.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/common/promptSyntax/hookTypes.ts'],
  }),
  freezeEntry({
    id: 'claude-code-docs',
    host: 'code.claude.com',
    category: 'external-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'Claude Code documentation link in provider help.',
    upstreamFiles: ['src/vs/platform/agentHost/node/claude/claudeAgent.ts'],
  }),
  freezeEntry({
    id: 'claude-platform-docs',
    host: 'platform.claude.com',
    category: 'external-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'Claude platform documentation link in provider help.',
    upstreamFiles: ['src/vs/platform/agentHost/node/copilot/prompts/anthropicPrompt.ts'],
  }),
  freezeEntry({
    id: 'openai-developer-docs',
    host: 'developers.openai.com',
    category: 'external-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'OpenAI developer documentation link in provider help.',
    upstreamFiles: ['src/vs/sessions/contrib/providers/agentHost/browser/agentHostCodexApprovalsPicker.ts'],
  }),
  freezeEntry({
    id: 'openai-platform-docs',
    host: 'platform.openai.com',
    category: 'external-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'OpenAI platform documentation link in provider help.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/browser/chatImageUtils.ts'],
  }),
  freezeEntry({
    id: 'chatgpt-learn-docs',
    host: 'learn.chatgpt.com',
    category: 'external-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'ChatGPT learning/documentation link in provider help.',
    upstreamFiles: ['src/vs/platform/agentHost/node/codex/codexAgent.ts'],
  }),
  freezeEntry({
    id: 'mcp-project-docs',
    host: 'modelcontextprotocol.io',
    category: 'external-documentation',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'Model Context Protocol project documentation link.',
    upstreamFiles: ['src/vs/platform/agentHost/common/state/protocol/channels-session/state.ts'],
  }),
  freezeEntry({
    id: 'mcp-schema-host',
    host: 'static.modelcontextprotocol.io',
    category: 'mcp-schema',
    disposition: 'allow',
    allowedByDefault: false,
    paths: ['/schemas'],
    purpose: 'MCP server schema published by the Model Context Protocol project.',
    upstreamFiles: ['src/vs/platform/mcp/common/mcpGalleryService.ts'],
  }),
  freezeEntry({
    id: 'tool-risk-x-sh',
    host: 'x.sh',
    category: 'external-tool',
    disposition: 'allow',
    allowedByDefault: false,
    purpose: 'Tool-risk help link in the chat tool-approval UI.',
    upstreamFiles: ['src/vs/workbench/contrib/chat/browser/tools/chatToolRiskAssessmentService.ts'],
  }),
]);

export const AI_ENDPOINT_CATEGORIES = Object.freeze({
  'local-model': Object.freeze({ allowedByDefault: true, description: 'Loopback, private-LAN, mDNS and on-device model servers.' }),
  'copilot-capi': Object.freeze({ allowedByDefault: false, description: 'GitHub Copilot chat, models, responses and token discovery.' }),
  'copilot-telemetry': Object.freeze({ allowedByDefault: false, description: 'Copilot restricted telemetry fallback.' }),
  'microsoft-telemetry': Object.freeze({ allowedByDefault: false, description: 'Microsoft 1DS telemetry collector.' }),
  'microsoft-model-catalog': Object.freeze({ allowedByDefault: false, description: 'Microsoft/Azure ML model catalog.' }),
  'vscode-update': Object.freeze({ allowedByDefault: false, description: 'Upstream VS Code update feed.' }),
  'github-api': Object.freeze({ allowedByDefault: false, description: 'GitHub REST/GraphQL for the user\'s own repositories.' }),
  'github-content': Object.freeze({ allowedByDefault: false, description: 'GitHub raw/gist/avatar content.' }),
  'external-provider': Object.freeze({ allowedByDefault: false, description: 'Third-party model provider APIs and auth backends.' }),
  'microsoft-documentation': Object.freeze({ allowedByDefault: false, description: 'Microsoft help/documentation links.' }),
  'microsoft-marketplace': Object.freeze({ allowedByDefault: false, description: 'Visual Studio Marketplace links.' }),
  'github-documentation': Object.freeze({ allowedByDefault: false, description: 'GitHub documentation and support links.' }),
  'external-documentation': Object.freeze({ allowedByDefault: false, description: 'Third-party documentation links.' }),
  'mcp-schema': Object.freeze({ allowedByDefault: false, description: 'Model Context Protocol schema hosts.' }),
  'external-tool': Object.freeze({ allowedByDefault: false, description: 'Third-party tool help links.' }),
  'private-ipv6': Object.freeze({ allowedByDefault: false, description: 'IPv6 unique-local model servers; never enabled by a blanket switch, only by an exact host or host+path allow.' }),
  unknown: Object.freeze({ allowedByDefault: false, description: 'Host not present in the audited inventory.' }),
});

const CATEGORY_SWITCHES = Object.freeze({
  'copilot-capi': 'allowCopilotApi',
  'copilot-telemetry': 'allowCopilotTelemetry',
  'microsoft-telemetry': 'allowMicrosoftTelemetry',
  'microsoft-model-catalog': 'allowMicrosoftModelCatalog',
  'vscode-update': 'allowVisualStudioUpdate',
  'github-api': 'allowGitHubApi',
  'github-content': 'allowGitHubContent',
  'external-provider': 'allowExternalProviders',
  'microsoft-documentation': 'allowDocumentation',
  'microsoft-marketplace': 'allowDocumentation',
  'github-documentation': 'allowDocumentation',
  'external-documentation': 'allowDocumentation',
  'mcp-schema': 'allowDocumentation',
  'external-tool': 'allowDocumentation',
  unknown: 'allowUnknownHosts',
});

const BOOLEAN_OPTIONS = Object.freeze([
  'allowCopilotApi',
  'allowCopilotTelemetry',
  'allowMicrosoftTelemetry',
  'allowMicrosoftModelCatalog',
  'allowVisualStudioUpdate',
  'allowGitHubApi',
  'allowGitHubContent',
  'allowExternalProviders',
  'allowDocumentation',
  'allowUnknownHosts',
]);
const ARRAY_OPTIONS = Object.freeze(['allowHosts', 'allowEndpoints']);
const KNOWN_OPTIONS = Object.freeze([...BOOLEAN_OPTIONS, ...ARRAY_OPTIONS]);
const BOOLEAN_OPTION_SET = new Set(BOOLEAN_OPTIONS);

export class AIEndpointPolicyError extends Error {
  constructor(code, endpoint) {
    super(`AI endpoint policy denied the request (${code})`);
    this.name = 'AIEndpointPolicyError';
    this.code = code;
    this.endpoint = endpoint;
  }
}

function invalid(code, reason) {
  return Object.freeze({ ok: false, code, reason });
}

function normalizeHostname(hostname) {
  let host = hostname.toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function ipv4Parts(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined;
  const parts = host.split('.').map(Number);
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
  return parts;
}

function isPrivateIpv4(host) {
  const parts = ipv4Parts(host);
  if (!parts) return false;
  if (parts[0] === 127) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function isPrivateMappedIpv4(text) {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (match) return isPrivateIpv4(match[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
  if (!hex) return false;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  const octets = [high >> 8, high & 255, low >> 8, low & 255].join('.');
  return isPrivateIpv4(octets);
}

function stripBrackets(host) {
  if (host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') return host.slice(1, -1);
  return host;
}

function mappedIpv4(host) {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (match) return match[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return undefined;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

function hexToIpv4(highHex, lowHex) {
  const high = parseInt(highHex, 16);
  const low = parseInt(lowHex, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

// IPv4-compatible, IPv4-translated, NAT64 and 6to4 addresses embed an IPv4 address. A downstream
// translator may deliver them to that IPv4 target, so the embedded address is checked too.
function embeddedIpv4(host) {
  const bare = stripBrackets(host).toLowerCase();
  const found = [];
  const mapped = mappedIpv4(bare);
  if (mapped) found.push(mapped);
  let match = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (match) found.push(hexToIpv4(match[1], match[2]));
  match = /^::ffff:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (match) found.push(hexToIpv4(match[1], match[2]));
  match = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (match) found.push(hexToIpv4(match[1], match[2]));
  match = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(bare);
  if (match) found.push(hexToIpv4(match[1], match[2]));
  return found;
}

// Cloud metadata services (AWS, GCP, Azure, ECS, Alibaba and friends) live on IPv4 link-local,
// IPv6 link-local or a handful of ULA addresses. These are never a local model server, so they are
// hard-denied and no caller switch or allow list can override the decision.
function isForbiddenIpv4(text) {
  if (METADATA_IPV4.includes(text)) return true;
  const parts = ipv4Parts(text);
  return Boolean(parts && parts[0] === 169 && parts[1] === 254);
}

function isForbiddenMetadataCore(bare) {
  if (METADATA_HOSTNAMES.includes(bare)) return true;
  if (isForbiddenIpv4(bare)) return true;
  for (const candidate of embeddedIpv4(bare)) {
    if (isForbiddenIpv4(candidate)) return true;
  }
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  if (bare === 'fd00:ec2::254' || bare === 'fd20:ce::254') return true;
  // RFC 6052 well-known and RFC 8215 local-use NAT64 prefixes both embed an IPv4 target.
  if (bare.startsWith('64:ff9b:1:')) return true;
  return false;
}

// mDNS names resolve on the local network, and local model servers are allowed by default. Strip
// the `.local` / `.localhost` suffixes before the metadata check so an mDNS alias of a metadata
// hostname or address cannot borrow that local trust.
function isForbiddenMetadataHost(host) {
  let bare = stripBrackets(host).toLowerCase();
  for (let depth = 0; depth < 8; depth += 1) {
    if (isForbiddenMetadataCore(bare)) return true;
    if (bare.endsWith('.local')) {
      bare = normalizeHostname(bare.slice(0, -'.local'.length));
      continue;
    }
    if (bare.endsWith('.localhost')) {
      bare = normalizeHostname(bare.slice(0, -'.localhost'.length));
      continue;
    }
    return false;
  }
  return true;
}

function isLocalHost(host) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (bare === '::1') return true;
  if (bare === '0:0:0:0:0:0:0:1') return true;
  if (bare.startsWith('::ffff:') && isPrivateMappedIpv4(bare)) return true;
  if (bare.endsWith('.local')) return true;
  if (bare === 'host.docker.internal' || bare === 'on-device.vscode.invalid') return true;
  return isPrivateIpv4(bare);
}

const METADATA_HOSTNAMES = Object.freeze(['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data']);
const METADATA_IPV4 = Object.freeze([
  [100, 100, 100, 200].join('.'),
  [192, 0, 0, 192].join('.'),
]);

function isPrivateIpv6(host) {
  return /^f[cd][0-9a-f]{2}:/.test(stripBrackets(host));
}

function inventoryMatch(host) {
  for (const entry of AI_ENDPOINT_INVENTORY) {
    if (entry.host === host) return entry;
  }
  if (/\.ghe\.com$/.test(host) || /\.githubcopilot\.com$/.test(host)) {
    return {
      id: /\.githubcopilot\.com$/.test(host) ? 'copilot-capi-regional' : 'github-enterprise',
      host,
      category: /\.githubcopilot\.com$/.test(host) ? 'copilot-capi' : 'github-api',
      disposition: 'block',
      allowedByDefault: false,
    };
  }
  if (host === 'openai.com' || host.endsWith('.openai.com')) {
    return { id: 'external-provider-openai', host, category: 'external-provider', disposition: 'block', allowedByDefault: false };
  }
  if (host.endsWith('.chatgpt.com')) {
    return { id: 'external-provider-chatgpt', host, category: 'external-provider', disposition: 'block', allowedByDefault: false };
  }
  return undefined;
}

function parseEndpoint(url) {
  if (typeof url !== 'string') return invalid('invalid-url', 'URL must be a string');
  if (url.length === 0) return invalid('invalid-url', 'URL is empty');
  if (url.length > MAX_ENDPOINT_URL_CHARS) return invalid('url-too-long', `URL exceeds ${MAX_ENDPOINT_URL_CHARS} characters`);
  if (CONTROL_OR_BIDI.test(url)) return invalid('control-characters', 'URL contains control, bidi, format or separator characters');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return invalid('invalid-url', 'URL could not be parsed');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalid('unsupported-scheme', 'Only http and https are supported');
  }
  if (hasEncodedUnsafePath(parsed.pathname)) {
    return invalid('control-characters', 'URL path contains encoded control or bidi characters');
  }
  if (parsed.username || parsed.password) return invalid('credentials-in-url', 'URL must not carry credentials');
  const host = normalizeHostname(parsed.hostname);
  if (!host || host.includes(' ') || host.includes('/')) return invalid('invalid-host', 'URL host is invalid');
  if (host.startsWith('xn--') || host.includes('.xn--')) return invalid('invalid-host', 'Punycode hostnames are not accepted');
  const port = parsed.port ? Number(parsed.port) : undefined;
  return Object.freeze({
    ok: true,
    scheme: parsed.protocol.slice(0, -1),
    host,
    port,
    path: parsed.pathname || '/',
  });
}

export function classifyAIEndpoint(url) {
  const parsed = parseEndpoint(url);
  if (!parsed.ok) return parsed;
  const forbidden = isForbiddenMetadataHost(parsed.host);
  if (!forbidden && isLocalHost(parsed.host)) {
    return Object.freeze({
      ...parsed,
      category: 'local-model',
      local: true,
      forbidden: false,
      allowedByDefault: true,
      inventoryId: 'local-model',
    });
  }
  const entry = inventoryMatch(parsed.host);
  const category = entry ? entry.category : (isPrivateIpv6(parsed.host) ? 'private-ipv6' : 'unknown');
  return Object.freeze({
    ...parsed,
    category,
    local: false,
    forbidden,
    allowedByDefault: AI_ENDPOINT_CATEGORIES[category].allowedByDefault,
    inventoryId: entry ? entry.id : undefined,
  });
}

function validateOptions(options) {
  if (options === undefined) return { ok: true, value: {} };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false };
  }
  if (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null) {
    return { ok: false };
  }
  const value = {};
  for (const [key, raw] of Object.entries(options)) {
    if (!KNOWN_OPTIONS.includes(key)) return { ok: false };
    if (BOOLEAN_OPTION_SET.has(key)) {
      if (typeof raw !== 'boolean') return { ok: false };
      value[key] = raw;
      continue;
    }
    if (!Array.isArray(raw) || raw.length > 64) return { ok: false };
    const list = [];
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0 || item.length > MAX_OPTION_STRING_CHARS) return { ok: false };
      if (CONTROL_OR_BIDI.test(item)) return { ok: false };
      list.push(item);
    }
    value[key] = Object.freeze(list);
  }
  return { ok: true, value };
}

function hostAllowed(host, allowHosts) {
  if (!allowHosts) return false;
  for (const item of allowHosts) {
    if (normalizeHostname(item.trim()) === host) return true;
  }
  return false;
}

function hasDotSegment(pathName) {
  for (const segment of pathName.split('/')) {
    if (segment === '.' || segment === '..') return true;
  }
  return false;
}

function decodePathSafely(pathName) {
  try {
    return decodeURIComponent(pathName);
  } catch {
    return undefined;
  }
}

function hasEncodedUnsafePath(pathName) {
  let value = pathName;
  for (let depth = 0; depth < 3; depth += 1) {
    if (CONTROL_OR_BIDI.test(value) || value.includes('\\') || hasDotSegment(value) || ENCODED_SEPARATOR_OR_DOT.test(value)) return true;
    const decoded = decodePathSafely(value);
    if (decoded === undefined) return true;
    if (decoded === value) return false;
    value = decoded;
  }
  return true;
}

function endpointAllowed(host, path, allowEndpoints) {
  if (!allowEndpoints) return false;
  if (ENCODED_SEPARATOR_OR_DOT.test(path) || hasEncodedUnsafePath(path)) return false;
  for (const item of allowEndpoints) {
    const slash = item.indexOf('/');
    if (slash <= 0) continue;
    const itemHost = normalizeHostname(item.slice(0, slash).trim());
    let prefix = item.slice(slash);
    if (!prefix.startsWith('/')) prefix = '/' + prefix;
    if (itemHost !== host) continue;
    const head = prefix.endsWith('/') ? prefix : prefix + '/';
    if (path === prefix || path === prefix + '/' || path.startsWith(head)) return true;
  }
  return false;
}

function decision(parsed, category, allowed, code, detail) {
  return Object.freeze({
    allowed,
    code,
    category,
    host: parsed.host,
    port: parsed.port,
    path: parsed.path,
    inventoryId: parsed.inventoryId,
    detail,
  });
}

export function evaluateAIEndpointRequest(url, options = {}) {
  const validated = validateOptions(options);
  if (!validated.ok) {
    return Object.freeze({ allowed: false, code: 'invalid-options', category: undefined, host: undefined, path: undefined, inventoryId: undefined });
  }
  const parsed = classifyAIEndpoint(url);
  if (!parsed.ok) {
    return Object.freeze({ allowed: false, code: parsed.code, category: undefined, host: undefined, path: undefined, inventoryId: undefined });
  }
  if (parsed.forbidden === true) {
    return decision(parsed, parsed.category, false, 'forbidden-endpoint');
  }
  if (parsed.category === 'local-model') {
    return decision(parsed, parsed.category, true, 'local-endpoint');
  }
  if (hostAllowed(parsed.host, validated.value.allowHosts)) {
    return decision(parsed, parsed.category, true, 'host-allowed');
  }
  if (endpointAllowed(parsed.host, parsed.path, validated.value.allowEndpoints)) {
    return decision(parsed, parsed.category, true, 'endpoint-allowed');
  }
  const switchName = CATEGORY_SWITCHES[parsed.category];
  if (switchName && validated.value[switchName] === true) {
    return decision(parsed, parsed.category, true, 'category-allowed');
  }
  return decision(parsed, parsed.category, false, 'denied-by-default');
}

export function redactAIEndpoint(url) {
  const parsed = parseEndpoint(url);
  if (!parsed.ok) return '<invalid-endpoint>';
  const port = parsed.port ? `:${parsed.port}` : '';
  const path = parsed.path.length > MAX_REDACTED_PATH_CHARS ? parsed.path.slice(0, MAX_REDACTED_PATH_CHARS) + '...' : parsed.path;
  return `${parsed.scheme}://${parsed.host}${port}${path}`;
}

export function assertAIEndpointAllowed(url, options = {}) {
  const result = evaluateAIEndpointRequest(url, options);
  if (!result.allowed) {
    throw new AIEndpointPolicyError(result.code, redactAIEndpoint(url));
  }
}

export function describeAIEndpointPolicy(options = {}) {
  const validated = validateOptions(options);
  const value = validated.ok ? validated.value : {};
  return Object.freeze({
    version: AI_ENDPOINT_POLICY_VERSION,
    defaultDeny: true,
    localAllowedByDefault: true,
    categories: Object.freeze(Object.keys(AI_ENDPOINT_CATEGORIES)),
    inventoryCount: AI_ENDPOINT_INVENTORY.length,
    options: Object.freeze({
      ...Object.fromEntries(BOOLEAN_OPTIONS.map((key) => [key, value[key] === true])),
      allowHosts: Object.freeze(value.allowHosts ? [...value.allowHosts] : []),
      allowEndpoints: Object.freeze(value.allowEndpoints ? [...value.allowEndpoints] : []),
    }),
  });
}
