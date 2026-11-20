# Vibecodium Architecture

> Doc class: locked · Owner: vibe-overseer · Last reviewed: 2026-11-20
>
> Binding architecture principles and component choices. Detailed designs live in `docs/vibe/design/` (living docs). Each component choice has an ADR in `docs/vibe/adr/`. Changing this file requires a PASS from the `governance-verifier` sub-agent.

## 1. Shape of the product: thin fork, hybrid AI layer

Vibecodium is the `ynotfins/vibecodium` fork of VSCodium's build scripts. VSCodium is itself a set of scripts and patches applied to `microsoft/vscode`, so the fork stays a patch set, not a fork of the VS Code source tree.

Decision record: [ADR-0001](adr/0001-thin-fork-hybrid-ai-layer.md). Research input: [2026-11-08 architecture plan](research/2026-11-08-architecture-plan.md).

| Layer | What | Where it lives |
|---|---|---|
| Upstream | VS Code (MIT) at the tag pinned in `upstream/stable.json`, plus VSCodium patches | Untouched; refreshed by merging `VSCodium/vscodium` `master` |
| Overlay | New source files copied over the VS Code tree by `prepare_vscode.sh` (`cp -rp src/stable/* vscode/`) | `src/stable/**` (no patch needed for new files) |
| Hook patches | Small call-site patches (target at most 8, each under 50 lines) | `patches/vibe/` |
| Built-in extensions | `vibecodium-ai` (providers, index, graph, memory, Prompt Studio, dashboard) and `vibecodium-governance` (locks, guardians, cards) | `src/stable/extensions/` |
| Sidecars | Signed local binaries supervised by the main process | `vibe/sidecars.json` (pinned versions + SHA-256) |
| Product tooling | Build wrappers, governance and docs checks, goal runner | `vibe/` |

The AI layer reuses VS Code core's MIT agent surfaces (chat, inline chat, Agents window, sessions, worktrees, checkpoints, hooks, MCP, inline completions UI) and plugs in our own `vibe` agent provider. Proprietary harnesses (Copilot CLI, Claude Agent SDK) are never shipped.

## 2. Components

| Concern | Choice | ADR |
|---|---|---|
| Agent harness | OpenCode over ACP behind the `vibe` agent provider; ACP keeps the harness swappable (Goose, Cline) | 0001 |
| Gateway, routing, MCP | Bifrost (Apache-2.0, Go single binary) bundled as the gateway, router and MCP gateway (Code Mode). Provider order for users who run OmniRoute (MIT): OmniRoute first, Morph direct second, other direct providers after | 0002 |
| Morph services | Fast Apply (edits), WarpGrep (agentic code search), Compact (verbatim history pruning), Router and Morph-hosted open models, through the Morph API and the MIT `@morphllm/morphmcp` tools | 0002 |
| Context and memory | Vibe Context Engine: local, lossless, DAG-summarized rolling context plus project and user memory. Optional AgentCore adapter | 0003 |
| Code index | tree-sitter (WASM) + ast-grep + VS Code LSP providers + embeddings, vectors in LanceDB, graph tables in SQLite | research §B, M4 |
| Cross-project graph | Per-project graphs plus a cross-project edge layer (packages, routes ↔ callers, env names, ports, DB tables, MCP tools, containers). Understand-Anything (MIT) as the semantic and visual layer | M5 |
| Local models | llama.cpp `llama-server` bundled; Ollama auto-detected | research §B |
| Sandbox | anthropics/sandbox-runtime; optional devcontainer tier | research §C |
| Autonomous background lane | OpenHands Agent Canvas / agent-server, stable or edge channel | 0005 |
| Governance and guardians | Locked docs + approval chain + sub-agent guardians, shipped both as the product's own feature and as this repo's build process | 0004 |
| Packaging | Inno Setup `.exe` (user and system) + portable zip; own update feed; signing route parked | research §F29 |

## 3. Binding principles

1. **Patch budget.** New behaviour goes into overlay files, built-in extensions or sidecars first. A new hook patch needs an ADR line explaining why an overlay is impossible.
2. **Upstream cadence.** `master` mirrors `VSCodium/vscodium` and carries no product commits. Product trunk is `vibe/main`. Upstream sync is a merge of `master` into `vibe/main`, followed by the full check suite.
3. **Local first.** User data, indexes, memory, traces and caches live under the user data folder or the project `.vibe/` folder. No telemetry leaves the machine unless the user opts in.
4. **Secrets.** Secrets live only in OS secret storage or OS environment variables. They are never written to files, logs, prompts, traces or commits. The gateway redacts known secret patterns from prompts.
5. **Context engine owns the conversation.** Compaction and context assembly happen where the conversation is owned (agent host), never by rewriting requests inside the gateway. The gateway only routes, caches and enforces budgets.
6. **Cache-stable prompts.** Prompt prefix order is fixed: system → rules → locked spec → repo map → summaries → fresh tail. Compaction rewrites the summary block in batches, not every turn. Sessions stick to one provider unless failover is needed.
7. **Semantic response caching is off for agent traffic.** Bifrost direct (hash) cache is allowed for deterministic calls (embeddings, unchanged guardian checks, docs lookups). Lossy compression is allowed only on tool output, never on user prompts or specs.
8. **Licenses.** Shipped artifacts contain only permissive licenses (MIT, Apache-2.0, BSD, ISC, MPL-2.0 file-level). GPL, AGPL, non-commercial, ELv2 and SSPL code is never shipped.
9. **Supply chain.** Every bundled binary and dependency is pinned with a checksum. New versions are adopted only after they have been public for at least 7 days, unless they fix a security issue.
10. **Portable.** The IDE runs natively on Windows without Docker or WSL. Docker is used only for optional sandboxes and the OpenHands lane.

## 4. Data locations

| Data | Location |
|---|---|
| Product governance (this repo) | `docs/vibe/`, `.vibe/governance/`, `.vibe/agents/` |
| Per-project governance (user projects) | `<project>/.vibe/` (locks, agents, memory exports) |
| User data, indexes, memory, traces | `%APPDATA%/Vibecodium` (portable mode: `data/` beside the executable) |
| Sidecar binaries | `resources/app/vibe/bin/<platform>` |
