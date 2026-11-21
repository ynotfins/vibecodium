# Proposal: Codex BYOK on OmniRoute as the primary harness; OpenCode as the fallback

- Date: 2026-11-20
- Proposer: vibe-overseer (bootstrapping session), on the owner's instruction
- Must-have IDs: E2, E4 (autonomous loop, hard stops), F2
- Locked paths: `AGENTS.md`, `docs/vibe/GOVERNANCE.md`, `vibe/goal/run-goal.ps1`, `vibe/goal/continue.prompt.md`

## Why

The owner clarified on 2026-11-20: Codex is wanted for the build loop when it runs on our own models (BYOK) and never bills the ChatGPT subscription. Verified this session: `codex exec` works end-to-end against OmniRoute's Responses API (file writes, shell, custom-agent sub-agents, Morph MCP tools) with an isolated `CODEX_HOME` that has no `auth.json`. Codex's `workspace-write` OS sandbox closes the biggest residual risk of the OpenCode-only design. Codex cannot reach Morph/DeepInfra (it no longer supports their API format), so OpenCode remains the fallback harness.

## Review history

- Round 1 (Codex BYOK, governance-verifier): FAIL. (1) an unstaged `web_search = "disabled"` edit was outside this proposal; (2) the Codex path had no mechanical hard-stop control; (3) evidence claimed 30 tests / verify PASS; (4) `continue.prompt.md` hardcoded a worktrees path.
- Round 2 fixes: `web_search` folded into this proposal; a PATH guard now enforces the same hard-stop patterns for both harnesses (shims for git, gh, npm, pnpm, yarn and hard blocks for winget, choco, schtasks, reg, diskpart); evidence corrected; prompt path generalized. `env_vars = ["MORPH_API_KEY"]` was verified live this session (Codex listed all four Morph tools).

## Change summary

- Hard-stop guard: `Write-GuardShims` puts a generated folder first on PATH. Shims forward to the real program unless the command line matches the same pattern list the OpenCode deny rules use (force-push, branch deletion, releases, repo settings, gh auth/secrets, publishing, installs, env dumps, scheduled tasks, registry, disk tools). The guard is a path-level control, not a sandbox: an absolute path to a binary would bypass it, which is recorded as a residual risk.
- Codex config sets `web_search = "disabled"` (OmniRoute cannot serve the hosted tool).
- OmniRoute classes use **pinned model ids** (`glm-5.3-flash`, `deepseek-v4.1-flash`), not combos: a combo can switch the underlying model mid-turn, which broke a live Codex session ("pinned model unavailable") and would discard provider prompt caching. Found live this session; the OmniRoute `reasoning`/`review` combos also return 503 today.
- Runner: per-provider `harness` in `vibe/goal/models.json` (`codex` for OmniRoute; `opencode` for Morph and DeepInfra — the runner refuses codex on a non-Responses provider). Codex path writes an isolated home: config.toml (provider, elevated workspace-write sandbox limited to the clone and its `.worktrees`), per-class agent TOMLs, Morph MCP via `cmd /c npx`; OpenCode path unchanged.
- Morph classes: DeepSeek V4.1 Flash for standard/cheap, GLM-5.3 for strong/review; Kimi removed per owner.
- GOVERNANCE §5: sandbox restored for the primary harness; deny list applies to the OpenCode fallback; accepted risks updated. AGENTS.md: model order note. ADR-0008 (supersedes ADR-0007).

## Evidence

- `node --test tests/vibe/automation.test.mjs`: 9/9 pass, including the guard (force-push blocked with exit 1, `gh pr list` still allowed), BYOK config, writable roots, no `auth.json`, per-class agent TOMLs, deny rules, secret removal.
- `node vibe/tools/verify.mjs`: 3/4 steps; the governance step fails only because this approval is pending (expected before approval).
- Live: `codex exec` on OmniRoute created files, ran commands, spawned a custom sub-agent and listed the Morph tools; no `auth.json`.

## Exact change

Output of `git diff --cached origin/vibe/main -- <locked paths>`:

