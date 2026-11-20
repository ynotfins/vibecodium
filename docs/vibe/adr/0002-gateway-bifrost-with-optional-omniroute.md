# ADR-0002: Gateway: Bifrost bundled, OmniRoute optional upstream

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-20

- Status: accepted
- Date: 2026-11-20

## Context

The product needs one local endpoint for model routing, fallbacks, budgets, caching and MCP aggregation. Candidates: Bifrost (Apache-2.0, Go single binary, SQLite, MCP Code Mode; transports v2.6.0 released 2026-11-19), OmniRoute (MIT, very active, Node app with dashboard, auto-combos, compression, semantic cache), LiteLLM (MIT + enterprise dir, Python), Portkey (stale).

## Decision

Bundle Bifrost as the product gateway. Support OmniRoute as an optional upstream provider row ("Use my OmniRoute") for users who already run it, as on the owner's workstation.

## Why

- Bifrost ships as one static binary with SQLite storage, so it fits a portable installer. Its MCP Code Mode keeps tool context constant regardless of how many MCP servers are configured.
- OmniRoute's strengths (auto-combos across many accounts, free-tier aggregation, compression) are valuable for heavy users but make it a large second runtime to bundle and supervise.
- Running both in series is allowed but must not double-route: when OmniRoute is the upstream, Bifrost does fallbacks and budgets only.

## Rules that follow

- Bifrost semantic (embedding) cache is off for agent traffic. Bifrost documents that caching needs a cache key, skips requests with more messages than `conversation_history_threshold` (default 3), and does not cache tool-call responses by default, so it rarely fires for agents by design. Direct (hash) cache is used only for deterministic calls.
- OmniRoute compression, when used, is limited to tool output and logs; it must never touch prompts or specs.
- Sessions stick to one provider so provider prompt caching stays warm.

## Morph as the direct second option (added 2026-11-20)

The owner uses Morph through OmniRoute today and wants it available directly when OmniRoute is not running. Provider order for such users: OmniRoute → Morph direct → other direct providers, as Bifrost fallbacks. Morph is also more than a model source:

- Fast Apply (`morph-v3-fast`, `morph-v3-large`) merges lazy edit snippets into files; used for agent edits (A4).
- WarpGrep (`morph-warp-grep-v2.1`) searches a repository in its own context and returns file/line spans; complements the local index for agent search (C5).
- Compact (`morph-compactor`) drops irrelevant lines from history while keeping every surviving line byte-identical; a candidate backend for the Vibe Context Engine (ADR-0003, D2).
- Router (`/v1/router/multimodel`, ~$0.005 per request) returns the model tier a prompt needs; an option next to Bifrost's own routing rules (B3).
- Morph-hosted open models (Kimi K3.1, GLM-5.3, DeepSeek V4.1 Flash, and an approval-gated abliterated DeepSeek variant) on an OpenAI-compatible API.

Morph is a hosted service; the product talks to it with the user's key and the MIT `@morphllm/morphmcp` tools. PRODUCT_SPEC B6.

## Revisit

`tech-scout` re-evaluates this choice at every milestone start. OmniRoute's license (MIT) allows bundling later if the evidence favours it.
