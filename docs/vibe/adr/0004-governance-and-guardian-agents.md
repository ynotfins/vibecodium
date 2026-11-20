# ADR-0004: Locked docs and guardian sub-agents

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-20

- Status: accepted
- Date: 2026-11-20

## Decision

From the first commit, the repo carries:

- A professional docs suite under `docs/vibe/` with doc classes (locked, living, generated, archive).
- A light lock on governing docs: a hash manifest plus an append-only approval chain, verified by a dependency-free Node script in the local loop, the Codex Stop hook and CI.
- Eight sub-agents defined once in `.vibe/agents/*.md` (host-neutral, the product's own format) and generated into `.codex/agents/*.toml` for the build runner: `vibe-overseer`, `qa-verifier`, `drift-sentinel`, `security-reviewer`, `docs-keeper`, `governance-verifier`, `tech-scout`, `release-manager`.

The same mechanism becomes product features F1–F7: user projects get the same docs, locks and guardians.

## Why

- Docs that drift and technology that silently goes stale were the owner's two most expensive past failures. Both are prevented by making the check a gate, not a habit.
- Plain Node with no dependencies runs anywhere the build runs.
- One canonical agent format avoids drift between hosts; a check fails if the generated copies are stale.

## Alternatives

OpenSpec (MIT) for spec deltas stays a candidate for the in-product spec flow (M9). GitHub branch protection with required human review was rejected because it conflicts with the autonomy contract.
