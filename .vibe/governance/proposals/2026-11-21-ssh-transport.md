# Proposal: keep OpenSSL (measured), add prompt suppression and worktree provisioning

- Date: 2026-11-21
- Proposer: vibe-overseer (operator session)
- Must-have IDs: E2 (autonomous loop), E4 (hard stops / no focus theft)
- Locked path: `vibe/goal/run-goal.ps1`

## Problem

The loop's Codex session crashed `git-remote-https.exe` inside the sandbox ("memory could not be read"),
raising a Windows Error Reporting dialog that stole focus. The runner forced `GIT_SSL_BACKEND=openssl`
because the elevated sandbox user cannot read the Windows certificate store. Outside the sandbox both
backends fetch cleanly (verified: schannel and openssl, Git 2.55.0.windows.5, exit 0), so the trigger is
the sandboxed combination, not the backend alone.

## Review history

- Round 2 (Codex BYOK verifier): FAIL — SSH looked right from the owner's shell but the sandbox user cannot
  read the private key (`Permission denied (publickey)`), so the agent's own pushes would have broken.
- Round 3 (measured inside the sandbox, which is the environment that fails): `http.sslBackend=openssl`
  clones, commits and **pushes** cleanly (all exit 0); schannel fails with `SEC_E_NO_CREDENTIALS`
  (`curl` exit 35, `git ls-remote` 128). So OpenSSL is **required**, not the bug. The proposal is rewritten:
  keep OpenSSL, suppress terminal prompts, and create `<clone>.worktrees` before launch because the sandbox
  cannot create that folder itself (its parent is not writable).
- Round 1 (Codex BYOK verifier): FAIL — the change was mechanically correct but left a stale comment above
  it claiming "OpenSSL is used because the elevated Codex sandbox cannot use Windows certificate channels",
  contradicting the new "No GIT_SSL_BACKEND" text. Round 2 rewrites that comment to describe the SSH remote
  and the credential helper accurately.

## Change

1. `run-goal.ps1` keeps `GIT_SSL_BACKEND=openssl` (measured requirement) and adds `GIT_TERMINAL_PROMPT=0`,
   with a comment recording the measurement so nobody switches back to schannel to "fix" a transport error.
2. `run-goal.ps1` creates `<clone>.worktrees` before each session: the sandbox can write inside it but cannot
   create it, which broke the first transport test.
3. The loop clone's remote is restored to HTTPS (SSH cannot be used from the sandbox). The focus-stealing
   crash dialog is separately suppressed at the OS level (`HKCU\...\Windows Error Reporting\DontShowUI=1`),
   which is outside this repository and reversible.

## Why this over the alternatives

- SSH: rejected by measurement — the sandbox user cannot read the private key.
- schannel + CA bundle: rejected by measurement — schannel itself fails in the sandbox.
- Removing the sandbox: rejected — it is the isolation that makes the loop safe.

## Evidence

Inside the Codex sandbox (the environment that fails):
- schannel: `git ls-remote` exit 128, `curl` exit 35, both `SEC_E_NO_CREDENTIALS`.
- openssl: `git clone` exit 0, `git commit --allow-empty` exit 0, `git push origin HEAD:refs/heads/i1-transport-test`
  exit 0 ("[new branch]"). Test branch and test clone deleted afterwards.
- Outside the sandbox: `ssh -T git@github.com` → "Hi ynotfins!" (not used by the loop).
- `node --test tests/vibe/automation.test.mjs` → 9 pass.

## Exact change

Output of `git diff --cached origin/vibe/main -- vibe/goal/run-goal.ps1`:

```diff
diff --git a/vibe/goal/run-goal.ps1 b/vibe/goal/run-goal.ps1
index c8b2a2c..5826971 100644
--- a/vibe/goal/run-goal.ps1
+++ b/vibe/goal/run-goal.ps1
@@ -51,13 +51,17 @@ try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNo
 if (-not $Codex) { $Codex = (Get-Command codex.cmd -ErrorAction Stop).Source }
 if (-not $OpenCode) { $OpenCode = (Get-Command opencode -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
 
-# Git uses the GitHub CLI (and therefore GH_TOKEN) as its credential helper, for this process tree
-# only. OpenSSL is used because the elevated Codex sandbox cannot use Windows certificate channels.
+# Git identity for this process tree only. The GitHub CLI is the credential helper (GH_TOKEN), so no
+# token ever appears on a command line. safe.directory lets the sandboxed user operate on the clone.
 $env:GIT_CONFIG_COUNT = '3'
 $env:GIT_CONFIG_KEY_0 = 'credential.helper'; $env:GIT_CONFIG_VALUE_0 = ''
 $env:GIT_CONFIG_KEY_1 = 'credential.helper'; $env:GIT_CONFIG_VALUE_1 = '!gh auth git-credential'
 $env:GIT_CONFIG_KEY_2 = 'safe.directory'; $env:GIT_CONFIG_VALUE_2 = '*'
+# OpenSSL is required, not optional: measured inside the sandbox, schannel TLS fails with
+# SEC_E_NO_CREDENTIALS (curl exit 35, git ls-remote 128), while http.sslBackend=openssl clones, commits
+# and pushes cleanly. Do not "fix" a transport error by switching back to schannel. Prompts stay off.
 $env:GIT_SSL_BACKEND = 'openssl'
+$env:GIT_TERMINAL_PROMPT = '0'
 
 # Single instance.
 $lockFile = Join-Path $LogDir 'runner.lock'
@@ -342,6 +346,9 @@ try {
       break
     }
 
+    # The sandbox can write inside <clone>.worktrees but cannot create that folder itself.
+    New-Item -ItemType Directory -Force -Path ($Root + '.worktrees') | Out-Null
+
     $models = Get-Models
     $chosen = Select-Provider $models
     if (-not $chosen) { Write-Log 'no model provider answered; stopping until the next scheduled start'; break }
```
