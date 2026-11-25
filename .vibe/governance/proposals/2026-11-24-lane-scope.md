# Proposal: per-lane scope for the goal loop

- Date: 2026-11-24
- Proposer: vibe-overseer (operator session)
- Must-have IDs: E2 (autonomous loop), F2
- Locked paths: `vibe/goal/run-goal.ps1`, `vibe/goal/continue.prompt.md`, `vibe/goal/Register-GoalRunner.ps1`

## Problem

One runner means one slice at a time, and a second clone would read the same STATUS/ROADMAP and pick the same
next task, duplicating work and colliding at merge. The owner approved two lanes (A: M5→M6 harness; B: M2+M3
gateway and local runtime) and that needs a per-lane scope.

## Review history

- Round 2 (Codex BYOK verifier): FAIL — (b) the test was a source-string grep, not a functional test of the
  prompt assembly; the Evidence section said 9 pass while the suite was 10; and `Register-GoalRunner.ps1`
  exposed no `-LogDir`, so two default-registered lanes would share one lock/counter directory. Round 3 fixes
  all three: `-KeepTemp` keeps the assembled prompt so a test can read it and assert the `## LANE SCOPE`
  section and its content (and that no scope file means no injected content); evidence updated; the
  registration script gains `-LogDir` and passes it through.

- Round 1 (Codex BYOK verifier): FAIL on four points, all fixed here: ADR-0006's stale "fixed continuation
  prompt" sentence; no test for the behaviour; no STATUS task card; and a partly wrong concurrency premise.
  The premise is now stated precisely: `runner.lock` and the daily counter both live under the lane's own
  `-LogDir`, so lanes with **different** log directories do not serialize. Same-directory lanes still do.

## Change

- `run-goal.ps1`: if `<clone>.lane-scope.md` exists **beside** the clone (never inside it, so the clone stays
  clean and can fast-forward), append it to the session prompt under a `## LANE SCOPE` heading.
- `continue.prompt.md`: step 1 states that a `## LANE SCOPE` section is binding, and that cross-scope work is
  parked rather than done.

## Why beside the clone

A file inside the clone would show as an untracked change, and the runner refuses to refresh trunk when the
working tree is dirty — it would stall both lanes. A sibling file is invisible to git and to the governance
lock.

## Evidence

- `node --test tests/vibe/automation.test.mjs` → 10 pass, including a functional test that runs the runner with `-DryRun -KeepTemp`, reads the assembled prompt, and asserts the scope section and content are present (and absent without a scope file).

## Exact change

Output of `git diff --cached origin/vibe/main -- vibe/goal/run-goal.ps1 vibe/goal/continue.prompt.md`:

```diff
diff --git a/vibe/goal/Register-GoalRunner.ps1 b/vibe/goal/Register-GoalRunner.ps1
index da0e3f3..d7c1c56 100644
--- a/vibe/goal/Register-GoalRunner.ps1
+++ b/vibe/goal/Register-GoalRunner.ps1
@@ -11,6 +11,8 @@
 #>
 param(
   [Parameter(Mandatory)] [string]$Root,
+  # Separate lanes must not share a log directory: the runner lock and the daily counter live there.
+  [string]$LogDir = '',
   [switch]$Unregister,
   [string]$TaskName = 'Vibecodium Goal Runner'
 )
@@ -39,6 +41,7 @@ $conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
 # task scripts. Mitigations: the runner, its prompt and this script are governance-locked files, and
 # the runner refuses to start a session when the governance check fails.
 $argLine = "--headless `"$pwsh`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Root `"$Root`""
+if ($LogDir) { $argLine += " -LogDir `"$LogDir`"" }
 $action = New-ScheduledTaskAction -Execute $conhost -Argument $argLine -WorkingDirectory $Root
 $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
 $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
diff --git a/vibe/goal/continue.prompt.md b/vibe/goal/continue.prompt.md
index 46f82b6..46e0dde 100644
--- a/vibe/goal/continue.prompt.md
+++ b/vibe/goal/continue.prompt.md
@@ -1,6 +1,7 @@
 You are the vibe-overseer for the Vibecodium build, running unattended inside an autonomous goal loop. No human will answer questions during this session. The loop runs on our own models (see vibe/goal/models.json); every guardian is a sub-agent defined once in .vibe/agents/ (generated for the active harness).
 
 1. Read AGENTS.md, vibe/goal/GOAL.md, docs/vibe/GOVERNANCE.md, docs/vibe/STATUS.md and docs/vibe/ROADMAP.md.
