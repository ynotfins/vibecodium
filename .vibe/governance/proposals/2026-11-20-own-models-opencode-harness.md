# Proposal: build on our own models with OpenCode; add Morph as the direct second option

- Date: 2026-11-20
- Proposer: vibe-overseer (bootstrapping session), on the owner's instruction
- Must-have IDs: E2, E4 (autonomous loop, hard stops), F2, F7; B1, B6 (new) for Morph
- Locked paths: `AGENTS.md`, `docs/vibe/GOVERNANCE.md`, `docs/vibe/ARCHITECTURE.md`, `docs/vibe/PRODUCT_SPEC.md`, `.vibe/agents/governance-verifier.md`, `vibe/goal/run-goal.ps1`, `vibe/goal/continue.prompt.md`

## Why

The owner decided on 2026-11-20 that this build must not use Codex as its primary agent: the IDE is meant to run our own models at a fraction of the cost. The owner also asked for Morph as a direct second option behind OmniRoute, with its features (Compact, WarpGrep, Router, Fast Apply, hosted open models including the abliterated model). ADR-0007 records the evidence and the decision.

## Change summary

- Runner: OpenCode 1.19.5 replaces Codex; providers OmniRoute → Morph → DeepInfra by health check (`vibe/goal/models.json`, unlocked; the runner only accepts the three provider key names); per-agent model classes; Morph MCP tools; isolated OpenCode config/data; hard-stop deny list; GitHub token from `VIBECODIUM_GH_TOKEN`, else `GITHUB_TOKEN`.
- Prompt: rewritten for OpenCode subagents and the Morph tools.
- `governance-verifier.md` (and the other agent sources): new required fields `mode` and `model_class`.
- GOVERNANCE §2/§4/§5: Codex references replaced; Enforcement rewritten for the OpenCode controls; accepted residual risks updated (no OS sandbox until sandbox-runtime is evaluated at M6).
- AGENTS.md: `.opencode/` instead of `.codex/`; model order note.
- PRODUCT_SPEC: Morph in B1; new must-have B6. ARCHITECTURE: provider order and a Morph services row.

## Evidence

- `node vibe/tools/verify.mjs` PASS (tests cover the runner dry run with per-agent models, Morph tools, deny rules, secret removal, and the lock refusal).
- Live OpenCode smoke on OmniRoute (see STATUS entry).

## Exact change

Output of `git diff --cached origin/vibe/main -- <locked paths>`:

