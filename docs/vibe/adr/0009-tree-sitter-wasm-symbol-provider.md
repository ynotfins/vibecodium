# ADR-0009: tree-sitter WASM symbol provider

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-23

- Status: accepted
- Date: 2026-11-23

## Context

M4 C1 requires the standalone index to understand TypeScript/JavaScript declarations with a real parser instead of only the hand-written lexical extractor, while staying dependency-light, offline, and testable without an IDE build. The index must keep working when a grammar or the runtime is absent, and a persisted index must never let a provider smuggle unbounded or malformed symbols into it.

Options considered:

- **Native tree-sitter bindings** - fast, but a native addon needs a per-platform build, a compiler toolchain on every developer and CI machine, and a prebuilt-binary supply chain. Too heavy for the Windows-first, offline-friendly build.
- **ast-grep / LSP adapters** - useful for structural search and semantic resolution, but they require a running process or language server, which is later M4/M6 work and not needed to index declarations.
- **WASM tree-sitter** - a single `.wasm` runtime plus one `.wasm` per grammar, loaded by a small JS glue file, runs unchanged on Windows, Linux and macOS, needs no compiler, and can be vendored and checksum-pinned.

## Decision

- Use **web-tree-sitter** (MIT) and the official **tree-sitter-javascript** and **tree-sitter-typescript** grammars (MIT), pinned and vendored verbatim under `src/stable/index-engine/vendor/tree-sitter/`.
- Record each package's SHA-256, the npm `dist.integrity`, publication date and license in the vendor `README.md`; list every vendored file in `SHA256SUMS`, which the test suite verifies on every run.
- Put the provider behind a small injectable interface (`id`, `extractSymbols(source, { filePath, maxSymbols })`) in `symbol-providers.mjs`. `createRegexSymbolProvider()` wraps the existing extractor, so the index keeps a parser-free fallback and the interface is testable without WASM.
- `ProjectIndex` validates every provider symbol (known fields and kinds, identifier names, positive line and column, optional identifier container), de-duplicates and sorts them, and re-extracts unchanged files when a custom provider is configured, because the provider identity is not persisted.
- Keep the default extractor in place for now; the IDE binding that selects the tree-sitter provider is later M4/M6 work.

## Consequences

- The index gains a real parser for JavaScript, TypeScript and TSX with no native build step, and the same vendored files work on every supported OS.
- The vendor folder adds about 3.5 MB of checked-in `.wasm`/`.js` files. They are refreshed by hand from pinned npm tarballs; the checksum test fails if any file drifts.
- The provider is declaration-level only. Function-local variables are not indexed, non-ASCII identifiers are excluded for parity with the regex extractor, and `line`/`column` point at the symbol name. ast-grep, LSP, embeddings, LanceDB and hybrid retrieval remain later M4 work.
- A missing runtime or grammar fails with a clear `SymbolProviderError` instead of silently falling back, so a misconfigured install is visible. Source size and AST node count are capped to bound memory.
