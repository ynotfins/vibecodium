# ADR-0009: Docs MCP is local-first now, upstream web scraping later

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-24

- Status: accepted
- Date: 2026-11-24

## Context

The original research selected `arabold/docs-mcp-server` as the docs/web context component. It is MIT, active and capable: it indexes websites, repositories, packages, local folders and archives, with HTML, PDF, Office and EPUB extraction. The newest release is 3.5.0 (2026-11-22), still inside the seven-day adoption window; it cannot be adopted before 2026-11-29. Running it means installing a large Node dependency graph, including native SQLite and a browser automation stack, and wiring it behind Bifrost. That packaging work belongs with the M2 sidecar and gateway work, not the standalone M5 engine.

M5 still needs an agent-facing documentation surface that works offline, does not weaken the secret or network rules, and can be accepted without bundling an unvetted dependency tree.

## Decision

Ship `src/stable/docs-mcp/` as a dependency-free local Markdown documentation MCP server for M5.

- It indexes only explicitly configured absolute documentation roots.
- It resolves each configured root once and does not follow symlinked entries beneath it; it skips hidden and dependency directories and reads Markdown only.
- It never fetches the network and accepts no remote URL or registry.
- It exposes MCP 2025-06-18 stdio tools `docs_list`, `docs_search` and `docs_read`.
- It bounds the corpus, per-document and total bytes, query length, result count, snippets and reads.
- It returns project-relative paths only, neutralises C0/C1, DEL, Unicode format characters (including bidi, zero-width, BOM and tag characters) and variation selectors, and labels every result `untrusted-documentation-content`.
- It emits one JSON-RPC object per line, isolates parse and tool errors, and caps every stdio message.

Keep `@arabold/docs-mcp-server` as the selected web-scraping adapter for later packaging. That adapter can run behind Bifrost and populate the same indexing boundary once its dependency tree is pinned, checksummed and reviewed. This ADR does not add a dependency or approve bundling the upstream server.

## Consequences

- M5 has a useful, testable documentation-grounding surface now.
- The product remains offline and portable at this layer.
- HTML, PDF and web scraping are not available until the upstream adapter lands.
- The adapter must preserve the same source-trust labelling and output bounds where it feeds agent context.
- Adding or bundling `@arabold/docs-mcp-server` requires a radar row, a pinned version, a checksum and the seven-day rule; its current 3.5.0 release cannot be adopted before 2026-11-29 unless it fixes a security issue.
