# ADR-0007: Build on our own models with OpenCode

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-20

- Status: superseded by [ADR-0008](0008-codex-byok-primary-opencode-fallback.md) (owner clarified Codex is fine with our own models (BYOK); Codex's sandbox makes it the better primary on OmniRoute, OpenCode stays the fallback harness)
- Date: 2026-11-20

## Context

ADR-0006 ran the build loop on Codex CLI with the owner's ChatGPT subscription. The owner decided the build must not use Codex as its primary agent: the IDE is meant to run our own models at a fraction of the cost, and the build should prove that.

Facts checked on 2026-11-20:

- OpenCode 1.19.5 (MIT, the product's chosen harness, ADR-0001) runs headless with `opencode run --agent <name> -m <provider/model>`, supports custom subagents with per-agent models, and honours permission deny rules for shell commands without a human present.
- With `XDG_CONFIG_HOME` and `XDG_DATA_HOME` set to forward-slash paths, OpenCode loads only the runner's generated config and keeps its own session database.
- OmniRoute (local, port 20128) serves the owner's combos (`agent`, `reasoning`, `review`, `cheap`, …). Morph's API serves open models (`morph-kimik31`, `morph-glm53-744b`, `morph-dsv41flash`, an approval-gated abliterated model), Fast Apply, WarpGrep, Compact and a Router. The MIT `@morphllm/morphmcp` 0.8.222 package exposes `morph_codebase_search` (WarpGrep), `morph_edit_file` (Fast Apply) and `morph_github_codebase_search` to OpenCode.
- A live smoke test ran the overseer on `omniroute/agent`, launched `docs-keeper` on `omniroute/cheap`, used the Morph tools, and had a force-push blocked by the deny list.
- OpenCode 2.x (v2.3.2, 2026-11-18) exists with a new config format. It is too new for the 7-day rule and a migration is a product decision for M6.

## Decision

- The goal runner starts OpenCode 1.19.x with the `vibe-overseer` agent. Guardians are OpenCode subagents generated from `.vibe/agents/` into `.opencode/agent/`.
- `vibe/goal/models.json` lists providers in order: OmniRoute, then Morph direct, then DeepInfra. Each iteration uses the first provider that answers a health check. Every agent declares a `model_class` (`strong`, `standard`, `review`, `cheap`) that maps to a model on that provider.
- The Morph MCP tools are always enabled, so WarpGrep and Fast Apply are available even when OmniRoute is the model provider.
- Codex is not used by the build. `.codex/` is removed from the repository.

## Consequences

- The Codex `workspace-write` sandbox is gone. Isolation now relies on the dedicated clone, secret removal, a hard-stop deny list and server-side branch protection; the residual risk is recorded in `GOVERNANCE.md` §5 and sandbox-runtime is evaluated at M6.
- Token spend moves to the owner's providers. Cheap classes go to cheap models; only governance, security and research use the strong class.
- Morph's Compact is a candidate backend for the Vibe Context Engine (ADR-0003) because it keeps surviving lines byte-identical; it is not used as OpenCode's summarizer.
