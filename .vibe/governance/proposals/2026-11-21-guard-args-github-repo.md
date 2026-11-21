> Doc class: living · Owner: governance-verifier · Last reviewed: 2026-11-21

# Governance proposal: guard argument passthrough and GitHub repo context

## Change

`vibe/goal/run-goal.ps1` currently builds PowerShell guard shims with a positional parameter block
and a `[Parameter(ValueFromRemainingArguments = $true)]` array. PowerShell binds short hyphen
arguments such as `-v` and `--force` as common parameters instead of remaining arguments, so:
- `gh pr list` cannot see git remotes and returns `no git remotes found`;
- `git push --force ...` returns a PowerShell parameter error instead of the guard's explicit
  `blocked hard-stop command` message.

Replace the guard parameter block with positional `$args` parsing, and set `GH_REPO` inside the
generated `gh.cmd` shim so GitHub CLI has the repository context that the guard-protected Git
environment cannot provide through a `.cmd` shim. Also record the real Git `cmd` directory in
`PATH` for diagnostics only; the guard folder remains first, so hard stops remain enforced.

## Reason

This is a defect in the mechanical enforcement layer, not a relaxation of it. The guard must both
allow ordinary read-only GitHub/Git operations and keep emitting the explicit hard-stop message.

## Affected must-have IDs

F0 process-level guard and F4 verification evidence. No product must-have is weakened.

## Exact text

```diff
@@ function Write-GuardShims([string]$dir)
-param([string]$Cmd, [string]$Real, [string]$Mode, [Parameter(ValueFromRemainingArguments = $true)] [string[]]$Rest)
+$Cmd = [string]$args[0]
+$Real = [string]$args[1]
+$Mode = [string]$args[2]
+$Rest = @($args | Select-Object -Skip 3)

@@ foreach ($name in $targets.Keys)
-    $shim = "@echo off`r`n`"$pwshPath`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0guard.ps1`" $name `"$real`" $($targets[$name].mode) %*`r`n"
+    $repoLine = if ($name -eq 'gh') { "set `"GH_REPO=ynotfins/vibecodium`"`r`n" } else { '' }
+    $shim = "@echo off`r`n$repoLine`"$pwshPath`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0guard.ps1`" $name `"$real`" $($targets[$name].mode) %*`r`n"

@@ try
-    $env:PATH = "$guardDir;$env:PATH"
+    $gitDir = Split-Path -Parent ((Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source)
+    if ($gitDir) { $env:PATH = "$guardDir;$gitDir;$env:PATH" } else { $env:PATH = "$guardDir;$env:PATH" }
```

## Verification

`node vibe/tools/verify.mjs` passes 31/31 tests on the branch. The codex harness test confirms that
`git push --force origin HEAD:x` is blocked with the hard-stop message and that `gh pr list` is not
blocked.