```diff
diff --git a/.vibe/agents/governance-verifier.md b/.vibe/agents/governance-verifier.md
index 21f3cf8..5a303a1 100644
--- a/.vibe/agents/governance-verifier.md
+++ b/.vibe/agents/governance-verifier.md
@@ -2,6 +2,8 @@
 name: governance-verifier
 description: The only agent allowed to approve a change to a locked governing doc. Independently reviews a proposal against the vision, spec, architecture and hard stops, and on PASS applies it and writes the approval record with vibe/tools/governance.mjs approve.
 sandbox: workspace-write
+mode: subagent
+model_class: strong
 reasoning: high
 runs: when a locked path changes (5)
 ---
diff --git a/AGENTS.md b/AGENTS.md
index 1e15b53..744b9eb 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -4,7 +4,7 @@ Operating rules for every agent working in this repository. This file is locked
 
 ## What this repo is
 
-`ynotfins/vibecodium`: the build scripts and patch set for **Vibecodium**, a standalone Windows-first AI IDE built on VSCodium. Product intent: `docs/vibe/VISION.md`. Must-haves: `docs/vibe/PRODUCT_SPEC.md`. Architecture: `docs/vibe/ARCHITECTURE.md`. Everything outside `docs/vibe/`, `.vibe/`, `vibe/`, `tests/vibe/`, `patches/vibe/`, `src/stable/` and `.codex/` is upstream VSCodium; change it only when a milestone requires it, and keep such changes small.
+`ynotfins/vibecodium`: the build scripts and patch set for **Vibecodium**, a standalone Windows-first AI IDE built on VSCodium. Product intent: `docs/vibe/VISION.md`. Must-haves: `docs/vibe/PRODUCT_SPEC.md`. Architecture: `docs/vibe/ARCHITECTURE.md`. Everything outside `docs/vibe/`, `.vibe/`, `vibe/`, `tests/vibe/`, `patches/vibe/`, `src/stable/` and `.opencode/` is upstream VSCodium; change it only when a milestone requires it, and keep such changes small.
 
 ## Read first, every session
 
@@ -32,7 +32,7 @@ The owner granted full autonomy to build to completion. Do not stop between task
 |---|---|
 | All repo checks (required before commit) | `node vibe/tools/verify.mjs` |
 | Governance lock status | `node vibe/tools/governance.mjs status` |
-| Regenerate Codex agent files after editing `.vibe/agents/` | `node vibe/tools/sync-agents.mjs` |
+| Regenerate OpenCode agent files after editing `.vibe/agents/` | `node vibe/tools/sync-agents.mjs` |
 | Build toolchain check (Git Bash) | `bash vibe/dev/preflight.sh` |
 | Build the IDE (Git Bash) | `bash vibe/dev/build-windows.sh` (add `-p` for installer and zip) |
 
@@ -40,7 +40,8 @@ The owner granted full autonomy to build to completion. Do not stop between task
 
 - Never write, print, log or commit a secret value. Environment variable names are fine.
 - Never edit a `locked` doc or locked file except through `governance-verifier` (GOVERNANCE §3).
-- Never hand-edit `.codex/agents/*.toml`; edit `.vibe/agents/*.md` and regenerate.
+- Never hand-edit `.opencode/agent/*.md`; edit `.vibe/agents/*.md` and regenerate.
+- The build runs on our own models (OmniRoute first, Morph direct second, DeepInfra third; `vibe/goal/models.json`). Use the Morph tools for code search (WarpGrep) and edits (Fast Apply) when available.
 - `master` mirrors `VSCodium/vscodium` only. Product work lands on `vibe/main` by PR.
 - Library and API facts come from live sources (release pages, registries, official docs), not memory. Record versions in `docs/vibe/TECH_RADAR.md`.
 - New dependencies: permissive license, pinned version and checksum, public for at least 7 days, radar row added.
diff --git a/docs/vibe/ARCHITECTURE.md b/docs/vibe/ARCHITECTURE.md
index 8c655ce..c98af98 100644
--- a/docs/vibe/ARCHITECTURE.md
+++ b/docs/vibe/ARCHITECTURE.md
@@ -26,7 +26,8 @@ The AI layer reuses VS Code core's MIT agent surfaces (chat, inline chat, Agents
 | Concern | Choice | ADR |
 |---|---|---|
 | Agent harness | OpenCode over ACP behind the `vibe` agent provider; ACP keeps the harness swappable (Goose, Cline) | 0001 |
-| Gateway, routing, MCP | Bifrost (Apache-2.0, Go single binary) bundled as the gateway, router and MCP gateway (Code Mode). OmniRoute (MIT) supported as an optional upstream provider for users who run it | 0002 |
+| Gateway, routing, MCP | Bifrost (Apache-2.0, Go single binary) bundled as the gateway, router and MCP gateway (Code Mode). Provider order for users who run OmniRoute (MIT): OmniRoute first, Morph direct second, other direct providers after | 0002 |
+| Morph services | Fast Apply (edits), WarpGrep (agentic code search), Compact (verbatim history pruning), Router and Morph-hosted open models, through the Morph API and the MIT `@morphllm/morphmcp` tools | 0002 |
 | Context and memory | Vibe Context Engine: local, lossless, DAG-summarized rolling context plus project and user memory. Optional AgentCore adapter | 0003 |
 | Code index | tree-sitter (WASM) + ast-grep + VS Code LSP providers + embeddings, vectors in LanceDB, graph tables in SQLite | research §B, M4 |
 | Cross-project graph | Per-project graphs plus a cross-project edge layer (packages, routes ↔ callers, env names, ports, DB tables, MCP tools, containers). Understand-Anything (MIT) as the semantic and visual layer | M5 |
diff --git a/docs/vibe/GOVERNANCE.md b/docs/vibe/GOVERNANCE.md
index ac7bbbd..caba6d7 100644
--- a/docs/vibe/GOVERNANCE.md
+++ b/docs/vibe/GOVERNANCE.md
@@ -20,7 +20,7 @@ Every Markdown file under `docs/vibe/` starts with a header line: `Doc class: <c
 - `.vibe/governance/locks.json` lists every locked path and its SHA-256 (computed on LF-normalized content).
 - `.vibe/governance/approvals/NNNN-<slug>.md` is the approval chain. Each record names the verifier, the verdict and one or more lines `lock: <path> <old-sha|-> -> <new-sha>`.
 - `node vibe/tools/governance.mjs check` fails when a locked file's content does not match the latest approved hash, when `locks.json` disagrees with the chain, or when a record is malformed or not a PASS.
-- The check runs in `node vibe/tools/verify.mjs`, in the Codex Stop hook (`.codex/validate.ps1`) and in CI (`.github/workflows/vibe-governance.yml`).
+- The check runs in `node vibe/tools/verify.mjs`, before every goal-loop session (the runner refuses to start when it fails) and in CI (`.github/workflows/vibe-governance.yml`).
 - The lock covers the check itself and the autonomous loop: the governance tool and its helper library, the governance-verifier definition, the CI workflow, the goal runner, its prompt, its registration script, `vibe/goal/GOAL.md`, this file and `AGENTS.md` are locked. The runner refuses to start a session when the governance check fails.
 
 Honest limit: this is a process lock, not a security boundary. A determined agent could forge a record. Forgery is detectable because records must be created in their own commit and must reference a proposal; `drift-sentinel` and CI review this on every change.
@@ -35,7 +35,7 @@ Honest limit: this is a process lock, not a security boundary. A determined agen
 
 ## 4. The after-every-task chain
 
-Every task slice, by any agent, ends with this chain before it is committed. Each guardian is a separate sub-agent defined in `.vibe/agents/` (Codex copies are generated into `.codex/agents/`).
+Every task slice, by any agent, ends with this chain before it is committed. Each guardian is a separate sub-agent defined in `.vibe/agents/` (OpenCode copies are generated into `.opencode/agent/`; each declares a model class that the runner maps to one of our models).
 
 | Order | Guardian | Runs when | Blocks on |
 |---|---|---|---|
@@ -59,19 +59,22 @@ The owner granted full autonomy for the build (UNLOCK of `D:\vscodium\AGENTS.md`
 
 ### Enforcement
 
-Instructions alone are not a boundary, so the loop is also constrained mechanically:
+Instructions alone are not a boundary, so the loop is also constrained mechanically. The loop runs on our own models through OpenCode (ADR-0007); OpenCode has no operating-system sandbox, so the controls are:
 
-- The goal loop runs in a dedicated clone used by nothing else. The runner starts Codex in the `workspace-write` sandbox with writes limited to that clone and its `<clone>.worktrees` folder; the owner's other checkouts and files cannot be modified.
-- Secret-looking environment variables (API keys, tokens, passwords, database URLs) are removed from the runner before Codex starts, so the agent cannot read them. GitHub access uses a fine-grained token scoped to this repository (`VIBECODIUM_GH_TOKEN`) when the owner has created one; otherwise it falls back to the owner's GitHub CLI login and the runner logs a warning.
+- The goal loop runs in a dedicated clone used by nothing else, so a mistake cannot touch the owner's other checkouts through git.
+- Secret-looking environment variables (API keys, tokens, passwords, database URLs) are removed from the runner before OpenCode starts. Only the model-provider keys the runner allows (OmniRoute, Morph, DeepInfra) and `GH_TOKEN` are passed on. `GH_TOKEN` comes from a fine-grained token scoped to this repository (`VIBECODIUM_GH_TOKEN`) when the owner has created one; otherwise the runner falls back to the owner's `GITHUB_TOKEN` and logs a warning.
+- OpenCode runs with its own generated config and data folders, so the owner's MCP servers, global rules and session history are neither loaded nor modified.
+- Hard-stop shell commands are denied by OpenCode permission rules: force-push and remote branch deletion, release creation or editing, repository deletion or settings, GitHub auth and secrets, package publishing, software installs, environment dumps, global git config, scheduled tasks, registry edits and recursive deletes of system paths.
 - GitHub branch protection on `master` and `vibe/main` forbids force-pushes and branch deletion.
 - Runner logs keep only short summaries with secret values redacted; raw agent event streams are never written to disk. Logs are deleted after 14 days.
 
-Accepted residual risks (reviewed by `security-reviewer` on 2026-11-20):
+Accepted residual risks (owner decision 2026-11-20: run the build on our own models instead of a sandboxed vendor agent):
 
-- Network access is open, not allowlisted, because research, package registries and provider docs are part of the work. Prompt injection from web content could cause outbound requests; it cannot reach machine secrets (removed) or files outside the loop's clone.
-- The loop's GitHub credential is readable by the agent. Scope it to this repository with `VIBECODIUM_GH_TOKEN` to limit the blast radius.
+- No operating-system sandbox: a shell command that the deny list does not anticipate can write anywhere the owner's account can. `tech-scout` evaluates sandbox-runtime for the loop at M6 start, when the product needs it anyway.
+- Network access is open, not allowlisted, because research, package registries and provider docs are part of the work. Prompt injection from web content could cause outbound requests.
+- The model-provider keys and the GitHub credential are readable by the agent. Scope GitHub with `VIBECODIUM_GH_TOKEN` to limit the blast radius; provider keys should carry spending limits at the provider.
 - The runner and the lock live in the same user-writable clone and the scheduled task uses `-ExecutionPolicy Bypass` (required by the workstation's silent-automation policy). A process already running as the owner could replace both; that attacker already controls the account, so script signing would add little.
-- The in-product quarantine of untrusted content (SECURITY.md) lands with M6; until then the build loop relies on the sandbox, secret removal and server-side branch protection.
+- The in-product quarantine of untrusted content (SECURITY.md) lands with M6; until then the build loop relies on secret removal, the deny list and server-side branch protection.
 
 ### Hard stops (always pause, in every mode)
 
diff --git a/docs/vibe/PRODUCT_SPEC.md b/docs/vibe/PRODUCT_SPEC.md
index 7a0bc45..24778e7 100644
--- a/docs/vibe/PRODUCT_SPEC.md
+++ b/docs/vibe/PRODUCT_SPEC.md
@@ -20,11 +20,12 @@ Status values in `ROADMAP.md` and `STATUS.md` refer to these IDs. "Acceptance" l
 
 | ID | Must-have | Acceptance |
 |---|---|---|
-| B1 | Providers: kie.ai (Responses API, `gpt-6-1-sol`), DeepInfra, Abliteration, OpenRouter, Requesty, any OpenAI-compatible endpoint, local llama.cpp / Ollama | Each preset passes chat, streaming and tool-call tests against a mock server; live smoke where a key exists |
+| B1 | Providers: OmniRoute (when the user runs it), Morph, kie.ai (Responses API, `gpt-6-1-sol`), DeepInfra, Abliteration, OpenRouter, Requesty, any OpenAI-compatible endpoint, local llama.cpp / Ollama | Each preset passes chat, streaming and tool-call tests against a mock server; live smoke where a key exists |
 | B2 | Automatic fallback when a provider fails (timeouts, 429/5xx, empty streams) | Forced failure of the primary returns an answer from the fallback within the same turn or a clean retry |
 | B3 | Smart routing by task class (plan, code edit, quick edit, review, summarize, embed) with per-task and per-day budgets | Policy table drives the model choice; budget hard-stop is enforced |
 | B4 | Cache-aware prompt assembly and sticky routing so provider prompt caching works | Repeated turns in one session show cached-input tokens in the usage dashboard |
 | B5 | Point-and-click provider setup with an env-var picker; secrets in OS secret storage only | A provider can be added and switched with no file editing; no secret value appears in any file or log |
+| B6 | Morph as the direct second option when OmniRoute is unavailable, with its features: Fast Apply edits, WarpGrep code search, Compact (verbatim-preserving history pruning, an option for the context engine), the Router (prompt difficulty → model tier), and Morph-hosted open models including the approval-gated abliterated model | With OmniRoute stopped, an agent task completes on Morph models; Fast Apply and WarpGrep are available as agent tools; Compact output keeps every surviving line byte-identical |
 
 ## C. Codebase intelligence
 
diff --git a/vibe/goal/continue.prompt.md b/vibe/goal/continue.prompt.md
index 695cdf2..a365a59 100644
--- a/vibe/goal/continue.prompt.md
+++ b/vibe/goal/continue.prompt.md
@@ -1,9 +1,9 @@
-You are the vibe-overseer for the Vibecodium build, running unattended inside an autonomous goal loop. No human will answer questions during this session.
+You are the vibe-overseer for the Vibecodium build, running unattended inside an autonomous goal loop. No human will answer questions during this session. You run on our own models through OpenCode; every guardian is an OpenCode subagent defined in .opencode/agent/ (generated from .vibe/agents/).
 
 1. Read AGENTS.md, vibe/goal/GOAL.md, docs/vibe/GOVERNANCE.md, docs/vibe/STATUS.md and docs/vibe/ROADMAP.md.
 2. If STATUS.md says "Goal state: complete" or "Goal state: blocked", verify that claim, print GOAL_STATE=<state> and stop.
-3. Otherwise create a goal for this thread with the goal tool: "Complete the next task slice of the Vibecodium build per vibe/goal/GOAL.md, including the full guardian chain and STATUS entry."
-4. Do exactly one task slice following the "One task slice" procedure in .vibe/agents/vibe-overseer.md. Spawn each guardian in docs/vibe/GOVERNANCE.md section 4 as a separate sub-agent using the custom agents in .codex/agents/.
-5. Never cross a hard stop in docs/vibe/GOVERNANCE.md section 5. Park business decisions in STATUS.md and continue with other unblocked work.
-6. Before finishing: node vibe/tools/verify.mjs must pass on the trunk worktree, the STATUS entry must be written, and the branch must be pushed with a PR opened (merge it when CI is green).
+3. Do exactly one task slice following the "One task slice" procedure in .vibe/agents/vibe-overseer.md. Launch each guardian in docs/vibe/GOVERNANCE.md section 4 as a separate subagent (qa-verifier, drift-sentinel, security-reviewer, docs-keeper, governance-verifier, tech-scout, release-manager) and wait for its report.
+4. Prefer the Morph tools: morph_codebase_search (WarpGrep) to find code, morph_edit_file (Fast Apply) for edits to existing files, morph_github_codebase_search to study other repositories.
+5. Never cross a hard stop in docs/vibe/GOVERNANCE.md section 5. Some hard-stop commands are blocked; do not try to work around a blocked command. Park business decisions in STATUS.md and continue with other unblocked work.
+6. Before finishing: node vibe/tools/verify.mjs must pass on the trunk, the STATUS entry must be written, and the branch must be pushed with a PR opened into vibe/main (gh pr create --repo ynotfins/vibecodium --base vibe/main). Merge it when CI is green (gh pr merge --merge).
 7. End your final message with one line: SLICE_RESULT=done|parked|failed and GOAL_STATE=active|complete|blocked.
diff --git a/vibe/goal/run-goal.ps1 b/vibe/goal/run-goal.ps1
index d36a846..e45f06a 100644
--- a/vibe/goal/run-goal.ps1
+++ b/vibe/goal/run-goal.ps1
@@ -1,20 +1,26 @@
 <#
 .SYNOPSIS
-  Autonomous goal loop for the Vibecodium build (ADR-0006).
+  Autonomous goal loop for the Vibecodium build (ADR-0007).
 
 .DESCRIPTION
-  Each iteration starts a fresh `codex exec` session in the trunk worktree with
-  vibe/goal/continue.prompt.md. The session does one task slice and records state in the repo.
+  Each iteration starts a fresh OpenCode session (`opencode run --agent vibe-overseer`) in the
+  dedicated clone with vibe/goal/continue.prompt.md attached. The session does one task slice and
+  records state in the repo. Models are our own, chosen per iteration from vibe/goal/models.json:
+  the first provider in "order" that answers a health check (OmniRoute, then Morph direct, then
+  DeepInfra). Each guardian sub-agent gets the model for its model_class.
+
   The loop stops when docs/vibe/STATUS.md says "Goal state: complete" or "Goal state: blocked",
-  when the daily iteration cap is reached, or after repeated failures.
+  when the daily iteration cap is reached, when no provider answers, after repeated failures, or
+  when this script changes on trunk (the scheduler then starts the new version).
   A lock file prevents concurrent runs. Designed to run hidden (see Register-GoalRunner.ps1).
 
   Isolation (docs/vibe/GOVERNANCE.md §5 "Enforcement"):
-  - Root is a dedicated clone used only by the loop. Codex may write only inside Root and its
-    sibling task-worktree folder "<Root>.worktrees"; every other checkout and file is read-only to it.
-  - Secret-looking environment variables are removed before Codex starts, so API keys on this
-    machine are not visible to the agent. GitHub access uses GH_TOKEN from VIBECODIUM_GH_TOKEN
-    (a fine-grained token scoped to ynotfins/vibecodium) when that variable exists.
+  - Root is a dedicated clone used only by the loop.
+  - Every secret-looking environment variable is removed before OpenCode starts, except the model
+    provider keys in $AllowedProviderKeys and GH_TOKEN. GH_TOKEN comes from VIBECODIUM_GH_TOKEN
+    (a fine-grained token scoped to ynotfins/vibecodium) when it exists.
+  - OpenCode runs with its own generated config and data folders (no user config, MCP servers or
+    history leak in) and with deny rules for hard-stop shell commands.
 
 .PARAMETER Root
   Dedicated clone of ynotfins/vibecodium, checked out on vibe/main.
@@ -25,8 +31,10 @@ param(
   [int]$MaxIterationsPerDay = 24,
   [int]$IterationTimeoutMinutes = 180,
   [int]$MaxConsecutiveFailures = 3,
-  [string]$Codex = '',
-  # Print the session command line and the environment check, then exit without starting Codex.
+  [string]$OpenCode = '',
+  # Use this provider from vibe/goal/models.json instead of health-checking (tests, manual runs).
+  [string]$Provider = '',
+  # Print the session command line, the chosen provider and the environment check, then exit.
   [switch]$DryRun
 )
 
@@ -38,18 +46,12 @@ function Write-Log([string]$m) { Add-Content -Path $log -Value ("{0}  {1}" -f (G
 
 try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch { }
 
-# npm installs codex as .ps1/.cmd shims; Start-Process needs the .cmd (or a real .exe).
-if (-not $Codex) {
-  $cmd = Get-Command codex.cmd -ErrorAction SilentlyContinue
-  $Codex = if ($cmd) { $cmd.Source } else { (Get-Command codex -ErrorAction Stop).Source }
-}
+if (-not $OpenCode) { $OpenCode = (Get-Command opencode -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
 
-# Inside the Codex sandbox the Windows TLS store and credential manager are unavailable.
-# Use OpenSSL and the GitHub CLI as git credential helper for this process tree only (no git config change).
-$env:GIT_CONFIG_COUNT = '3'
-$env:GIT_CONFIG_KEY_0 = 'http.sslBackend'; $env:GIT_CONFIG_VALUE_0 = 'openssl'
-$env:GIT_CONFIG_KEY_1 = 'credential.helper'; $env:GIT_CONFIG_VALUE_1 = ''
-$env:GIT_CONFIG_KEY_2 = 'credential.helper'; $env:GIT_CONFIG_VALUE_2 = '!gh auth git-credential'
+# Git uses the GitHub CLI (and therefore GH_TOKEN) as its credential helper, for this process tree only.
+$env:GIT_CONFIG_COUNT = '2'
+$env:GIT_CONFIG_KEY_0 = 'credential.helper'; $env:GIT_CONFIG_VALUE_0 = ''
+$env:GIT_CONFIG_KEY_1 = 'credential.helper'; $env:GIT_CONFIG_VALUE_1 = '!gh auth git-credential'
 
 # Single instance.
 $lockFile = Join-Path $LogDir 'runner.lock'
@@ -59,19 +61,21 @@ if (Test-Path $lockFile) {
 }
 Set-Content -Path $lockFile -Value $PID
 
-# Remove secret-looking environment variables from this process (children inherit the reduced set).
-# Values are kept in memory only, to redact them from the short summaries the runner writes.
+# Remove secret-looking environment variables (children inherit the reduced set). Values are kept in
+# memory only: provider keys are restored below, the rest are used only to redact summaries.
+$AllowedProviderKeys = @('OMNIROUTE_API_KEY', 'MORPH_API_KEY', 'DEEPINFRA_API_KEY')
 $secretPattern = 'KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_AUTH|AUTH_|DATABASE_URL|_DSN$'
 $script:SecretValues = @{}
-$scopedGh = $env:VIBECODIUM_GH_TOKEN
 foreach ($e in @(Get-ChildItem Env:)) {
   if ($e.Name -match $secretPattern -and $e.Name -notmatch '^GIT_CONFIG_') {
     if ($e.Value -and $e.Value.Length -ge 8) { $script:SecretValues[$e.Name] = $e.Value }
     Remove-Item -LiteralPath "Env:$($e.Name)"
   }
 }
-if ($scopedGh) { $env:GH_TOKEN = $scopedGh }
-else { Write-Log "VIBECODIUM_GH_TOKEN is not set; GitHub access falls back to the owner's gh login (broader scope)" }
+foreach ($k in $AllowedProviderKeys) { if ($script:SecretValues.ContainsKey($k)) { Set-Item -LiteralPath "Env:$k" -Value $script:SecretValues[$k] } }
+$ghSource = @('VIBECODIUM_GH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN') | Where-Object { $script:SecretValues.ContainsKey($_) } | Select-Object -First 1
+if ($ghSource) { $env:GH_TOKEN = $script:SecretValues[$ghSource] }
+if ($ghSource -ne 'VIBECODIUM_GH_TOKEN') { Write-Log "VIBECODIUM_GH_TOKEN is not set; GitHub access uses $(if ($ghSource) { $ghSource } else { 'nothing' }) (broader scope)" }
 
 # Replace every known secret value with its variable name.
 function Protect-Text([string]$text) {
@@ -118,6 +122,79 @@ function Add-TodayCount {
   Set-Content -Path $f -Value ((Get-TodayCount) + 1)
 }
 
+function Get-Models {
+  $models = Get-Content -Raw (Join-Path $Root 'vibe\goal\models.json') | ConvertFrom-Json
+  foreach ($name in $models.order) {
+    $k = $models.providers.$name.keyEnv
+    if ($k -notin $AllowedProviderKeys) { throw "models.json: provider '$name' uses key '$k', which the runner does not allow" }
+  }
+  return $models
+}
+
+# First provider in models.order whose /models endpoint answers.
+function Select-Provider($models) {
+  if ($Provider) { return $Provider }
+  foreach ($name in $models.order) {
+    $p = $models.providers.$name
+    $key = $script:SecretValues[$p.keyEnv]
+    if (-not $key) { Write-Log "provider $name skipped: $($p.keyEnv) is not set"; continue }
+    try {
+      $r = Invoke-WebRequest -Uri ($p.baseURL.TrimEnd('/') + '/models') -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15 -UseBasicParsing
+      if ($r.StatusCode -eq 200) { return $name }
+    } catch { Write-Log "provider $name unavailable: $(Protect-Text $_.Exception.Message)" }
+  }
+  return $null
+}
+
+# Hard-stop shell commands are denied (docs/vibe/GOVERNANCE.md §5). A deny list is not a sandbox;
+# the accepted residual risk is documented in GOVERNANCE.md.
+$DeniedCommands = @(
+  'git push --force*', 'git push -f*', 'git push * --force*', 'git push * -f*', 'git push --delete*', 'git push * --delete*', 'git push * :*',
+  'git config --global*', 'git config --system*',
+  'gh release create*', 'gh release edit*', 'gh release delete*', 'gh release upload*',
+  'gh repo delete*', 'gh repo edit*', 'gh repo archive*', 'gh secret*', 'gh variable*', 'gh auth*',
+  'gh api * -X DELETE*', 'gh api * --method DELETE*', 'gh api -X DELETE*', 'gh api --method DELETE*',
+  'npm publish*', 'pnpm publish*', 'yarn publish*', 'winget *', 'choco *',
+  'env', 'printenv*', 'set', 'Get-ChildItem Env:*', 'gci env:*', 'dir env:*', 'ls env:*', '*GetEnvironmentVariable*',
+  'schtasks*', '*Register-ScheduledTask*', 'reg add*', 'reg delete*', 'format *', 'diskpart*',
+  'rm -rf /*', 'rm -rf ~*', 'rm -rf C:*', 'rm -rf /c*', 'rm -rf /d*', 'Remove-Item * -Recurse* C:\*'
+)
+
+# Generated OpenCode config: our providers, per-agent models, the Morph MCP tools, deny rules.
+function Write-OpenCodeConfig($models, [string]$chosen, [string]$configDir) {
+  $providers = [ordered]@{}
+  foreach ($name in $models.order) {
+    $p = $models.providers.$name
+    $m = [ordered]@{}
+    foreach ($id in ($p.classes.PSObject.Properties.Value | Sort-Object -Unique)) { $m[$id] = @{ name = $id } }
+    $providers[$name] = [ordered]@{ npm = '@ai-sdk/openai-compatible'; name = $p.name; options = [ordered]@{ baseURL = $p.baseURL; apiKey = "{env:$($p.keyEnv)}" }; models = $m }
+  }
+  $classes = $models.providers.$chosen.classes
+  $agents = [ordered]@{}
+  foreach ($f in Get-ChildItem (Join-Path $Root '.vibe\agents') -Filter *.md) {
+    $mc = (Select-String -Path $f.FullName -Pattern '^model_class:\s*(\w+)' | Select-Object -First 1).Matches[0].Groups[1].Value
+    $agents[$f.BaseName] = @{ model = "$chosen/$($classes.$mc)" }
+  }
+  $agents['compaction'] = @{ model = "$chosen/$($classes.cheap)" }
+  $bash = [ordered]@{ '*' = 'allow' }
+  foreach ($d in $DeniedCommands) { $bash[$d] = 'deny' }
+  $cfg = [ordered]@{
+    '$schema' = 'https://opencode.ai/config.json'
+    model = "$chosen/$($classes.standard)"
+    small_model = "$chosen/$($classes.cheap)"
+    autoupdate = $false
+    share = 'disabled'
+    provider = $providers
+    agent = $agents
+    mcp = @{ morph = [ordered]@{ type = 'local'; command = @('npx', '-y', "@morphllm/morphmcp@$($models.morphMcpVersion)"); environment = @{ MORPH_API_KEY = '{env:MORPH_API_KEY}' }; enabled = $true } }
+    permission = [ordered]@{ edit = 'allow'; webfetch = 'allow'; external_directory = 'allow'; doom_loop = 'allow'; bash = $bash }
+  }
+  New-Item -ItemType Directory -Force -Path (Join-Path $configDir 'opencode') | Out-Null
+  $file = Join-Path $configDir 'opencode\opencode.json'
+  Set-Content -Path $file -Value ($cfg | ConvertTo-Json -Depth 10) -Encoding utf8NoBOM
+  return $file
+}
+
 $selfHash = (Get-FileHash -LiteralPath $PSCommandPath).Hash
 
 try {
@@ -126,18 +203,17 @@ try {
     # The runner, its prompt and the governance tool are locked files. Never run a tampered loop.
     & node (Join-Path $Root 'vibe\tools\governance.mjs') check *> $null
     if ($LASTEXITCODE -ne 0) { Write-Log 'governance check failed on trunk; refusing to start a session'; break }
-    $prompt = Get-Content -Raw (Join-Path $Root 'vibe\goal\continue.prompt.md')
     $state = Get-GoalState
     if ($state -ne 'active') { Write-Log "goal state is '$state'; stopping"; break }
     if ((Get-TodayCount) -ge $MaxIterationsPerDay) { Write-Log "daily cap $MaxIterationsPerDay reached; stopping"; break }
 
     # Refresh trunk without ever discarding local work.
-    $dirty = git -C $Root status --porcelain
-    if ($DryRun) { }
-    elseif ($dirty) { Write-Log 'trunk worktree has uncommitted changes; not refreshing (work is preserved)' }
-    else {
-      git -C $Root fetch --quiet origin 2>&1 | Out-Null
-      git -C $Root merge --ff-only --quiet origin/vibe/main 2>&1 | Out-Null
+    if (-not $DryRun) {
+      if (git -C $Root status --porcelain) { Write-Log 'trunk has uncommitted changes; not refreshing (work is preserved)' }
+      else {
+        git -C $Root fetch --quiet origin 2>&1 | Out-Null
+        git -C $Root merge --ff-only --quiet origin/vibe/main 2>&1 | Out-Null
+      }
     }
 
     # A merged change to this script takes effect on the next scheduled start, not mid-loop.
@@ -146,47 +222,39 @@ try {
       break
     }
 
+    $models = Get-Models
+    $chosen = Select-Provider $models
+    if (-not $chosen) { Write-Log 'no model provider answered; stopping until the next scheduled start'; break }
+    $classes = $models.providers.$chosen.classes
+
+    # Own config and data folders: no user config, MCP servers or session history leak in or out.
+    $ocHome = Join-Path $LogDir 'opencode-home'
+    $env:XDG_CONFIG_HOME = (Join-Path $ocHome 'config') -replace '\\', '/'
+    $env:XDG_DATA_HOME = (Join-Path $ocHome 'data') -replace '\\', '/'
+    $configFile = Write-OpenCodeConfig $models $chosen (Join-Path $ocHome 'config')
+
     if (-not $DryRun) { Add-TodayCount }
     $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
     $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "vibe-goal-$stamp"
     New-Item -ItemType Directory -Force -Path $tmp | Out-Null
-    $last = Join-Path $tmp 'last.txt'
-    $promptFile = Join-Path $tmp 'prompt.txt'
-    Set-Content -Path $promptFile -Value $prompt -NoNewline
-    Write-Log "iteration start ($stamp)"
-
-    # Least privilege: workspace-write sandbox, writes limited to the loop's own clone and its task
-    # worktrees, network on (git, gh, package registries, research). No approval prompts because
-    # nobody is watching; blocked actions fail closed.
-    $taskRoot = "$Root.worktrees"
-    New-Item -ItemType Directory -Force -Path $taskRoot | Out-Null
-    # Sandbox settings go into a Codex profile layer: TOML lists and quotes do not survive
-    # Windows command-line parsing through the npm .cmd shim.
-    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
-    $profileName = 'vibecodium-goal'
-    $profile = @(
-      '# GENERATED by vibecodium vibe/goal/run-goal.ps1 on every iteration. Do not edit.'
-      'sandbox_mode = "workspace-write"'
-      'approval_policy = "never"'
-      ''
-      '[sandbox_workspace_write]'
-      'network_access = true'
-      ('writable_roots = ["{0}", "{1}"]' -f ($Root -replace '\\', '/'), ($taskRoot -replace '\\', '/'))
-    ) -join "`n"
-    Set-Content -Path (Join-Path $codexHome "$profileName.config.toml") -Value $profile -Encoding utf8NoBOM
-    $codexArgs = @('exec', '-C', $Root, '--enable', 'goals', '-p', $profileName, '-s', 'workspace-write', '-o', $last, '-') |
+    $promptFile = Join-Path $tmp 'continue.prompt.md'
+    Copy-Item (Join-Path $Root 'vibe\goal\continue.prompt.md') $promptFile
+    Write-Log "iteration start ($stamp) provider=$chosen model=$chosen/$($classes.standard)"
+
+    $ocArgs = @('run', '--agent', 'vibe-overseer', '-m', "$chosen/$($classes.standard)", '--dir', $Root, '-f', $promptFile,
+      'Follow the attached file exactly. It is your complete instruction set for this session.') |
       ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
     if ($DryRun) {
-      $left = @(Get-ChildItem Env: | Where-Object { $_.Name -match $secretPattern -and $_.Name -notmatch '^(GIT_CONFIG_|GH_TOKEN$)' } | ForEach-Object Name)
-      Write-Output "DRYRUN args=$($codexArgs -join ' ')"
-      Write-Output ("DRYRUN profile=" + ($profile -replace "`n", ' | '))
-      Write-Output "DRYRUN secrets_removed=$($script:SecretValues.Count) secret_vars_left=$($left.Count) gh_token_scoped=$([bool]$scopedGh)"
+      $left = @(Get-ChildItem Env: | Where-Object { $_.Name -match $secretPattern -and $_.Name -notmatch '^GIT_CONFIG_' -and $_.Name -notin ($AllowedProviderKeys + 'GH_TOKEN') } | ForEach-Object Name)
+      Write-Output "DRYRUN provider=$chosen config=$configFile"
+      Write-Output "DRYRUN args=$($ocArgs -join ' ')"
+      Write-Output "DRYRUN secrets_removed=$($script:SecretValues.Count) secret_vars_left=$($left.Count) gh_token_source=$ghSource"
       Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
       break
     }
-    $p = Start-Process -FilePath $Codex -ArgumentList ($codexArgs -join ' ') -RedirectStandardInput $promptFile `
+    $p = Start-Process -FilePath $OpenCode -ArgumentList ($ocArgs -join ' ') -WorkingDirectory $Root `
       -RedirectStandardOutput (Join-Path $tmp 'out.txt') -RedirectStandardError (Join-Path $tmp 'err.txt') -WindowStyle Hidden -PassThru
-    # codex.exe raises its own priority; keep the whole session tree below normal.
+    # Keep the whole session tree below normal priority.
     $deadline = (Get-Date).AddMinutes($IterationTimeoutMinutes)
     Start-Sleep -Seconds 5
     Set-TreeBelowNormal $p.Id
@@ -200,7 +268,7 @@ try {
     }
 
     # Keep only a short, redacted summary; raw streams never persist.
-    $result = if (Test-Path $last) { Get-Content -Raw $last } else { '' }
+    $result = if (Test-Path (Join-Path $tmp 'out.txt')) { Get-Content -Raw (Join-Path $tmp 'out.txt') } else { '' }
     $slice = if ($result -match 'SLICE_RESULT=(\w+)') { $Matches[1] } else { 'unknown' }
     $errTail = if (Test-Path (Join-Path $tmp 'err.txt')) { (Get-Content (Join-Path $tmp 'err.txt') -Tail 20) -join "`n" } else { '' }
     Write-Log ("iteration end: exit={0} slice={1} state={2}" -f $p.ExitCode, $slice, (Get-GoalState))
```
