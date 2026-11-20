# ADR-0001: Thin fork with a hybrid AI layer

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-20

- Status: accepted
- Date: 2026-11-20

## Context

The goal is a Cursor-class IDE on VSCodium. Three shapes were compared in the [2026-11-08 research plan](../research/2026-11-08-architecture-plan.md) §2: (a) re-enable VS Code's native AI harnesses as-is, (b) absorb an agent extension such as Kilo Code or Cline, (c) hybrid. A deep fork of the VS Code source tree (the Cursor / Void model) was also considered.

## Decision

Use (c): keep VSCodium's patch-based build, re-enable VS Code core's MIT agent UI and services, add our own `vibe` agent provider (OpenCode over ACP) through overlay files, and ship our features as built-in extensions and supervised sidecars.

## Why

- Speed for indexing, graphing and memory comes from native sidecars and local stores, not from forking the editor. The editor only renders results.
- A deep fork means rebasing on a very large, fast-moving codebase every month. Void, the best-known open-source Cursor clone, was deprecated and archived in June 2026.
- (a) is blocked by licensing: the in-tree Copilot harness needs the proprietary Copilot CLI; the Claude harness needs a proprietary SDK.
- (b) gives a second, parallel chat UI and throws away VS Code's maintained Agents window, worktrees, checkpoints and inline-completion UI.
- VSCodium's overlay copy (`cp -rp src/stable/* vscode/`) lets whole directories be added with zero patches, keeping the patch budget small.

## Consequences

- The `IAgent` contract in VS Code's agent host changes often. All coupling sits behind one adapter file, and a weekly CI job compiles the overlays against upstream `main`.
- Microsoft endpoints referenced by core AI services must be audited and stubbed in M1.
- An earlier session recommendation (Kilo Code as the main agent extension) is superseded by this ADR. Kilo stays a reference for UX patterns only.
