# M1 Microsoft endpoint audit and deny-by-default AI policy

> Doc class: living · Owner: security-reviewer · Last reviewed: 2026-11-24
>
> Audit of the outbound endpoints reachable from the pinned upstream AI services in the scanned
> directories, and the decision core that keeps Vibecodium traffic off Microsoft and GitHub Copilot endpoints unless a
> caller explicitly opts in. The decision core lives in
> [ai-endpoint-policy.mjs](../../../src/stable/security/ai-endpoint-policy.mjs); the acceptance
> test is [ai-endpoint-policy.test.mjs](../../../tests/vibe/ai-endpoint-policy.test.mjs).
>
> Decision-core version: `1.1.2` (`AI_ENDPOINT_POLICY_VERSION`).

## Scope and method

- Pinned upstream: `microsoft/vscode` tag `1.143.1` (commit `e646868227c3e3a9e3f24277c8c7220be42c0be7`),
  the version named by `upstream/stable.json`.
- Directories scanned read-only: `src/vs/platform/agentHost`, `src/vs/sessions`,
  `src/vs/platform/mcp`, `src/vs/platform/telemetry` and `src/vs/workbench/contrib/chat`
  (3,342 TypeScript files; test and fixture files excluded from findings).
- Every absolute `http(s)` URL was extracted with its source file, then each Microsoft, GitHub
  Copilot, telemetry, update-feed and provider host was read in context to separate runtime
  requests from documentation/help links.
- No upstream source, credential, query string or secret value is copied into this repository.

## Findings

