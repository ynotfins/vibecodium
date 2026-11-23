# Vibecodium Roadmap

> Doc class: living · Owner: vibe-overseer · Last reviewed: 2026-11-23

Milestones are dependency-ordered. Each milestone's acceptance tests are written before its implementation and must pass (exit 0) before the milestone is marked done. Must-have IDs refer to `PRODUCT_SPEC.md`. The detailed per-milestone acceptance commands from the research plan (§7) are the starting point; the milestone owner refines them into `tests/vibe/` when the milestone starts.

Status values: `done`, `in progress`, `next`, `planned`, `parked`.

| M | Name | Depends | Must-haves | Status |
|---|---|---|---|---|
| F0 | Foundation: governance, docs suite, guardian agents, checks, goal runner, build preflight | — | F1, F2, F4, F5, F7 (process level) | done (this repo); in-product versions land in M9 |
| M0 | Rebrand + reproducible Windows build (`Vibecodium` names, IDs, icons, own update feed repo, CI on Windows) | F0 | A1, G4 | in progress |
| M1 | AI surfaces enabled without Copilot; Microsoft-endpoint audit and stubs; weekly upstream-compat compile job | M0 | A2 | planned |
| M2 | Sidecar supervisor + Bifrost gateway + provider presets (incl. OmniRoute, Morph direct with Fast Apply / WarpGrep / Compact / Router, kie Responses, fallback, budgets) + point-and-click provider setup | M1 | B1, B2, B3, B5, B6 | planned |
| M3 | Local runtime (llama-server) + model downloader + first-run wizard | M2 | B1 (local) | planned |
| M4 | Index: tree-sitter / ast-grep / LSP, embeddings, LanceDB, hybrid retrieval, multi-project registry and watchers | M3 | C1, C2, C5 | done (standalone acceptance met ahead of M3 under the owner's 2026-11-20 standalone-engine priority; IDE binding remains M6. C1 symbol/text/embeddings with tree-sitter WASM, generic LSP and ast-grep providers, local hybrid retrieval and optional driver-injected LanceDB persistence; fixture coverage at least 95% and one-file reindex under 2 s; C2 three-repo registry/watchers; C5 bounded structural answers; native LanceDB loading in Electron remains M12 integration work) |
| M5 | Graph + context + memory: cross-project edge layer, built-in graph panel, Understand-Anything integration, Vibe Context Engine (lossless store, summary DAG, recall tools, cache-stable assembly), project and user memory, AgentCore adapter, docs-mcp | M4 | C3, C4, D1–D5, B4 | in progress (D1–D2 done; D3 storage and revision-bound review API done with review panel UI outstanding; D4 token-budget assembly done; D5 AgentCore adapter done; M4 dependency satisfied; C3 route-to-caller acceptance met by the standalone cross-project edge layer, which also emits package-dependency, import, env-use, exposes-port, database-table-use, mcp-tool and container-image edges; C4 graph panel and memory review UI outstanding) |
| M6 | Agent harness: `vibe` agent provider, ACP client, OpenCode sidecar, Bifrost MCP Code Mode, sandbox-runtime, autonomy dial | M2, M4 | E2, E4 | planned |
| M7 | Editing UX: next-edit / Tab provider with model ladder, inline edit routing, multi-file diff review | M3, M6 | A3, A4 | planned |
| M8 | Multi-agent orchestration, worktrees, merge and conflict cards; OpenHands lane (stable / edge) | M6 | E3, E5 | planned |
| M9 | Vibe Agent + Prompt Studio + in-product governance: docs suite generator, locks, guardians, tech radar for user projects | M5, M8 | E1, F1–F7 | planned |
| M10 | Self-verification: preview panel, browser and test tools in the loop, local traces and cost / cache dashboard | M6 | B4, F4 | planned |
| M11 | Scenario end-to-end suite (mock model + nightly real model), upstream rebase dry-run | M7–M10 | all | planned |
| M12 | Ship: Inno installer `.exe` + portable zip, update feed, signing, license audit, winget manifest draft | M11 | G1–G3, F6, A5 | planned |

## Parked for owner

See `STATUS.md` → "Parked for owner". Parked items never block unrelated milestones.
