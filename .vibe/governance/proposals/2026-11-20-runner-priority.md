# Proposal: keep the goal session below normal priority and pick up runner updates

- Date: 2026-11-20
- Proposer: vibe-overseer (bootstrapping session)
- Must-have IDs: E2 (autonomous loop); F2
- Locked path: `vibe/goal/run-goal.ps1`

## Problem

1. Observed on the first live run: `codex.exe` raises its own process priority to AboveNormal. The workstation's silent-automation policy requires long background jobs to run below normal priority, and the runner only lowered the direct child (`cmd.exe`).
2. The runner loops in one PowerShell process, so a merged change to `run-goal.ps1` would not take effect until the process exits.

## Change

Working-tree diff of `vibe/goal/run-goal.ps1` on branch `vibe/f0/runner-priority`:

- New helpers `Get-TreeIds` and `Set-TreeBelowNormal`. The runner waits for the session in 30-second steps and lowers every process in the session tree to BelowNormal each step (Idle is left alone). The iteration timeout is unchanged.
- The runner records its own file hash at start and exits cleanly at the top of the loop, after refreshing trunk, when the hash changes; the scheduled task starts the new version within 30 minutes.

## Evidence

- Manual check: `Set-TreeBelowNormal` lowered a cmd → conhost → ping tree from AboveNormal to BelowNormal.
- `tests/vibe/automation.test.mjs` asserts both behaviours are present.
- Response to review 3: the dry-run tests now build a throwaway trunk with its own genesis lock, so they test the runner instead of the repository's lock state (they previously failed by design until approval). A new test proves the runner refuses to start when its lock fails. `node --test tests/vibe/automation.test.mjs`: 7 pass, 0 fail.

## Review history

- Review 1 (governance-verifier): FAIL. The proposal described the change but did not contain the exact new text.
- Review 2 (governance-verifier): FAIL. The included diff used two context lines, so its hunks did not match `git diff -- vibe/goal/run-goal.ps1` exactly.
- Review 3 (governance-verifier): FAIL. The proposal diff now exactly matches `git diff -- vibe/goal/run-goal.ps1` with default context, and the change is consistent with E2/F2, the Vision, and the hard stops. Approval is blocked because `node --test tests/vibe/automation.test.mjs` fails: `goal runner dry run removes secrets and confines writes` receives empty output and therefore does not match `/DRYRUN args=.*-p vibecodium-goal -s workspace-write/`. The changed test file cannot provide passing acceptance evidence until this failure is resolved and independently re-reviewed.

## Exact change

Output of `git diff -- vibe/goal/run-goal.ps1` (default three context lines) against `vibe/main`:

```diff
diff --git a/vibe/goal/run-goal.ps1 b/vibe/goal/run-goal.ps1
index a0baca1..d36a846 100644
--- a/vibe/goal/run-goal.ps1
+++ b/vibe/goal/run-goal.ps1
@@ -89,6 +89,26 @@ function Get-GoalState {
   if ($m) { return $m.Matches[0].Groups[1].Value } else { return 'missing' }
 }
 
+function Get-TreeIds([int]$RootId) {
+  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
+  $ids = [System.Collections.Generic.HashSet[int]]::new()
+  [void]$ids.Add($RootId)
+  do {
+    $added = $false
+    foreach ($x in $all) { if ($ids.Contains([int]$x.ParentProcessId) -and $ids.Add([int]$x.ProcessId)) { $added = $true } }
+  } while ($added)
+  return $ids
+}
+
+function Set-TreeBelowNormal([int]$RootId) {
+  foreach ($id in (Get-TreeIds $RootId)) {
+    try {
+      $pr = Get-Process -Id $id -ErrorAction Stop
+      if ($pr.PriorityClass -notin 'BelowNormal', 'Idle') { $pr.PriorityClass = 'BelowNormal' }
+    } catch { }
+  }
+}
+
 function Get-TodayCount {
   $f = Join-Path $LogDir ("count-{0}.txt" -f (Get-Date -Format 'yyyyMMdd'))
   if (Test-Path $f) { return [int](Get-Content $f) } else { return 0 }
@@ -98,6 +118,8 @@ function Add-TodayCount {
   Set-Content -Path $f -Value ((Get-TodayCount) + 1)
 }
 
+$selfHash = (Get-FileHash -LiteralPath $PSCommandPath).Hash
+
 try {
   $failures = 0
   while ($true) {
@@ -118,6 +140,12 @@ try {
       git -C $Root merge --ff-only --quiet origin/vibe/main 2>&1 | Out-Null
     }
 
+    # A merged change to this script takes effect on the next scheduled start, not mid-loop.
+    if ((Get-FileHash -LiteralPath $PSCommandPath).Hash -ne $selfHash) {
+      Write-Log 'runner script changed on trunk; exiting so the scheduler starts the new version'
+      break
+    }
+
     if (-not $DryRun) { Add-TodayCount }
     $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
     $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "vibe-goal-$stamp"
@@ -158,10 +186,17 @@ try {
     }
     $p = Start-Process -FilePath $Codex -ArgumentList ($codexArgs -join ' ') -RedirectStandardInput $promptFile `
       -RedirectStandardOutput (Join-Path $tmp 'out.txt') -RedirectStandardError (Join-Path $tmp 'err.txt') -WindowStyle Hidden -PassThru
-    try { $p.PriorityClass = 'BelowNormal' } catch { }
-    if (-not $p.WaitForExit($IterationTimeoutMinutes * 60 * 1000)) {
-      Write-Log "iteration timed out after $IterationTimeoutMinutes min; stopping process tree"
-      & taskkill.exe /PID $p.Id /T /F | Out-Null
+    # codex.exe raises its own priority; keep the whole session tree below normal.
+    $deadline = (Get-Date).AddMinutes($IterationTimeoutMinutes)
+    Start-Sleep -Seconds 5
+    Set-TreeBelowNormal $p.Id
+    while (-not $p.WaitForExit(30000)) {
+      Set-TreeBelowNormal $p.Id
+      if ((Get-Date) -gt $deadline) {
+        Write-Log "iteration timed out after $IterationTimeoutMinutes min; stopping process tree"
+        & taskkill.exe /PID $p.Id /T /F | Out-Null
+        break
+      }
     }
 
     # Keep only a short, redacted summary; raw streams never persist.
```