```diff
diff --git a/AGENTS.md b/AGENTS.md
index 744b9eb..f284dab 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -41,7 +41,7 @@ The owner granted full autonomy to build to completion. Do not stop between task
 - Never write, print, log or commit a secret value. Environment variable names are fine.
 - Never edit a `locked` doc or locked file except through `governance-verifier` (GOVERNANCE §3).
 - Never hand-edit `.opencode/agent/*.md`; edit `.vibe/agents/*.md` and regenerate.
-- The build runs on our own models (OmniRoute first, Morph direct second, DeepInfra third; `vibe/goal/models.json`). Use the Morph tools for code search (WarpGrep) and edits (Fast Apply) when available.
+- The build runs on our own models: OmniRoute first through Codex BYOK, Morph direct second and DeepInfra third through OpenCode (`vibe/goal/models.json`, ADR-0008). Use the Morph tools for code search (WarpGrep) and edits (Fast Apply) when available.
 - `master` mirrors `VSCodium/vscodium` only. Product work lands on `vibe/main` by PR.
 - Library and API facts come from live sources (release pages, registries, official docs), not memory. Record versions in `docs/vibe/TECH_RADAR.md`.
 - New dependencies: permissive license, pinned version and checksum, public for at least 7 days, radar row added.
diff --git a/docs/vibe/GOVERNANCE.md b/docs/vibe/GOVERNANCE.md
index caba6d7..7ba404c 100644
--- a/docs/vibe/GOVERNANCE.md
+++ b/docs/vibe/GOVERNANCE.md
@@ -35,7 +35,7 @@ Honest limit: this is a process lock, not a security boundary. A determined agen
 
 ## 4. The after-every-task chain
 
-Every task slice, by any agent, ends with this chain before it is committed. Each guardian is a separate sub-agent defined in `.vibe/agents/` (OpenCode copies are generated into `.opencode/agent/`; each declares a model class that the runner maps to one of our models).
+Every task slice, by any agent, ends with this chain before it is committed. Each guardian is a separate sub-agent defined in `.vibe/agents/` (generated for the active harness by the runner; OpenCode copies for interactive use live in `.opencode/agent/`). Each declares a model class that the runner maps to one of our models.
 
 | Order | Guardian | Runs when | Blocks on |
 |---|---|---|---|
@@ -59,22 +59,24 @@ The owner granted full autonomy for the build (UNLOCK of `D:\vscodium\AGENTS.md`
 
 ### Enforcement
 
-Instructions alone are not a boundary, so the loop is also constrained mechanically. The loop runs on our own models through OpenCode (ADR-0007); OpenCode has no operating-system sandbox, so the controls are:
+Instructions alone are not a boundary, so the loop is also constrained mechanically. The loop runs on our own models (ADR-0008): OmniRoute first through **Codex BYOK** (with the OS sandbox), the fallback providers through OpenCode. The controls are:
 
-- The goal loop runs in a dedicated clone used by nothing else, so a mistake cannot touch the owner's other checkouts through git.
-- Secret-looking environment variables (API keys, tokens, passwords, database URLs) are removed from the runner before OpenCode starts. Only the model-provider keys the runner allows (OmniRoute, Morph, DeepInfra) and `GH_TOKEN` are passed on. `GH_TOKEN` comes from a fine-grained token scoped to this repository (`VIBECODIUM_GH_TOKEN`) when the owner has created one; otherwise the runner falls back to the owner's `GITHUB_TOKEN` and logs a warning.
-- OpenCode runs with its own generated config and data folders, so the owner's MCP servers, global rules and session history are neither loaded nor modified.
-- Hard-stop shell commands are denied by OpenCode permission rules: force-push and remote branch deletion, release creation or editing, repository deletion or settings, GitHub auth and secrets, package publishing, software installs, environment dumps, global git config, scheduled tasks, registry edits and recursive deletes of system paths.
+- The goal loop runs in a dedicated clone used by nothing else.
+- On OmniRoute, Codex runs in the `workspace-write` sandbox with writes limited to that clone and its `.worktrees` folder; the owner's other checkouts and files cannot be modified. Codex uses its own home folder with no subscription login (`auth.json` can never exist; the runner refuses to start if one appears), so the ChatGPT subscription cannot be billed.
+- Hard-stop commands are blocked on **both** harnesses: force-push and remote branch deletion, release creation or editing, repository deletion or settings, GitHub auth and secrets, package publishing, software installs, environment dumps, global git config, scheduled tasks, registry edits and recursive deletes of system paths. OpenCode denies them through its permission rules; for Codex a generated guard folder goes first on PATH with shims (git, gh, npm, pnpm, yarn) that refuse matching command lines, and hard blocks for winget, choco, schtasks, reg and diskpart.
+- The fallback harness (OpenCode, for Morph/DeepInfra, which Codex cannot reach) has no OS sandbox; the guard and its deny rules are its main mechanical control.
+- Secret-looking environment variables (API keys, tokens, passwords, database URLs) are removed from the runner before the agent starts. Only the model-provider keys the runner allows (OmniRoute, Morph, DeepInfra) and `GH_TOKEN` are passed on. `GH_TOKEN` comes from a fine-grained token scoped to this repository (`VIBECODIUM_GH_TOKEN`) when the owner has created one; otherwise the runner falls back to the owner's `GITHUB_TOKEN` and logs a warning.
+- Both harnesses run with their own generated config, home and data folders, so the owner's MCP servers, global rules and session history are neither loaded nor modified.
 - GitHub branch protection on `master` and `vibe/main` forbids force-pushes and branch deletion.
 - Runner logs keep only short summaries with secret values redacted; raw agent event streams are never written to disk. Logs are deleted after 14 days.
 
-Accepted residual risks (owner decision 2026-11-20: run the build on our own models instead of a sandboxed vendor agent):
+Accepted residual risks (owner decision 2026-11-20: run the build on our own models):
 
-- No operating-system sandbox: a shell command that the deny list does not anticipate can write anywhere the owner's account can. `tech-scout` evaluates sandbox-runtime for the loop at M6 start, when the product needs it anyway.
+- During fallback windows (OmniRoute down), no operating-system sandbox: a shell command that the deny list does not anticipate can write anywhere the owner's account can. `tech-scout` evaluates sandbox-runtime for the loop at M6 start, when the product needs it anyway.
 - Network access is open, not allowlisted, because research, package registries and provider docs are part of the work. Prompt injection from web content could cause outbound requests.
 - The model-provider keys and the GitHub credential are readable by the agent. Scope GitHub with `VIBECODIUM_GH_TOKEN` to limit the blast radius; provider keys should carry spending limits at the provider.
 - The runner and the lock live in the same user-writable clone and the scheduled task uses `-ExecutionPolicy Bypass` (required by the workstation's silent-automation policy). A process already running as the owner could replace both; that attacker already controls the account, so script signing would add little.
-- The in-product quarantine of untrusted content (SECURITY.md) lands with M6; until then the build loop relies on secret removal, the deny list and server-side branch protection.
+- The in-product quarantine of untrusted content (SECURITY.md) lands with M6; until then the build loop relies on the sandbox (or deny list), secret removal and server-side branch protection.
 
 ### Hard stops (always pause, in every mode)
 
diff --git a/vibe/goal/continue.prompt.md b/vibe/goal/continue.prompt.md
index a365a59..46f82b6 100644
--- a/vibe/goal/continue.prompt.md
+++ b/vibe/goal/continue.prompt.md
@@ -1,9 +1,10 @@
-You are the vibe-overseer for the Vibecodium build, running unattended inside an autonomous goal loop. No human will answer questions during this session. You run on our own models through OpenCode; every guardian is an OpenCode subagent defined in .opencode/agent/ (generated from .vibe/agents/).
+You are the vibe-overseer for the Vibecodium build, running unattended inside an autonomous goal loop. No human will answer questions during this session. The loop runs on our own models (see vibe/goal/models.json); every guardian is a sub-agent defined once in .vibe/agents/ (generated for the active harness).
 
 1. Read AGENTS.md, vibe/goal/GOAL.md, docs/vibe/GOVERNANCE.md, docs/vibe/STATUS.md and docs/vibe/ROADMAP.md.
 2. If STATUS.md says "Goal state: complete" or "Goal state: blocked", verify that claim, print GOAL_STATE=<state> and stop.
-3. Do exactly one task slice following the "One task slice" procedure in .vibe/agents/vibe-overseer.md. Launch each guardian in docs/vibe/GOVERNANCE.md section 4 as a separate subagent (qa-verifier, drift-sentinel, security-reviewer, docs-keeper, governance-verifier, tech-scout, release-manager) and wait for its report.
-4. Prefer the Morph tools: morph_codebase_search (WarpGrep) to find code, morph_edit_file (Fast Apply) for edits to existing files, morph_github_codebase_search to study other repositories.
-5. Never cross a hard stop in docs/vibe/GOVERNANCE.md section 5. Some hard-stop commands are blocked; do not try to work around a blocked command. Park business decisions in STATUS.md and continue with other unblocked work.
-6. Before finishing: node vibe/tools/verify.mjs must pass on the trunk, the STATUS entry must be written, and the branch must be pushed with a PR opened into vibe/main (gh pr create --repo ynotfins/vibecodium --base vibe/main). Merge it when CI is green (gh pr merge --merge).
-7. End your final message with one line: SLICE_RESULT=done|parked|failed and GOAL_STATE=active|complete|blocked.
+3. Do exactly one task slice following the "One task slice" procedure in .vibe/agents/vibe-overseer.md. Launch each guardian in docs/vibe/GOVERNANCE.md section 4 as a separate sub-agent (qa-verifier, drift-sentinel, security-reviewer, docs-keeper, governance-verifier, tech-scout, release-manager) and wait for its report.
+4. Prefer the Morph tools: codebase search (WarpGrep) to find code, edit_file (Fast Apply) for edits to existing files, github_codebase_search to study other repositories.
+5. Your task workspace must be a clone or worktree under <clone>.worktrees (the clone's sibling folder) - files there are writable; the trunk's own files may be read-only to you.
+6. Never cross a hard stop in docs/vibe/GOVERNANCE.md section 5. Some hard-stop commands are blocked or outside your writable area; do not try to work around a refusal. Park business decisions in STATUS.md and continue with other unblocked work.
+7. Before finishing: node vibe/tools/verify.mjs must pass on the trunk, the STATUS entry must be written, and the branch must be pushed with a PR opened into vibe/main (gh pr create --repo ynotfins/vibecodium --base vibe/main). Merge it when CI is green (gh pr merge --merge).
+8. End your final message with one line: SLICE_RESULT=done|parked|failed and GOAL_STATE=active|complete|blocked.
diff --git a/vibe/goal/run-goal.ps1 b/vibe/goal/run-goal.ps1
index 8167c05..e48c59c 100644
--- a/vibe/goal/run-goal.ps1
+++ b/vibe/goal/run-goal.ps1
@@ -1,13 +1,13 @@
 <#
 .SYNOPSIS
-  Autonomous goal loop for the Vibecodium build (ADR-0007).
+  Autonomous goal loop for the Vibecodium build (ADR-0008).
 
 .DESCRIPTION
-  Each iteration starts a fresh OpenCode session (`opencode run --agent vibe-overseer`) in the
-  dedicated clone with vibe/goal/continue.prompt.md attached. The session does one task slice and
-  records state in the repo. Models are our own, chosen per iteration from vibe/goal/models.json:
-  the first provider in "order" that answers a health check (OmniRoute, then Morph direct, then
-  DeepInfra). Each guardian sub-agent gets the model for its model_class.
+  Each iteration starts a fresh agent session in the dedicated clone. The harness depends on the
+  chosen provider (vibe/goal/models.json): OmniRoute (forced unless unavailable) runs Codex BYOK
+  with the OS sandbox; the fallbacks (Morph direct, DeepInfra) run OpenCode, because Codex does not
+  support their API format. Guardians are sub-agents; each gets the model for its model_class.
+  The Morph tools (WarpGrep, Fast Apply, GitHub search) are configured for both harnesses.
 
   The loop stops when docs/vibe/STATUS.md says "Goal state: complete" or "Goal state: blocked",
   when the daily iteration cap is reached, when no provider answers, after repeated failures, or
@@ -16,11 +16,12 @@
 
   Isolation (docs/vibe/GOVERNANCE.md §5 "Enforcement"):
   - Root is a dedicated clone used only by the loop.
-  - Every secret-looking environment variable is removed before OpenCode starts, except the model
+  - Every secret-looking environment variable is removed before the agent starts, except the model
     provider keys in $AllowedProviderKeys and GH_TOKEN. GH_TOKEN comes from VIBECODIUM_GH_TOKEN
     (a fine-grained token scoped to ynotfins/vibecodium) when it exists.
-  - OpenCode runs with its own generated config and data folders (no user config, MCP servers or
-    history leak in) and with deny rules for hard-stop shell commands.
+  - Codex runs with its own home folder (no subscription login, no user config) and writes limited
+    to the clone and its .worktrees folder; OpenCode runs with its own config and data folders and
+    a hard-stop deny list. Neither can see the owner's normal agent setup.
 
 .PARAMETER Root
   Dedicated clone of ynotfins/vibecodium, checked out on vibe/main.
@@ -31,6 +32,7 @@ param(
   [int]$MaxIterationsPerDay = 24,
   [int]$IterationTimeoutMinutes = 180,
   [int]$MaxConsecutiveFailures = 3,
+  [string]$Codex = '',
   [string]$OpenCode = '',
   # Use this provider from vibe/goal/models.json instead of health-checking (tests, manual runs).
   [string]$Provider = '',
@@ -46,12 +48,16 @@ function Write-Log([string]$m) { Add-Content -Path $log -Value ("{0}  {1}" -f (G
 
 try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch { }
 
+if (-not $Codex) { $Codex = (Get-Command codex.cmd -ErrorAction Stop).Source }
 if (-not $OpenCode) { $OpenCode = (Get-Command opencode -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
 
-# Git uses the GitHub CLI (and therefore GH_TOKEN) as its credential helper, for this process tree only.
-$env:GIT_CONFIG_COUNT = '2'
+# Git uses the GitHub CLI (and therefore GH_TOKEN) as its credential helper, for this process tree
+# only. OpenSSL is used because the elevated Codex sandbox cannot use Windows certificate channels.
+$env:GIT_CONFIG_COUNT = '3'
 $env:GIT_CONFIG_KEY_0 = 'credential.helper'; $env:GIT_CONFIG_VALUE_0 = ''
 $env:GIT_CONFIG_KEY_1 = 'credential.helper'; $env:GIT_CONFIG_VALUE_1 = '!gh auth git-credential'
+$env:GIT_CONFIG_KEY_2 = 'safe.directory'; $env:GIT_CONFIG_VALUE_2 = '*'
+$env:GIT_SSL_BACKEND = 'openssl'
 
 # Single instance.
 $lockFile = Join-Path $LogDir 'runner.lock'
@@ -125,13 +131,15 @@ function Add-TodayCount {
 function Get-Models {
   $models = Get-Content -Raw (Join-Path $Root 'vibe\goal\models.json') | ConvertFrom-Json
   foreach ($name in $models.order) {
-    $k = $models.providers.$name.keyEnv
-    if ($k -notin $AllowedProviderKeys) { throw "models.json: provider '$name' uses key '$k', which the runner does not allow" }
+    $p = $models.providers.$name
+    if ($p.keyEnv -notin $AllowedProviderKeys) { throw "models.json: provider '$name' uses key '$($p.keyEnv)', which the runner does not allow" }
+    if ($p.harness -notin 'codex', 'opencode') { throw "models.json: provider '$name' must set harness to 'codex' or 'opencode'" }
+    if ($p.harness -eq 'codex' -and $name -ne 'omniroute') { throw "models.json: '$name' cannot use the codex harness; Codex does not support its API format (OmniRoute only)" }
   }
   return $models
 }
 
-# First provider in models.order whose /models endpoint answers.
+# First provider in models.order whose /models endpoint answers. OmniRoute is forced unless down.
 function Select-Provider($models) {
   if ($Provider) { return $Provider }
   foreach ($name in $models.order) {
@@ -146,8 +154,7 @@ function Select-Provider($models) {
   return $null
 }
 
-# Hard-stop shell commands are denied (docs/vibe/GOVERNANCE.md §5). A deny list is not a sandbox;
-# the accepted residual risk is documented in GOVERNANCE.md.
+# Hard-stop shell commands are denied in the OpenCode fallback (docs/vibe/GOVERNANCE.md §5).
 $DeniedCommands = @(
   'git push --force*', 'git push -f*', 'git push * --force*', 'git push * -f*', 'git push --delete*', 'git push * --delete*', 'git push * :*',
   'git config --global*', 'git config --system*',
@@ -160,7 +167,111 @@ $DeniedCommands = @(
   'rm -rf /*', 'rm -rf ~*', 'rm -rf C:*', 'rm -rf /c*', 'rm -rf /d*', 'Remove-Item * -Recurse* C:\*'
 )
 
-# Generated OpenCode config: our providers, per-agent models, the Morph MCP tools, deny rules.
+# Mechanical hard-stop guard for both harnesses. The OpenCode config denies these patterns directly;
+# Codex has no deny rules, so a guard folder is put first on PATH with shims for the commands that can
+# cross a hard stop. Shims forward to the real executable after checking the same pattern list.
+function Write-GuardShims([string]$dir) {
+  New-Item -ItemType Directory -Force -Path $dir | Out-Null
+  Set-Content -Path (Join-Path $dir 'deny.txt') -Value ($DeniedCommands | ConvertTo-Json) -Encoding utf8NoBOM
+  $guardPs1 = @'
+param([string]$Cmd, [string]$Real, [string]$Mode, [Parameter(ValueFromRemainingArguments = $true)] [string[]]$Rest)
+$line = (@($Cmd) + $Rest) -join ' '
+if ($Mode -eq 'always') { [Console]::Error.WriteLine("Vibecodium guard: '$Cmd' is blocked in the build loop"); exit 1 }
+foreach ($p in (Get-Content -Raw (Join-Path $PSScriptRoot 'deny.txt') | ConvertFrom-Json)) {
+  if ($line -like $p) { [Console]::Error.WriteLine("Vibecodium guard: blocked hard-stop command: $line"); exit 1 }
+}
+& $Real @Rest
+exit $LASTEXITCODE
+'@
+  Set-Content -Path (Join-Path $dir 'guard.ps1') -Value $guardPs1 -Encoding utf8NoBOM
+  # Resolve the real programs before this folder joins PATH.
+  $targets = [ordered]@{
+    git = @{ mode = 'check' }; gh = @{ mode = 'check' }; npm = @{ mode = 'check' }; pnpm = @{ mode = 'check' }; yarn = @{ mode = 'check' }
+    winget = @{ mode = 'always' }; choco = @{ mode = 'always' }; schtasks = @{ mode = 'always' }; reg = @{ mode = 'always' }; diskpart = @{ mode = 'always' }
+  }
+  $pwshPath = (Get-Process -Id $PID).Path
+  foreach ($name in $targets.Keys) {
+    $real = $null
+    foreach ($ext in '.exe', '.cmd', '.bat') {
+      $c = Get-Command ($name + $ext) -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike "$dir*" } | Select-Object -First 1
+      if ($c) { $real = $c.Source; break }
+    }
+    if (-not $real -and $targets[$name].mode -eq 'check') { continue }
+    $shim = "@echo off`r`n`"$pwshPath`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0guard.ps1`" $name `"$real`" $($targets[$name].mode) %*`r`n"
+    Set-Content -Path (Join-Path $dir "$name.cmd") -Value $shim -Encoding ascii
+  }
+  return $dir
+}
+
+function Get-AgentDefs {
+  $defs = @()
+  foreach ($f in Get-ChildItem (Join-Path $Root '.vibe\agents') -Filter *.md) {
+    $t = Get-Content -Raw $f.FullName
+    $defs += [pscustomobject]@{
+      name = $f.BaseName
+      model_class = ([regex]::Match($t, '(?m)^model_class:\s*(\w+)')).Groups[1].Value
+      sandbox = ([regex]::Match($t, '(?m)^sandbox:\s*(\S+)')).Groups[1].Value
+      description = ([regex]::Match($t, '(?m)^description:\s*(.+)$')).Groups[1].Value.Trim()
+      body = ([regex]::Match($t, '(?s)---.*?---\s*(.+)$')).Groups[1].Value.Trim()
+    }
+  }
+  return $defs
+}
+
+# Codex gets its own home folder: no subscription login (auth.json can never exist there), no user
+# config, generated agents TOML with the model for each class, the Morph tools through cmd (npx is a
+# .cmd script on Windows), writes limited to the clone and its .worktrees folder.
+function Write-CodexConfig($models, [string]$chosen, [string]$codexHome) {
+  $defs = Get-AgentDefs
+  $p = $models.providers.$chosen
+  $classes = $p.classes
+  $rootToml = $Root -replace '\\', '/'
+  $worktrees = $rootToml + '.worktrees'
+  New-Item -ItemType Directory -Force -Path (Join-Path $codexHome 'agents') | Out-Null
+  $cfg = @"
+model_provider = "$chosen"
+model = "$($classes.standard)"
+approval_policy = "never"
+sandbox_mode = "workspace-write"
+web_search = "disabled"
+
+[sandbox_workspace_write]
+network_access = true
+writable_roots = ["$rootToml", "$worktrees"]
+
+[windows]
+sandbox = "elevated"
+
+[model_providers.$chosen]
+name = "$($p.name)"
+base_url = "$($p.baseURL)"
+wire_api = "responses"
+env_key = "$($p.keyEnv)"
+requires_openai_auth = false
+
+[mcp_servers.morph]
+command = "cmd"
+args = ["/c", "npx", "-y", "@morphllm/morphmcp@$($models.morphMcpVersion)"]
+env_vars = ["MORPH_API_KEY"]
+startup_timeout_sec = 60
+"@
+  Set-Content -Path (Join-Path $codexHome 'config.toml') -Value $cfg -Encoding utf8NoBOM
+  foreach ($a in $defs) {
+    $toml = @"
+name = "$($a.name)"
+description = "$($a.description.Replace('"', '\"'))"
+model = "$($classes.($a.model_class))"
+sandbox_mode = "$(if ($a.sandbox -eq 'read-only') { 'read-only' } else { 'workspace-write' })"
+developer_instructions = '''
+$($a.body)
+'''
+"@
+    Set-Content -Path (Join-Path $codexHome "agents\$($a.name).toml") -Value $toml -Encoding utf8NoBOM
+  }
+  return $codexHome
+}
+
+# Generated OpenCode config (fallback harness): our providers, per-agent models, Morph tools, denies.
 function Write-OpenCodeConfig($models, [string]$chosen, [string]$configDir) {
   $providers = [ordered]@{}
   foreach ($name in $models.order) {
@@ -171,10 +282,7 @@ function Write-OpenCodeConfig($models, [string]$chosen, [string]$configDir) {
   }
   $classes = $models.providers.$chosen.classes
   $agents = [ordered]@{}
-  foreach ($f in Get-ChildItem (Join-Path $Root '.vibe\agents') -Filter *.md) {
-    $mc = (Select-String -Path $f.FullName -Pattern '^model_class:\s*(\w+)' | Select-Object -First 1).Matches[0].Groups[1].Value
-    $agents[$f.BaseName] = @{ model = "$chosen/$($classes.$mc)" }
-  }
+  foreach ($a in (Get-AgentDefs)) { $agents[$a.name] = @{ model = "$chosen/$($classes.($a.model_class))" } }
   $agents['compaction'] = @{ model = "$chosen/$($classes.cheap)" }
   $bash = [ordered]@{ '*' = 'allow' }
   foreach ($d in $DeniedCommands) { $bash[$d] = 'deny' }
@@ -186,7 +294,7 @@ function Write-OpenCodeConfig($models, [string]$chosen, [string]$configDir) {
     share = 'disabled'
     provider = $providers
     agent = $agents
-    mcp = @{ morph = [ordered]@{ type = 'local'; command = @('npx', '-y', "@morphllm/morphmcp@$($models.morphMcpVersion)"); environment = @{ MORPH_API_KEY = '{env:MORPH_API_KEY}' }; enabled = $true } }
+    mcp = @{ morph = [ordered]@{ type = 'local'; command = @('cmd', '/c', 'npx', '-y', "@morphllm/morphmcp@$($models.morphMcpVersion)"); environment = @{ MORPH_API_KEY = '{env:MORPH_API_KEY}' }; enabled = $true } }
     permission = [ordered]@{ edit = 'allow'; webfetch = 'allow'; external_directory = 'allow'; doom_loop = 'allow'; bash = $bash }
   }
   New-Item -ItemType Directory -Force -Path (Join-Path $configDir 'opencode') | Out-Null
@@ -226,35 +334,63 @@ try {
     $chosen = Select-Provider $models
     if (-not $chosen) { Write-Log 'no model provider answered; stopping until the next scheduled start'; break }
     $classes = $models.providers.$chosen.classes
+    $harness = $models.providers.$chosen.harness
 
-    # Own config and data folders: no user config, MCP servers or session history leak in or out.
-    $ocHome = Join-Path $LogDir 'opencode-home'
-    $env:XDG_CONFIG_HOME = (Join-Path $ocHome 'config') -replace '\\', '/'
-    $env:XDG_DATA_HOME = (Join-Path $ocHome 'data') -replace '\\', '/'
-    $configFile = Write-OpenCodeConfig $models $chosen (Join-Path $ocHome 'config')
-
-    if (-not $DryRun) { Add-TodayCount }
     $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
     $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "vibe-goal-$stamp"
     New-Item -ItemType Directory -Force -Path $tmp | Out-Null
     $promptFile = Join-Path $tmp 'continue.prompt.md'
     Copy-Item (Join-Path $Root 'vibe\goal\continue.prompt.md') $promptFile
-    Write-Log "iteration start ($stamp) provider=$chosen model=$chosen/$($classes.standard)"
 
-    # The message must come before -f: OpenCode's -f takes every following positional as a file.
-    $ocArgs = @('run', 'Follow the attached file exactly. It is your complete instruction set for this session.',
-      '--agent', 'vibe-overseer', '-m', "$chosen/$($classes.standard)", '--dir', $Root, '-f', $promptFile) |
-      ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
+    if ($harness -eq 'codex') {
+      # Own home folder; auth.json must never exist here (a subscription cannot be used).
+      $env:CODEX_HOME = Join-Path $LogDir 'codex-home'
+      Write-CodexConfig $models $chosen $env:CODEX_HOME | Out-Null
+      if (Test-Path (Join-Path $env:CODEX_HOME 'auth.json')) { Write-Log 'refusing: auth.json in the loop Codex home (would use the subscription)'; break }
+      $exe = $Codex
+      $cmdArgs = "exec -C `"$Root`" --skip-git-repo-check"
+      $stdinFile = $promptFile
+      $modelDesc = "$chosen/$($classes.standard) (codex BYOK)"
+      Remove-Item Env:XDG_CONFIG_HOME, Env:XDG_DATA_HOME -ErrorAction SilentlyContinue
+    } else {
+      # Own config and data folders: no user config, MCP servers or session history leak in or out.
+      $ocHome = Join-Path $LogDir 'opencode-home'
+      $env:XDG_CONFIG_HOME = (Join-Path $ocHome 'config') -replace '\\', '/'
+      $env:XDG_DATA_HOME = (Join-Path $ocHome 'data') -replace '\\', '/'
+      Write-OpenCodeConfig $models $chosen (Join-Path $ocHome 'config') | Out-Null
+      $exe = $OpenCode
+      # The message must come before -f: OpenCode's -f takes every following positional as a file.
+      $cmdArgs = 'run "Follow the attached file exactly. It is your complete instruction set for this session." ' +
+        "--agent vibe-overseer -m $chosen/$($classes.standard) --dir `"$Root`" -f `"$promptFile`""
+      $stdinFile = $null
+      $modelDesc = "$chosen/$($classes.standard) (opencode)"
+    }
+
+    $guardDir = Write-GuardShims (Join-Path $LogDir 'guard')
+    $env:PATH = "$guardDir;$env:PATH"
+
+    if (-not $DryRun) { Add-TodayCount }
+    Write-Log "iteration start ($stamp) harness=$harness provider=$chosen model=$modelDesc"
+
     if ($DryRun) {
       $left = @(Get-ChildItem Env: | Where-Object { $_.Name -match $secretPattern -and $_.Name -notmatch '^GIT_CONFIG_' -and $_.Name -notin ($AllowedProviderKeys + 'GH_TOKEN') } | ForEach-Object Name)
-      Write-Output "DRYRUN provider=$chosen config=$configFile"
-      Write-Output "DRYRUN args=$($ocArgs -join ' ')"
+      Write-Output "DRYRUN harness=$harness provider=$chosen guard=$guardDir"
+      Write-Output "DRYRUN args=$cmdArgs stdin=$stdinFile"
       Write-Output "DRYRUN secrets_removed=$($script:SecretValues.Count) secret_vars_left=$($left.Count) gh_token_source=$ghSource"
       Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
       break
     }
-    $p = Start-Process -FilePath $OpenCode -ArgumentList ($ocArgs -join ' ') -WorkingDirectory $Root `
-      -RedirectStandardOutput (Join-Path $tmp 'out.txt') -RedirectStandardError (Join-Path $tmp 'err.txt') -WindowStyle Hidden -PassThru
+    $startArgs = @{
+      FilePath = $exe
+      ArgumentList = $cmdArgs
+      WorkingDirectory = $Root
+      RedirectStandardOutput = Join-Path $tmp 'out.txt'
+      RedirectStandardError = Join-Path $tmp 'err.txt'
+      WindowStyle = 'Hidden'
+      PassThru = $true
+    }
+    if ($stdinFile) { $startArgs.RedirectStandardInput = $stdinFile }
+    $p = Start-Process @startArgs
     # Keep the whole session tree below normal priority.
     $deadline = (Get-Date).AddMinutes($IterationTimeoutMinutes)
     Start-Sleep -Seconds 5
```