| Family | Host | Paths / evidence | Source file | Disposition |
|---|---|---|---|---|
| Copilot CAPI (default) | `api.githubcopilot.com` | `/v1/messages`, `/v1/responses`, `/responses`, `/models`, `/copilot_internal/user`; `COPILOT_CAPI_URL` | `agentHost/node/copilot/copilotAgent.ts`, `agentHost/node/shared/copilotApiService.ts` | Block |
| Copilot CAPI (consumer) | `api.individual.githubcopilot.com` | `/v1/messages`, `/models` | `agentHost/node/copilot/localModelBridge/shim/requestRouter.ts` | Block |
| Copilot CAPI (business) | `api.business.githubcopilot.com` | `/v1/messages`, `/models` | `agentHost/node/copilot/localModelBridge/shim/requestRouter.ts` | Block |
| Copilot CAPI (enterprise) | `api.enterprise.githubcopilot.com` | `/v1/messages`, `/models`, token discovery | `requestRouter.ts`, `copilotApiService.ts` | Block |
| Copilot telemetry | `copilot-telemetry.githubusercontent.com` | `/telemetry`; `GH_TELEMETRY_URL` | `agentHost/node/agentHostRestrictedTelemetry.ts` | Block |
| Microsoft 1DS telemetry | `mobile.events.data.microsoft.com` | `/OneCollector/1.0`, `/ping` | `platform/telemetry/common/1dsAppender.ts` | Block |
| Microsoft model catalog | `api.catalog.azureml.ms` | `/asset-gallery/v1.0/models`, `/modelregistry/v1.0/...` | `agentHost/node/copilot/localModelBridge/shim/constants.ts` | Block |
| Upstream update feed | `update.code.visualstudio.com` | `/api/update/...` | `agentHost/node/sshRemoteAgentHostHelpers.ts` | Block; Vibecodium uses its own feed (G2) |
| GitHub REST/GraphQL | `api.github.com` | `/repos`, `/graphql` | `agentHost/node/agentHostGitHubEndpointService.ts` | User-authorized; denied by default |
| GitHub web | `github.com`, `*.ghe.com` | repository/account surfaces | `agentHost/node/copilot/copilotGitProject.ts`, `sessions/browser/accountTitleBarState.ts` | User-authorized; denied by default |
| GitHub raw content | `raw.githubusercontent.com` | plugin and marketplace views | `workbench/contrib/chat/common/plugins/pluginMarketplaceService.ts` | Block |
| GitHub gist/avatar content | `gist.githubusercontent.com`, `avatars.githubusercontent.com` | chat and MCP registry UI | `workbench/contrib/chat/browser/promptSyntax/promptUrlHandler.ts`, `workbench/contrib/chat/browser/aiCustomization/githubMcpRegistryIcons.ts` | Block |
| Codex provider backend | `chatgpt.com`, `*.chatgpt.com`, `api.openai.com`, `openai.com`, `*.openai.com` | `/backend-api`, `/v1`, `/auth` | `agentHost/node/codex/codexProfileImage.ts` | Block unless a provider is configured |
| Provider documentation | `docs.anthropic.com`, `code.claude.com`, `platform.claude.com`, `developers.openai.com`, `platform.openai.com`, `learn.chatgpt.com`, `modelcontextprotocol.io` | help and provider links | `workbench/contrib/chat/common/promptSyntax/hookTypes.ts`, `agentHost/node/claude/claudeAgent.ts`, `agentHost/node/copilot/prompts/anthropicPrompt.ts`, `sessions/contrib/providers/agentHost/browser/agentHostCodexApprovalsPicker.ts`, `workbench/contrib/chat/browser/chatImageUtils.ts`, `agentHost/node/codex/codexAgent.ts`, `agentHost/common/state/protocol/channels-session/state.ts` | Allow (browser links, not fetches) |
| Microsoft documentation | `aka.ms`, `code.visualstudio.com`, `docs.microsoft.com` | help links | `platform/telemetry/common/telemetryService.ts`, `workbench/contrib/chat/browser/tools/languageModelToolsService.ts`, `platform/telemetry/common/telemetryUtils.ts` | Allow (browser links, not fetches) |
| Marketplace links | `marketplace.visualstudio.com` | help text | `workbench/contrib/chat/browser/tools/languageModelToolsService.ts` | Allow (browser links) |
| MCP schema | `static.modelcontextprotocol.io` | `/schemas/...` | `platform/mcp/common/mcpGalleryService.ts` | Allow when the gallery is used |
| Other help links | `docs.github.com`, `support.github.com`, `open-plugins.com`, `x.sh` | help text | `workbench/contrib/chat/common/languageModels.ts`, `workbench/contrib/chat/common/chatErrorMessages.ts`, `agentHost/common/state/protocol/channels-session/state.ts`, `workbench/contrib/chat/browser/tools/chatToolRiskAssessmentService.ts` | Allow (browser links) |

Local model servers are classified separately and allowed by default: loopback (`localhost`,
`127.0.0.1/8`, `::1`), private IPv4 ranges, `*.local`, `host.docker.internal` and the on-device
sentinel `on-device.vscode.invalid`. Before that local branch is considered, every `.local` and
`.localhost` suffix is stripped and the remaining name is re-checked against the hard-deny set, so
an mDNS alias of a metadata hostname or address cannot borrow local trust. IPv4/IPv6 link-local
ranges and the cloud-metadata hostnames and addresses enumerated in the policy core are hard-denied
(`forbidden-endpoint`) even when every category switch and allow list is set. IPv6 unique-local
addresses (`fc00::/7`) are deliberately not auto-allowed; a local server that needs one must be
granted an exact host or host+path allow. IPv4-mapped IPv6 forms of loopback and private IPv4
addresses are treated the same as their IPv4 equivalents. The hard-deny set is the IPv4/IPv6
link-local ranges, `metadata.google.internal`, `metadata.goog`, `metadata`, `instance-data`,
`169.254.169.254`, `100.100.100.200`, the known IPv6 metadata addresses (`fd00:ec2::254`,
`fd20:ce::254`), all IPv4-embedded wrappers of those addresses, the whole local-use NAT64 prefix
(`64:ff9b:1::/48`), and the IPv4-embedded metadata addresses inside the well-known NAT64 prefix
(`64:ff9b::/96`). Provider aliases outside this list
stay denied by default and require an explicit caller opt-in.