+   If this file ends with a `## LANE SCOPE` section, that section is binding: work only on the milestones it names, do not start work outside it, and record any cross-scope work you notice under "Parked for owner" in STATUS.md instead of doing it.
 2. If STATUS.md says "Goal state: complete" or "Goal state: blocked", verify that claim, print GOAL_STATE=<state> and stop.
 3. Do exactly one task slice following the "One task slice" procedure in .vibe/agents/vibe-overseer.md. Launch each guardian in docs/vibe/GOVERNANCE.md section 4 as a separate sub-agent (qa-verifier, drift-sentinel, security-reviewer, docs-keeper, governance-verifier, tech-scout, release-manager) and wait for its report.
 4. Prefer the Morph tools: codebase search (WarpGrep) to find code, edit_file (Fast Apply) for edits to existing files, github_codebase_search to study other repositories.
diff --git a/vibe/goal/run-goal.ps1 b/vibe/goal/run-goal.ps1
index 5826971..1d60a1d 100644
--- a/vibe/goal/run-goal.ps1
+++ b/vibe/goal/run-goal.ps1
@@ -37,7 +37,9 @@ param(
   # Use this provider from vibe/goal/models.json instead of health-checking (tests, manual runs).
   [string]$Provider = '',
   # Print the session command line, the chosen provider and the environment check, then exit.
-  [switch]$DryRun
+  [switch]$DryRun,
+  # Keep the temporary prompt so tests can inspect the assembled session prompt.
+  [switch]$KeepTemp
 )
 
 $ErrorActionPreference = 'Stop'
@@ -360,6 +362,13 @@ try {
     New-Item -ItemType Directory -Force -Path $tmp | Out-Null
     $promptFile = Join-Path $tmp 'continue.prompt.md'
     Copy-Item (Join-Path $Root 'vibe\goal\continue.prompt.md') $promptFile
+    # Optional lane scope: <clone>.lane-scope.md sits beside the clone (never inside it, so the clone
+    # stays clean and can fast-forward). It restricts the session to named milestones.
+    $laneScope = $Root + '.lane-scope.md'
+    if (Test-Path -LiteralPath $laneScope) {
+      Add-Content -Path $promptFile -Value "`n## LANE SCOPE`n" -Encoding utf8NoBOM
+      Get-Content -LiteralPath $laneScope | Add-Content -Path $promptFile -Encoding utf8NoBOM
+    }
 
     if ($harness -eq 'codex') {
       # Own home folder; auth.json must never exist here (a subscription cannot be used).
@@ -395,9 +404,10 @@ try {
     if ($DryRun) {
       $left = @(Get-ChildItem Env: | Where-Object { $_.Name -match $secretPattern -and $_.Name -notmatch '^GIT_CONFIG_' -and $_.Name -notin ($AllowedProviderKeys + 'GH_TOKEN') } | ForEach-Object Name)
       Write-Output "DRYRUN harness=$harness provider=$chosen guard=$guardDir"
+      Write-Output "DRYRUN prompt=$promptFile"
       Write-Output "DRYRUN args=$cmdArgs stdin=$stdinFile"
       Write-Output "DRYRUN secrets_removed=$($script:SecretValues.Count) secret_vars_left=$($left.Count) gh_token_source=$ghSource"
-      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
+      if (-not $KeepTemp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
       break
     }
     $startArgs = @{
@@ -431,7 +441,7 @@ try {
     Write-Log ("iteration end: exit={0} slice={1} state={2}" -f $p.ExitCode, $slice, (Get-GoalState))
     if ($slice -notin 'done', 'parked' -and $errTail) { Write-Log ("stderr tail:`n" + (Protect-Text $errTail)) }
     Set-Content -Path (Join-Path $LogDir "summary-$stamp.txt") -Value (Protect-Text (($result -split "`n" | Select-Object -Last 40) -join "`n"))
-    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
+    if (-not $KeepTemp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
 
     if ($slice -in 'done', 'parked') { $failures = 0 } else { $failures++ }
     if ($failures -ge $MaxConsecutiveFailures) { Write-Log "$failures consecutive failed iterations; stopping until next scheduled start"; break }
```
