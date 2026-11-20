# ADR-0006: Autonomous goal runner for building the product

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-20

- Status: superseded by [ADR-0007](0007-build-on-our-own-models-with-opencode.md) (the loop now runs on OpenCode with our own models; the Ralph-style outer loop, repo-held state and stop conditions are unchanged)
- Date: 2026-11-20

## Context

The owner wants the build to run to completion without check-ins. Codex CLI 0.154 has persistent goals, hooks and multi-agent support. Goals cannot yet be started deterministically from `codex exec` (openai/codex issues #26949 and #26966), and one session cannot hold a multi-month build in context.

## Decision

A Ralph-style outer loop, `vibe/goal/run-goal.ps1`:

- The loop owns a dedicated clone of the repository on `vibe/main`; its task worktrees live in `<clone>.worktrees`. Each iteration starts a fresh `codex exec` session there with a fixed continuation prompt, in the `workspace-write` sandbox limited to those two folders and with secret environment variables removed. State lives in the repo (`vibe/goal/GOAL.md`, `docs/vibe/ROADMAP.md`, `docs/vibe/STATUS.md`), so nothing is lost between sessions.
- Each session does exactly one task slice and runs the after-every-task chain from `GOVERNANCE.md`.
- The loop stops when `STATUS.md` says `Goal state: complete` or `Goal state: blocked`, or when its daily iteration cap is reached. A lock file prevents concurrent runs.
- A session may use OpenHands as a worker pool for bounded tasks.

## Why

Fresh sessions keep context small and cache-friendly. Repo state makes progress auditable and resumable after crashes or reboots. Codex is the subscription-default agent on the owner's PC, so the orchestrator adds no API spend.
