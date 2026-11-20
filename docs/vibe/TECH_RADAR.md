# Vibecodium Technology Radar

> Doc class: living · Owner: tech-scout · Last reviewed: 2026-11-20

Maintained by the `tech-scout` sub-agent. Every component the product ships or the build depends on has one row. A row is reviewed by its "Next review" date, at every milestone start, and whenever its component changes. The docs check warns on overdue rows; a new dependency without a row fails the drift check.

Rings: `adopt` (in use, keep), `trial` (in use, under evaluation), `assess` (watching, not in use), `hold` (do not adopt / replace when possible).

"Checked" is the date the version facts were last verified against the live source. Rows marked `carried` were taken from the 2026-11-08 research plan and still need live re-verification at M0 start.

| Component | Choice | Version in use | Latest seen | Checked | Alternatives watched | Ring | Next review |
|---|---|---|---|---|---|---|---|
| Editor base | VSCodium build scripts (fork `ynotfins/vibecodium`) | 1.143.17232 (`upstream/stable.json` 1.143.1) | 1.143.17232 | 2026-11-20 | VS Code upstream directly; Theia (EPL-2.0) | adopt | 2026-11-27 |
| Upstream editor | microsoft/vscode | 1.143.1 | 1.147.0 | 2026-11-20 | 1.147.0 is two days old; defer adoption until at least 2026-11-25 | adopt | 2026-11-25 |
| Build Node.js | Node per `.nvmrc` | 24.18.0 | 24.18.0 | 2026-11-20 | — | adopt | 2026-11-27 |
| Agent harness | OpenCode via ACP | 1.19.5 (workstation CLI) | 1.19.5 (carried) | 2026-11-08 carried | Goose (Apache-2.0), Cline (Apache-2.0), Kilo Code runtime | adopt | 2026-11-27 |
| Gateway / router / MCP gateway | Bifrost | not yet bundled | transports v2.6.0 (2026-11-19) | 2026-11-20 | OmniRoute (MIT), LiteLLM, Portkey (stale) | adopt | 2026-11-27 |
| Optional upstream router | OmniRoute | 3.8.53 (workstation) | active daily (2026-11-20) | 2026-11-20 | Bifrost routing rules | trial | 2026-11-27 |
| Context engine reference | lossless-claw (pattern only, MIT) | — | active (2026-11-19) | 2026-11-20 | agentcore-context-engine 0.2.5 (owner's, adapter only) | assess | 2026-12-04 |
| Vector store | LanceDB | not yet used | v0.41.0 (carried) | 2026-11-08 carried | sqlite-vec (pre-1.0) | adopt | 2026-11-27 |
| Code parsing | tree-sitter (WASM) + ast-grep | not yet used | carried | 2026-11-08 carried | SCIP indexers | adopt | 2026-11-27 |
| Code graph reference | code-review-graph (MIT) | not used | multi-repo registry + daemon (docs, 2026-11-20) | 2026-11-20 | Understand-Anything, Serena | assess | 2026-11-27 |
| Semantic / visual graph | Understand-Anything (MIT) | installed on workstation | carried | 2026-11-08 carried | CodeGraphContext, code-graph-rag | adopt | 2026-11-27 |
| Local model runtime | llama.cpp `llama-server` | not yet bundled | carried | 2026-11-08 carried | Ollama, LocalAI | adopt | 2026-11-27 |
| Sandbox | anthropics/sandbox-runtime | not yet used | carried | 2026-11-08 carried | devcontainers, microsandbox | adopt | 2026-11-27 |
| Autonomous lane | OpenHands Agent Canvas | 1.43.0 stable, `main` edge (workstation) | 1.43.0 (2026-11-20) | 2026-11-20 | — | trial | 2026-11-27 |
| Installer | Inno Setup | VSCodium default | 7.1.1 (carried) | 2026-11-08 carried | WiX v6+ (fee EULA), MSIX | adopt | 2026-11-27 |
| CI platform | GitHub Actions on `ubuntu-latest` (preinstalled Node) | — | — | 2026-11-20 | — | adopt | 2026-12-04 |
| CI action: checkout | `actions/checkout` pinned by SHA `3d3c42e5…` | v7.0.1 (same pin as upstream VSCodium workflows) | carried | 2026-11-20 | — | adopt | 2026-11-27 |
| Build toolchain: Git | Git for Windows (Git Bash runs the build scripts) | 2.55.0.windows.5 | — | 2026-11-20 | — | adopt | 2026-12-04 |
| Build toolchain: jq | jq | 1.8.2 | 1.8.2 | 2026-11-20 | — | adopt | 2026-12-04 |
| Build toolchain: 7-Zip | 7-Zip | installed (Program Files) | — | 2026-11-20 | — | adopt | 2026-12-04 |
| Build toolchain: MSVC | Visual Studio Build Tools 2022, C++ workload | 17.14 | — | 2026-11-20 | Build Tools 2026 (assess) | adopt | 2026-12-04 |
| Build toolchain: Spectre libraries | MSVC Spectre-mitigated runtimes component | missing on workstation (parked) | — | 2026-11-20 | — | adopt | 2026-11-27 |
| Build orchestrator agent | OpenCode (same harness as the product) | 1.19.5 | 1.19.6 (2026-11-17, waiting out 7 days); 2.3.2 (2026-11-18) | 2026-11-20 | Codex CLI (owner decision: not used for this build), OpenHands automations | adopt | 2026-11-27 |
| Agent harness major version | OpenCode 2.x (new config format: `agents`, `permissions` lists) | — | v2.3.2 (2026-11-18) | 2026-11-20 | stay on 1.19.x | assess | 2026-11-27 |
| Build models: primary | OmniRoute combos `agent`, `reasoning`, `review`, `cheap` | 3.8.53 (workstation) | — | 2026-11-20 | Bifrost routing rules | adopt | 2026-11-27 |
| Build models: second option | Morph API (`morph-kimik31`, `morph-glm53-744b`, `morph-dsv41flash`) | live model list 2026-11-20 | — | 2026-11-20 | DeepInfra DeepSeek V4 Pro (third option) | adopt | 2026-11-27 |
| Morph agent tools | `@morphllm/morphmcp` (MIT): WarpGrep, Fast Apply, GitHub search | 0.8.222 (2026-11-11) | 0.8.222 | 2026-11-20 | morph CLI (no native Windows binary) | adopt | 2026-11-27 |
| Build toolchain: Rust | rustup stable | cargo 1.100.0 | 1.100.0 | 2026-11-20 | — | adopt | 2026-12-04 |
| Build toolchain: Python | CPython 3.11 (node-gyp) | 3.11.9 | — | 2026-11-20 | — | adopt | 2026-12-04 |
