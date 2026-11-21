# ADR-0008: Codex BYOK on OmniRoute as the primary harness; OpenCode as the fallback

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-20

- Status: accepted (supersedes ADR-0007)
- Date: 2026-11-20

## Context

ADR-0007 moved the build loop off Codex onto OpenCode because the owner did not want Codex's ChatGPT subscription inference. The owner then clarified: Codex is welcome if it runs on our own models (BYOK), never the subscription. Two new facts changed the picture on 2026-11-20:

- Codex 0.154 runs entirely on our own models through a custom provider (`wire_api = "responses"`, `requires_openai_auth = false`, `env_key`). Verified live: file edits, shell commands and custom-agent sub-agents all work against OmniRoute's Responses endpoint, with the Morph MCP tools loaded through `cmd /c npx` (verified).
- Codex's own home folder can be set (`CODEX_HOME`). The loop's home has no `auth.json`, so a subscription login cannot exist there; the runner refuses to start if one ever appears.
- Codex does not support the Chat Completions wire API, so it cannot call Morph or DeepInfra directly — only providers that speak the OpenAI Responses API (OmniRoute does).
- OpenCode (ADR-0007) has no operating-system sandbox. Codex's `workspace-write` sandbox confines the agent to the clone and its `.worktrees` folder.

## Decision

- OmniRoute is the forced first provider (health-checked per iteration). When it answers, the loop runs **Codex BYOK** (`codex exec`) with the isolated `CODEX_HOME` under the runner's log folder, the `workspace-write` elevated sandbox, and guardian sub-agents generated with the model for each class.
- When OmniRoute does not answer, the loop falls back to **OpenCode** on Morph direct (DeepSeek V4.1 Flash first, GLM-5.3 for the strong/review classes), then DeepInfra — the providers Codex cannot reach.
- `vibe/goal/models.json` carries `harness` (`codex`/`opencode`) per provider; the runner refuses a codex harness on a non-Responses provider.
- The subscription is never used: `requires_openai_auth = false`, an isolated home, and a refusal if `auth.json` appears.

## Consequences

- The OS-level sandbox returns for the normal case; GOVERNANCE.md §5 residual risks shrink to the OpenCode fallback windows and the open-network/credential risks already recorded.
- Hard stops are enforced mechanically on both harnesses: OpenCode by permission rules, Codex by a generated PATH guard whose shims refuse the same command patterns. The guard is path-level, not a sandbox, so an absolute path to a binary would bypass it; that is recorded as a residual risk.
- OpenCode remains both the product's chosen agent harness (ADR-0001) and the loop's fallback; the dual-path code is shared and tested by the runner's dry-run tests.
- Morph models run through OmniRoute as needed (`morph/*` combos exist there); Morph's direct API serves the fallback and its tool services (Fast Apply, WarpGrep, Compact, Router) through the shared MCP.
