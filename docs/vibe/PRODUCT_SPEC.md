# Vibecodium Product Spec (must-haves)

> Doc class: locked · Owner: vibe-overseer · Last reviewed: 2026-11-20
>
> The authoritative list of what v1 must do. Each must-have has an ID that tasks, tests and the roadmap reference. Changing this file requires a PASS from the `governance-verifier` sub-agent.

Status values in `ROADMAP.md` and `STATUS.md` refer to these IDs. "Acceptance" lines describe the observable check; the exact test lives with the milestone that delivers it.

## A. Editor and Cursor parity

| ID | Must-have | Acceptance |
|---|---|---|
| A1 | Rebranded VSCodium build (`Vibecodium`) from the `ynotfins/vibecodium` fork | Built app reports its own name and version; no "VSCodium" in user-visible product strings |
| A2 | Native VS Code AI surfaces enabled without Copilot: chat view, inline chat (Ctrl+K), Agents window, sessions, checkpoints, worktrees | Chat opens on a clean profile with no Copilot or GitHub sign-in |
| A3 | Tab / next-edit suggestions from local or cloud models | Inline suggestion appears in a fixture project within the latency budget set in M7 |
| A4 | Multi-file diff review before apply, with checkpoints and undo | Agent edit can be reviewed, partially accepted and rolled back |
| A5 | Open VSX extensions keep working | Installing a popular Open VSX extension succeeds |

## B. Models, routing and cost

| ID | Must-have | Acceptance |
|---|---|---|
| B1 | Providers: OmniRoute (when the user runs it), Morph, kie.ai (Responses API, `gpt-6-1-sol`), DeepInfra, Abliteration, OpenRouter, Requesty, any OpenAI-compatible endpoint, local llama.cpp / Ollama | Each preset passes chat, streaming and tool-call tests against a mock server; live smoke where a key exists |
| B2 | Automatic fallback when a provider fails (timeouts, 429/5xx, empty streams) | Forced failure of the primary returns an answer from the fallback within the same turn or a clean retry |
| B3 | Smart routing by task class (plan, code edit, quick edit, review, summarize, embed) with per-task and per-day budgets | Policy table drives the model choice; budget hard-stop is enforced |
| B4 | Cache-aware prompt assembly and sticky routing so provider prompt caching works | Repeated turns in one session show cached-input tokens in the usage dashboard |
| B5 | Point-and-click provider setup with an env-var picker; secrets in OS secret storage only | A provider can be added and switched with no file editing; no secret value appears in any file or log |
| B6 | Morph as the direct second option when OmniRoute is unavailable, with its features: Fast Apply edits, WarpGrep code search, Compact (verbatim-preserving history pruning, an option for the context engine), the Router (prompt difficulty → model tier), and Morph-hosted open models including the approval-gated abliterated model | With OmniRoute stopped, an agent task completes on Morph models; Fast Apply and WarpGrep are available as agent tools; Compact output keeps every surviving line byte-identical |

## C. Codebase intelligence

| ID | Must-have | Acceptance |
|---|---|---|
| C1 | Local index per project: symbols (tree-sitter / LSP), text, embeddings | Fixture repo: at least 95% of known symbols indexed; incremental reindex of one file under 2 s |
| C2 | Several projects indexed at the same time, watched in the background | Three registered repos stay current while editing |
| C3 | Cross-project graph: dependencies, HTTP routes and callers, env var names, ports, database tables, MCP tools, containers | Two fixture repos (API + client) show the route-to-caller edge |
| C4 | Built-in graph panel that zooms workspace → project → module → symbol and stays smooth on large graphs | Panel renders the fixture graph inside the IDE; click-through opens the source |
| C5 | Compact structural answers for agents (callers, impact, path between symbols) instead of dumping files | Agent graph query returns a bounded answer, not a full-file dump |

## D. Memory and context

| ID | Must-have | Acceptance |
|---|---|---|
| D1 | Lossless session store: every message, tool call and result kept verbatim on local disk | Raw transcript is recoverable byte-for-byte after compaction |
| D2 | Rolling context window: fresh tail plus a summary DAG (leaf and condensed summaries) with drill-down tools (grep, describe, expand) | A detail from 200 turns ago is retrieved through expand without re-pasting |
| D3 | Project memory and user memory that persist across sessions, with a review UI | Fact stored in session 1 is recalled in session 2 |
| D4 | Huge-context support with token-budget assembly | Context assembly never exceeds the model window and reports what was included |
| D5 | Optional AgentCore adapter: mirror sessions to `agentcore-memory` when present | With the adapter enabled, hydrate/append/close round trip passes |

## E. Prompting and autonomy

| ID | Must-have | Acceptance |
|---|---|---|
| E1 | Prompt Studio: long vibe prompt → short spec (goals, constraints, acceptance tests, open questions) → one-click approve; original kept verbatim | Fixture prompt produces a spec with acceptance tests; approval locks it |
| E2 | Plan → build → test → fix loop that runs without human approval inside a sandbox | Scenario run completes a fixture feature with tests green and no prompts |
| E3 | Parallel agents in isolated worktrees with merge and conflict handling | Five workers on a fixture repo merge cleanly; a forced conflict raises exactly one decision card |
| E4 | Autonomy dial: Safe / Builder / Autopilot, with hard stops for irreversible real-world actions | Hard-stop actions always pause, in every mode |
| E5 | Background autonomous lane powered by OpenHands (stable or edge channel) | A task dispatched to OpenHands returns a branch with passing checks |

## F. Professional development foundation (built into the product)

| ID | Must-have | Acceptance |
|---|---|---|
| F1 | Docs suite created at project start and kept accurate by a docs sub-agent after every task | Docs check passes after every task; drift is fixed or reported |
| F2 | Locked governing docs; changes require a governance-verifier PASS | Editing a locked doc without an approval record fails the governance check |
| F3 | Anti-drift sentinel: scope, spec, architecture and dependency drift | Out-of-scope change in a fixture task is flagged |
| F4 | QA verifier that refuses "done" without evidence | Task without passing tests cannot be marked done |
| F5 | Best-technology scout: tech radar with latest releases and alternatives, reviewed on a schedule and on every new dependency | Radar row older than its review date is flagged; new dependency without a radar row fails the check |
| F6 | Security and license review for commercial shipping (no GPL/AGPL/NC/ELv2 in shipped artifacts, no secrets) | License audit passes on the release build |
| F7 | VibeCoding overseer that coordinates all of the above | Every task leaves a STATUS entry with guardian results |

## G. Ship

| ID | Must-have | Acceptance |
|---|---|---|
| G1 | Windows installer `.exe` (user and system) and portable zip that run on other PCs | Silent install / uninstall on a clean Windows machine succeeds; portable zip runs from a USB folder |
| G2 | Own update feed | Installed build detects and applies a newer version |
| G3 | Code signing | `signtool verify` passes on the exe and every bundled sidecar (signing route is a parked business decision) |
| G4 | Reproducible CI build on Windows | CI produces the same artifacts as the local build script |
