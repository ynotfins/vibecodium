# ADR-0003: Vibe Context Engine and the AgentCore adapter

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-20

- Status: accepted
- Date: 2026-11-20

## Context

The owner previously built `agentcore-context-engine` (Python, MIT, v0.2.5, 168 tests passing on 2026-11-20). Verified state:

- Complete through its M1: session identity, provenance, a compaction planner that builds summary DAG plans, token-budget assembly, native lifecycle hooks for Cursor, Claude Code and Codex (live on the owner's PC), Ed25519 device proofs.
- Storage is remote: canonical state goes to `agentcore-memory` (PostgreSQL 18) through the AgentCore gateway. It needs the owner's AgentCore stack to work.
- The compaction planner estimates and groups but does not call a model to write summaries, and there are no in-session expand/grep recall tools. Its M2 (streaming, incremental compaction) is not started.
- It was never integrated into Bifrost.

Reference design for the rolling window: lossless-claw (MIT), which stores every message in SQLite, builds leaf and condensed summaries, keeps a protected fresh tail, and gives agents `lcm_grep`, `lcm_describe` and `lcm_expand`.

## Decision

Build the Vibe Context Engine as a self-contained product component:

- TypeScript in the agent host / built-in extension, local SQLite on the user's disk, works offline, no AgentCore dependency.
- Port the data model of `agentcore-context-engine` (identities, sessions, provenance, DAG, token budgets).
- Add what is missing: model-written leaf and condensed summaries via a cheap route, a protected fresh tail, recall tools (grep, describe, expand), cache-stable prefix assembly, project and user memory.
- Keep an optional AgentCore adapter ("AgentCore plugin") that mirrors sessions to `agentcore-memory` through the existing gateway on machines that have it.

## Why not put it in Bifrost

A gateway plugin would have to rewrite message arrays it does not own. That breaks tool-call pairing, confuses the harness and changes the prompt prefix every turn, which destroys provider prompt caching, the biggest real token saving. The engine belongs where the conversation is owned; the gateway routes and caches.

## Why not Bifrost semantic caching instead

It solves a different problem: replaying a stored answer for a similar request. It does not manage what goes into the prompt, and its defaults skip multi-turn agent conversations. See ADR-0002.

## Consequences

- `agentcore-context-engine` stays the owner's workstation engine for Cursor, Claude Code and Codex. It is not shipped in the product.
- Milestone M5 gains the context-engine work items (PRODUCT_SPEC D1–D5).
