# Vibecodium Documentation

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-27

Vibecodium is a standalone, Windows-first AI IDE built on VSCodium. This folder is the product's documentation suite. The upstream VSCodium docs in `docs/` (outside `docs/vibe/`) describe the base build and are left unchanged.

## Governing documents (locked)

| Doc | Purpose |
|---|---|
| [VISION.md](VISION.md) | What the product is, who it is for, what "better than Cursor" means |
| [PRODUCT_SPEC.md](PRODUCT_SPEC.md) | Must-have capabilities with IDs and acceptance checks |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Binding architecture principles and component choices |
| [GOVERNANCE.md](GOVERNANCE.md) | Doc classes, the lock, the after-every-task chain, autonomy contract and hard stops |
| [../../AGENTS.md](../../AGENTS.md) | Operating rules for every agent working in this repo |

## Living documents

| Doc | Purpose |
|---|---|
| [ROADMAP.md](ROADMAP.md) | Milestones and their status |
| [STATUS.md](STATUS.md) | Current state, task log, parked decisions |
| [TECH_RADAR.md](TECH_RADAR.md) | Every component, its version, the latest release and alternatives |
| [research/2026-11-23-ui-graph-index-research.md](research/2026-11-23-ui-graph-index-research.md) | UI mechanics, one cross-project graph authority, and the M4 index stack |
| [spikes/understand-anything.md](spikes/understand-anything.md) | Understand-Anything license and integration decision, plus the projection mapping |
| [design/m1-ai-surfaces.md](design/m1-ai-surfaces.md) | M1 A2 native AI surfaces without Copilot: product transform, extension defaults, tests and boundaries |
| [adr/0009-docs-mcp-local-first.md](adr/0009-docs-mcp-local-first.md) | Local-first docs MCP decision and the later upstream adapter boundary |
| [design/m1-endpoint-audit.md](design/m1-endpoint-audit.md) | M1 Microsoft endpoint audit and the deny-by-default AI policy core |
| [design/m2-provider-presets.md](design/m2-provider-presets.md) | M2 B1 provider catalog, settings-JSON path and the two-transport request client |
| [design/m2-provider-fallback.md](design/m2-provider-fallback.md) | M2 B2 ordered fallback, its retry boundary and safe attempt metadata |
| [design/m2-provider-setup.md](design/m2-provider-setup.md) | M2 B5 provider setup panel, environment-variable key picker and Windows Credential Manager storage |
| [design/m2-provider-routing.md](design/m2-provider-routing.md) | M2 B3 task-class policy routing, output caps and task/day token budgets |
| [design/m2-morph-direct.md](design/m2-morph-direct.md) | M2 B6 direct second-option policy, same-turn fallback and its security boundary |
| [design/m2-compact.md](design/m2-compact.md) | M2 B6 Compact history pruning, the byte-identical line guarantee and its boundaries |
| [design/m2-fast-apply.md](design/m2-fast-apply.md) | M2 B6 bounded Fast Apply `edit_file` agent tool and its workspace, write and error boundaries |
| [design/m2-warp-grep.md](design/m2-warp-grep.md) | M2 B6 bounded WarpGrep `codebase_search` agent tool: read-only tool loop, workspace containment and result bounds |
| [design/m2-morph-router.md](design/m2-morph-router.md) | M2 B6 Router difficulty adapter: one classify call, the three-tier mapping, the conservative fallback and its policy boundary |
| [design/m3-llama-server.md](design/m3-llama-server.md) | M3 local `llama-server` supervisor: authenticated loopback process boundary with a controller-owned key, two-step `/health` plus authenticated `/props` readiness, environment allowlist, opt-in restart/back-off and failure model |
| [design/m3-model-downloader.md](design/m3-model-downloader.md) | M3 model catalog, resumable digest-verified downloader and free-space check |
| [design/m3-hardware-probe.md](design/m3-hardware-probe.md) | M3 bounded hardware probe and the RAM/GPU-to-runtime recommendation policy |
| [design/m3-first-run-wizard.md](design/m3-first-run-wizard.md) | M3 first-run wizard: catalog projection, install state, resumable download flow, pinned and local-daemon start plans, a separate embedding start plan and supervisor hand-off, the pinned sidecar install in the start action (into the installer-owned application data root when the host supplies `sidecar.appDataRoot`, otherwise the `<destinationDir>/runtime` default), supervisor runtime options with the bounded restart policy, Ollama detection and selection, and the setup panel |
| [design/m3-local-provider.md](design/m3-local-provider.md) | M3 local provider host: the wizard-plan-to-B1-client bridge that starts the supervisor, reads the controller key through `auth()` and hands a ready `llama-cpp` (or `ollama`) client to the host, with the bounded failure model and the key-free boundary |
| [design/m3-ollama.md](design/m3-ollama.md) | M3 local Ollama discovery: loopback /api/tags probe, bounded model projection, local chat and embedding selection, and the B1 preset overrides |
| [design/m3-sidecar-binary.md](design/m3-sidecar-binary.md) | M3 pinned llama.cpp sidecar: the `vibe/sidecars.json` pin, digest-verified archive fetch, allowlisted ZIP extraction, idempotent executable install and the installer-owned `ownedRoot` directory under the application data root |
| [design/m3-third-party-notices.md](design/m3-third-party-notices.md) | M3 third-party notices: the `vibe/notices.json` license ledger, verbatim texts pinned by SHA-256, and the generated notice document checked by `verify` |
| [legal/THIRD-PARTY-NOTICES.md](legal/THIRD-PARTY-NOTICES.md) | Generated third-party notices for the pinned runtime components and models |
| [CHANGELOG.md](CHANGELOG.md) | User-visible changes per release |
| [SECURITY.md](SECURITY.md) | Security model and how to report issues |
| [adr/README.md](adr/README.md) | Architecture decision records |
| [dev/BUILD.md](dev/BUILD.md) | How to build Vibecodium on Windows |
| [ops/RELEASE.md](ops/RELEASE.md) | Release checklist |
| [user/README.md](user/README.md) | User guide |

## Archive

| Doc | Purpose |
|---|---|
| [research/2026-11-08-architecture-plan.md](research/2026-11-08-architecture-plan.md) | Original research and architecture plan |

## Checks

`node vibe/tools/verify.mjs` runs the governance, agent-definition, documentation, third-party notices and nightly-intake checks, then every test under `tests/vibe/`. It must pass before any commit.
