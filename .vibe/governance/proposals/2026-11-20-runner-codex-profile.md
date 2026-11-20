# Proposal: pass the goal runner's sandbox settings through a Codex profile

- Date: 2026-11-20
- Proposer: vibe-overseer (bootstrapping session)
- Must-have IDs: E2, E4 (autonomous loop inside a sandbox with hard stops); F2
- Locked path: `vibe/goal/run-goal.ps1`

## Problem

A dry run of the runner on the goal clone showed that the `-c sandbox_workspace_write.writable_roots=[...]` override loses its inner quotes on the way through Windows command-line parsing and the npm `codex.cmd` shim. Codex would then reject or misread the setting, so the loop could start without the intended write confinement.

## Change

The working-tree diff of `vibe/goal/run-goal.ps1` on branch `vibe/f0/runner-profile`:

- Each iteration writes a generated Codex profile layer, `<CODEX_HOME>/vibecodium-goal.config.toml`, containing `sandbox_mode = "workspace-write"`, `approval_policy = "never"`, `[sandbox_workspace_write] network_access = true` and `writable_roots = [<clone>, <clone>.worktrees]`.
- Codex is started with `-p vibecodium-goal -s workspace-write` instead of the three `-c` overrides.
- `-DryRun` also prints the generated profile.

No other behaviour changes. Isolation, secret removal, governance gating and logging are unchanged.

## Tests

`tests/vibe/automation.test.mjs` asserts the profile is used and, in the Windows dry run (with `CODEX_HOME` pointed at a temp folder), that the generated profile contains the exact `writable_roots` list.
