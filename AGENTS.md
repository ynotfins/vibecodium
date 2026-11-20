# AGENTS.md: Vibecodium

Operating rules for every agent working in this repository. This file is locked (see `docs/vibe/GOVERNANCE.md`).

## What this repo is

`ynotfins/vibecodium`: the build scripts and patch set for **Vibecodium**, a standalone Windows-first AI IDE built on VSCodium. Product intent: `docs/vibe/VISION.md`. Must-haves: `docs/vibe/PRODUCT_SPEC.md`. Architecture: `docs/vibe/ARCHITECTURE.md`. Everything outside `docs/vibe/`, `.vibe/`, `vibe/`, `tests/vibe/`, `patches/vibe/`, `src/stable/` and `.codex/` is upstream VSCodium; change it only when a milestone requires it, and keep such changes small.

## Read first, every session

1. This file.
2. `vibe/goal/GOAL.md` (the objective and the definition of done).
3. `docs/vibe/GOVERNANCE.md` (doc classes, lock, after-every-task chain, autonomy contract, hard stops).
4. `docs/vibe/STATUS.md` and `docs/vibe/ROADMAP.md` (where we are).

## Autonomy

The owner granted full autonomy to build to completion. Do not stop between tasks or milestones to ask. Follow `GOVERNANCE.md` §5: uncertain choices go on `vibe/alt/<slug>` branches, business decisions go to "Parked for owner" in `STATUS.md`, and the five hard stops always pause.

## Every task slice

1. `vibe-overseer` writes a task card in `STATUS.md`.
2. Work in a dedicated worktree in the folder beside the checkout, `<checkout>.worktrees/<slug>`, on branch `vibe/<milestone>/<slug>`, branched from `vibe/main`.
3. Write the acceptance test first, then the implementation.
4. Run the guardian chain in order, each as a separate sub-agent defined in `.vibe/agents/`: `qa-verifier` → `drift-sentinel` → `security-reviewer` (when relevant) → `docs-keeper` → `governance-verifier` (when a locked path changed) → `tech-scout` (when a dependency changed) → `vibe-overseer`.
5. `node vibe/tools/verify.mjs` must pass.
6. Commit only task-owned paths, push the branch, open a PR into `vibe/main`, merge after CI is green.

## Commands

| Purpose | Command |
|---|---|
| All repo checks (required before commit) | `node vibe/tools/verify.mjs` |
| Governance lock status | `node vibe/tools/governance.mjs status` |
| Regenerate Codex agent files after editing `.vibe/agents/` | `node vibe/tools/sync-agents.mjs` |
| Build toolchain check (Git Bash) | `bash vibe/dev/preflight.sh` |
| Build the IDE (Git Bash) | `bash vibe/dev/build-windows.sh` (add `-p` for installer and zip) |

## Rules that never bend

- Never write, print, log or commit a secret value. Environment variable names are fine.
- Never edit a `locked` doc or locked file except through `governance-verifier` (GOVERNANCE §3).
- Never hand-edit `.codex/agents/*.toml`; edit `.vibe/agents/*.md` and regenerate.
- `master` mirrors `VSCodium/vscodium` only. Product work lands on `vibe/main` by PR.
- Library and API facts come from live sources (release pages, registries, official docs), not memory. Record versions in `docs/vibe/TECH_RADAR.md`.
- New dependencies: permissive license, pinned version and checksum, public for at least 7 days, radar row added.
