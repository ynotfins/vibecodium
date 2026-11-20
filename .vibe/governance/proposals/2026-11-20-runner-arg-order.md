# Proposal: put the OpenCode message before the attached file

- Date: 2026-11-20
- Proposer: vibe-overseer (bootstrapping session)
- Must-have IDs: E2; F2
- Locked path: `vibe/goal/run-goal.ps1`

## Problem

First live iteration of the OpenCode runner (2026-11-20 18:37) failed immediately with `File not found: Follow the attached file exactly...`. OpenCode's `-f` option takes every following positional argument as a file, so the instruction message placed after `-f` was read as a second file name.

## Change

Move the message to directly after `run`; `-f <prompt file>` is now the last argument. No other behaviour changes. The dry-run test now asserts the order.

## Evidence

- Manual: `opencode run "<message>" -m omniroute/cheap --dir <dir> -f note.md` answered correctly from the attached file.
- `node --test tests/vibe/automation.test.mjs`: 8 pass.

## Exact change

Output of `git diff origin/vibe/main -- vibe/goal/run-goal.ps1`:

```diff
diff --git a/vibe/goal/run-goal.ps1 b/vibe/goal/run-goal.ps1
index e45f06a..8167c05 100644
--- a/vibe/goal/run-goal.ps1
+++ b/vibe/goal/run-goal.ps1
@@ -241,8 +241,9 @@ try {
     Copy-Item (Join-Path $Root 'vibe\goal\continue.prompt.md') $promptFile
     Write-Log "iteration start ($stamp) provider=$chosen model=$chosen/$($classes.standard)"
 
-    $ocArgs = @('run', '--agent', 'vibe-overseer', '-m', "$chosen/$($classes.standard)", '--dir', $Root, '-f', $promptFile,
-      'Follow the attached file exactly. It is your complete instruction set for this session.') |
+    # The message must come before -f: OpenCode's -f takes every following positional as a file.
+    $ocArgs = @('run', 'Follow the attached file exactly. It is your complete instruction set for this session.',
+      '--agent', 'vibe-overseer', '-m', "$chosen/$($classes.standard)", '--dir', $Root, '-f', $promptFile) |
       ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
     if ($DryRun) {
       $left = @(Get-ChildItem Env: | Where-Object { $_.Name -match $secretPattern -and $_.Name -notmatch '^GIT_CONFIG_' -and $_.Name -notin ($AllowedProviderKeys + 'GH_TOKEN') } | ForEach-Object Name)
```
