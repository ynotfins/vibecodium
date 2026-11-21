# Proposal: read VIBECODIUM_GH_TOKEN from the user registry

- Date: 2026-11-21
- Proposer: vibe-overseer (bootstrapping session)
- Must-have IDs: E4 (hard stops / least privilege)
- Locked path: `vibe/goal/run-goal.ps1`

## Problem

The owner created a repository-scoped `VIBECODIUM_GH_TOKEN`, but the loop's scheduled-task process still received an environment block captured before it existed (`VIBECODIUM_GH_TOKEN is not set` at 22:12), so the loop fell back to the owner's account-wide `GITHUB_TOKEN`.

## Change

When `VIBECODIUM_GH_TOKEN` is absent from the process environment, read it with `[Environment]::GetEnvironmentVariable('VIBECODIUM_GH_TOKEN','User')`. The value stays in memory, is never logged, and is subject to the same redaction as every other secret. Only this one name is read from the registry, so no other secret can be pulled in.

## Evidence

- Dry run after the change: `gh_token_source=VIBECODIUM_GH_TOKEN`, `secret_vars_left=0`.
- `node --test tests/vibe/automation.test.mjs`: 9 pass (new assertion requires the registry read).

## Exact change

Output of `git diff --cached origin/vibe/main -- vibe/goal/run-goal.ps1`:

```diff
diff --git a/vibe/goal/run-goal.ps1 b/vibe/goal/run-goal.ps1
index e48c59c..6b502f7 100644
--- a/vibe/goal/run-goal.ps1
+++ b/vibe/goal/run-goal.ps1
@@ -79,6 +79,14 @@ foreach ($e in @(Get-ChildItem Env:)) {
   }
 }
 foreach ($k in $AllowedProviderKeys) { if ($script:SecretValues.ContainsKey($k)) { Set-Item -LiteralPath "Env:$k" -Value $script:SecretValues[$k] } }
+# A scheduled task can be handed an environment block captured before the owner set a variable, so the
+# scoped token is also read from the user registry. The value stays in memory and is never logged.
+foreach ($name in 'VIBECODIUM_GH_TOKEN') {
+  if (-not $script:SecretValues.ContainsKey($name)) {
+    $v = [Environment]::GetEnvironmentVariable($name, 'User')
+    if ($v) { $script:SecretValues[$name] = $v }
+  }
+}
 $ghSource = @('VIBECODIUM_GH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN') | Where-Object { $script:SecretValues.ContainsKey($_) } | Select-Object -First 1
 if ($ghSource) { $env:GH_TOKEN = $script:SecretValues[$ghSource] }
 if ($ghSource -ne 'VIBECODIUM_GH_TOKEN') { Write-Log "VIBECODIUM_GH_TOKEN is not set; GitHub access uses $(if ($ghSource) { $ghSource } else { 'nothing' }) (broader scope)" }
```