The inventory records the hosts confirmed in the pinned source (32 entries at the time of this
audit). It is not proof that no other Microsoft or Copilot host exists; an unlisted host is denied
as `unknown` until a later audit adds it.

## What the decision core enforces

`evaluateAIEndpointRequest(url, options)` returns a frozen decision. Remote families are denied
by default; only these explicitly opt in:

- `allowCopilotApi`, `allowCopilotTelemetry`, `allowMicrosoftTelemetry`,
  `allowMicrosoftModelCatalog`, `allowVisualStudioUpdate`, `allowGitHubApi`,
  `allowGitHubContent`, `allowExternalProviders`, `allowDocumentation`, `allowUnknownHosts`.
- `allowHosts` and `allowEndpoints` add exact, case-normalized host or host+path-prefix exceptions;
  a suffix such as `githubcopilot.com` does not match `api.githubcopilot.com`. IPv6 entries keep their
  brackets (for example `[fd00::1]`). Both are port-agnostic:
  an exact host allow also permits non-default ports, so a caller that needs port scoping must
  check the decision's `port` itself.
- Credential-bearing URLs, non-HTTP schemes, control/bidi/zero-width characters (raw or
  percent-encoded in the path), oversize URLs, punycode hosts and invalid option types fail closed
  with a stable code, and repeated percent-encoding is decoded up to three times to catch
  double-encoded separators and dot segments. IPv4/IPv6 link-local ranges and the enumerated cloud-metadata
  hostnames and addresses are hard-denied as `forbidden-endpoint`, before any switch or allow list is consulted.
  The metadata check also covers IPv4-embedded IPv6 wrappers (IPv4-compatible, IPv4-translated,
  the well-known and local-use NAT64 prefixes and 6to4) and IPv4 shorthand forms the URL parser
  accepts; an mDNS `.local`/`.localhost` suffix is stripped before the metadata check;
  IPv6 unique-local addresses are not auto-allowed and are never enabled by
  `allowUnknownHosts`; they need an exact host or host+path allow, except the known metadata addresses.
- `redactAIEndpoint` strips userinfo, query and fragment for logs; credential URLs render as
  `<invalid-endpoint>`. Errors never echo the raw URL or a secret; the `endpoint` field is a redacted host/path. Paths are kept (capped at 512
  characters) because routing needs them; callers must never put a secret in a path, and M2
  logging must keep request bodies out of policy messages.
- `describeAIEndpointPolicy` gives the UI and the M2 gateway a stable, secret-free summary.

## Honest boundaries

- This slice audits and decides; it does not yet intercept live traffic. Wiring the decision core
  into the Bifrost gateway (M2) and the agent host (M6) is required before the audit can be claimed
  as a runtime stub. Until then, upstream CAPI, 1DS and Copilot telemetry code is present but
  unreachable unless a user configures Copilot, which Vibecodium removes by default.
- The product's own update feed, Open VSX and provider endpoints are out of scope here; they are
  M0/M2 work.
- The metadata hard-deny covers the IPv4 metadata addresses embedded in the well-known NAT64
  prefix (`64:ff9b::/96`) and the whole local-use NAT64 prefix (`64:ff9b:1::/48`, whose variable
  embedding length cannot be checked reliably without a translator). Other well-known NAT64
  addresses stay ordinary `unknown` hosts: denied by default and reachable only through an explicit
  caller opt-in (`allowUnknownHosts`, or an exact host or host+path allow). The local-use `/48` cannot be enabled at all.
- The audit covers tagged upstream `1.143.1`. The weekly upstream-compile job (M11) and M6
  re-audits must re-run this inventory when upstream adds an AI endpoint.

## Verify

```bash
node --test tests/vibe/ai-endpoint-policy.test.mjs
node vibe/tools/verify.mjs
```
