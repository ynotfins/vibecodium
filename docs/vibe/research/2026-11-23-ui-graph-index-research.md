# In-Product UI, Cross-Project Graph, and M4 Index Research

> Doc class: living · Owner: tech-scout · Last reviewed: 2026-11-23 · Next review: 2026-12-07

## Scope and governing constraints

This memo answers four implementation-selection questions without reopening ADR-0001. The accepted product shape remains a thin VSCodium fork with first-party workbench surfaces and supervised sidecars. Milestones remain ordered M0 through M12. M1 through M3 are not skipped. Locked documents are not changed by this research pass.

Research was checked against the current governing documents and live upstream sources on 2026-11-23. Version claims below distinguish stable releases from pre-releases.

## Executive recommendation

1. Build the rich workbench surfaces as bundled, first-party extensions using stable VS Code APIs. Use a full editor-area webview for the graph and Prompt Studio, native tree views for navigation and memory lists, and a webview detail/review surface where rich interaction is necessary. Reserve custom editors for a real persisted Vibe spec file type.
2. Make Vibecodium's own local graph sidecar and SQLite graph tables the only owner of canonical cross-project edges. Understand Anything, Tentra, Depwire, and codebase-analyzer should be evidence producers and projections, not competing graph authorities.
3. Keep the documented M4 stack, but sharpen the responsibilities: tree-sitter owns incremental syntax; ast-grep owns structural matching; LSP enriches semantics but is not the index authority; LanceDB owns filtered lexical-plus-vector retrieval; the graph supplies exact relationship candidates. Fuse candidate lists with reciprocal-rank fusion and evaluate retrieval with project-specific tests.
4. Add SCIP as an optional semantic interchange feed. Assess USearch as a benchmark challenger to LanceDB's vector core, not as a replacement decision. Do not add Kythe, Tantivy, SQLite Vec1, or another graph database without measured evidence that the current stack misses a defined acceptance target.

## 1. In-product UI mechanics

### Recommendation

Use a mixed surface model. A bundled extension is still product UI: it ships with Vibecodium, appears under Vibecodium-owned commands and containers, and is versioned with the product. This preserves the thin-fork patch budget while giving the user a coherent workbench experience.

| Surface | Primary mechanic | Supporting mechanic | Why this is the best fit |
|---|---|---|---|
| Cross-project graph | Editor-area `WebviewPanel` | Native `TreeView` for projects, saved views, filters, and search results | The graph needs a large canvas, custom layout, zoom, selection, and potentially WebGL. The native tree keeps navigation, keyboard behavior, context menus, and workbench theming familiar. |
| Prompt / Spec Studio | Editor-area `WebviewPanel` backed by normal text documents and native diff/edit services | `CustomTextEditorProvider` only if a real persisted Vibe spec file type is adopted | A webview supports forms, validation, reusable prompt blocks, preview, and cost/context feedback. Normal documents preserve reliable text editing, source control, diffs, save, and undo. |
| Memory browser | Native `TreeView` for scopes, sessions, revisions, and approval state | Webview detail/review surface for rich comparison, provenance, and approval | Memory is a store, not primarily a file. Native views fit hierarchical data and commands; the detail surface handles revision comparison and provenance without pretending every memory object is a document. |

### Evidence and maintenance cost

The stable [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview) supports arbitrary HTML in editor tabs and view containers, with explicit message passing and theming. The [Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view) and [Views contribution point](https://code.visualstudio.com/api/references/contribution-points#contributes.views) provide native hierarchical views that users can move among workbench containers. The [Views UX guidance](https://code.visualstudio.com/api/ux-guidelines/views) favors tree views for data and actions. The [Webviews UX guidance](https://code.visualstudio.com/api/ux-guidelines/webviews) says to use webviews when native APIs cannot provide the required UI and to preserve theme and accessibility behavior.

The [Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors) adds document lifecycle responsibilities: save, save-as, backup, revert, undo/redo, and synchronization across multiple editor instances. That cost is justified only when the edited object is genuinely a file-backed document. It is unnecessary for a graph canvas or a database-backed memory browser.

Avoid proposed APIs for these core surfaces. The [proposed API guidance](https://code.visualstudio.com/api/advanced-topics/using-proposed-api) explicitly treats those APIs as unstable and subject to change. A private product build can technically enable them, but each use creates a new upstream rebase liability.

### Cursor-class feel

The Cursor-class quality bar comes from product integration, not from source-patching every surface into workbench internals. The required qualities are consistent visual tokens, commands and keybindings, shared selection state, native diff and file navigation, fast sidecar-backed data, retained view state, and no visible third-party installation boundary. Stable webview and view APIs can deliver those qualities when the extension is bundled and product-owned.

### Cost of being wrong

- If everything is a webview, Vibecodium must recreate keyboard navigation, accessibility, context menus, virtualization, workbench state, and native selection behavior. Maintenance shifts from upstream rebases to a permanent private UI framework.
- If everything is a native tree, the graph and studio will feel constrained and visually behind dedicated AI IDEs.
- If custom editors are used for store-backed objects, the team inherits save/backup/undo semantics that do not match the data model.
- If proposed APIs become foundational, monthly upstream updates can break core product surfaces without a compatibility window.

## 2. One owner for cross-project edges

### Recommendation

The canonical owner should be the Vibecodium Graph Engine already implied by ARCHITECTURE.md: a local sidecar with SQLite graph tables and a typed cross-project edge layer. None of the four evaluated tools should own canonical truth by itself.

The engine should assign stable project and revision identities, normalize typed nodes and edges, and retain provenance, confidence, freshness, and source evidence. Exact low-level schema and wiring remain implementation decisions. The decisive boundary is that every producer submits evidence to one owner; the UI and agents query that owner.

### Comparative finding

| Candidate | What it is strongest at | Cross-project authority fit | Recommended role |
|---|---|---|---|
| Understand Anything | Semantic project knowledge graph, code search, impact/onboarding tools, and visualization | Medium-low. Its documented persistence is a per-project `.ua/knowledge-graph.json`; this is useful input but not evidence of a canonical heterogeneous multi-project registry | Semantic/visual projection and per-project evidence feed |
| Tentra | Indexed symbols, service code graphs, contract recording/binding, snapshots, and god-node analysis | Medium. Strong service and contract evidence, but its tool model does not establish it as the product's durable authority for every project, port, environment variable, DB table, and MCP tool | Service, symbol, and contract evidence feed |
| Depwire | Dependency mapping, cross-language REST/subprocess relationships, impact analysis, temporal graphing, and visualization | Medium-low. It is optimized around connected repositories and diagnostic graph views rather than a product-owned cross-project registry | Dependency, impact, and temporal evidence feed |
| `D:\codebase-analyzer` | Immutable batch reconstruction and comparison of multiple analyzers | Low by design. Its architecture explicitly avoids flattening tool-specific evidence into a lossy universal graph | Batch evidence, discrepancy detection, and regression diagnostics |
| Vibecodium Graph Engine | Product-owned identities, edge semantics, local retention, provenance, and query contract | High | Sole canonical owner |

Understand Anything remains a valuable adopted component. [Release v2.9.8](https://github.com/Egonex-AI/Understand-Anything/releases/tag/v2.9.8), published 2026-11-15, added deterministic incremental preparation, graph-freshness handling, symbol preservation, MCP impact/onboarding/search tools, and large-repository layout improvements. Its [MIT-licensed repository](https://github.com/Egonex-AI/Understand-Anything) documents project-local knowledge graph storage. That supports its role as a semantic producer and visual layer, not a reason to make its JSON format the product's canonical cross-project contract.

Add [SCIP](https://github.com/scip-code/scip) as an optional compiler-backed symbol/reference interchange feed. SCIP is Apache-2.0, language-agnostic, supports external symbols, and is designed so complementary index information can be merged. It is a good feeder for definitions and references where a mature indexer exists. It does not model operational edges such as environment variables, ports, database tables, containers, or MCP tools, so it cannot replace the product graph.

### Required edge families

The product-owned graph must be able to normalize at least shared packages, symbol definitions and references, API routes and callers, service contracts, environment-variable names, ports, database tables, MCP tools, containers, and project/revision membership. A producer may report one or several families. Missing evidence must remain missing rather than being guessed.

### Cost of being wrong

- Making Understand Anything the owner couples canonical history to a per-project JSON schema and its release cadence.
- Making Tentra the owner risks binding product truth to one tool's service and snapshot model.
- Making Depwire the owner confuses diagnostic/temporal views with a durable multi-project registry.
- Making codebase-analyzer the owner contradicts its immutable batch-evidence purpose.
- Allowing four authorities creates conflicting identities, freshness rules, and impact answers—the exact failure this decision is intended to prevent.

## 3. M4 index stack: current best practice and stale points

### Recommendation

Keep the macro stack. The current best practice is a layered, incremental index with separate authorities and late fusion, not one universal index.

| Layer | Responsibility | Current recommendation |
|---|---|---|
| Incremental syntax | Parse changed files and retain stable syntax-derived symbols and ranges | [tree-sitter v0.27.2](https://github.com/tree-sitter/tree-sitter/releases/tag/v0.27.2), released 2026-11-07 |
| Structural queries | Precise AST pattern search, rules, and transformations | [ast-grep v0.51.3](https://github.com/ast-grep/ast-grep/releases/tag/0.51.3), released 2026-11-16 |
| Semantic enrichment | Definitions, references, types, workspace symbols, and language-specific facts when the language server supports them | LSP 3.18, with 3.19 still upcoming in the [official specification index](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/) |
| Lexical and dense retrieval | Filtered full-text/BM25 plus vector candidates in one local store | [LanceDB v0.41.0](https://github.com/lancedb/lancedb/releases/tag/v0.41.0), released 2026-10-29 |
| Exact relationships | Projects, symbols, contracts, runtime/configuration edges, and provenance | Product-owned SQLite graph tables |
| Fusion | Combine lexical, dense, structural, and graph candidates | Reciprocal-rank fusion first; optional local reranking only on the small final candidate set |

The [LanceDB hybrid-search documentation](https://docs.lancedb.com/search/hybrid-search) supports vector and full-text branches, metadata filters, reciprocal-rank fusion, and custom rerankers. Its [evaluation guidance](https://docs.lancedb.com/reranking/eval) provides hit-rate and relevance evaluation patterns. These are vendor results, so the project should use the methodology rather than assuming the vendor's example scores transfer to code retrieval.

### Retrieval design that should become the M4 acceptance baseline

- Chunk on syntax boundaries: symbols, declarations, coherent blocks, and configuration units. Preserve signature, documentation, imports, project, revision, path, language, and symbol identity as metadata.
- Use content-addressed identities so unchanged chunks retain identity across incremental runs. Reparse, re-embed, and rewrite only changed evidence.
- Run exact lexical, structural/symbol, graph, and dense retrieval as separate candidate sources. Apply project, revision, language, and scope filters before expensive ranking.
- Fuse with reciprocal-rank fusion. Exact source and graph evidence should outrank semantically similar text when the question asks for a definition, caller, route, port, table, or tool.
- Evaluate on a fixed Vibecodium query set using Recall@k, mean reciprocal rank or nDCG, p50/p95 latency, index-update time, and changed-file reindex volume. A component is replaced only when the challenger improves a defined target without violating Windows packaging and local-data requirements.

### Where the current documents are stale or underspecified

1. The technology radar's carried versions are stale. Tree-sitter 0.27.2, ast-grep 0.51.3, and Understand Anything 2.9.8 are current stable releases checked on 2026-11-23. LanceDB 0.41.0 remains the stable choice; the 0.42.0 beta line is active and should not be adopted under the seven-day rule.
2. LSP should be described as semantic enrichment, not the canonical multi-project index. The protocol is capability-dependent and the official specification notes constraints around sharing a server across multiple tools. Index completeness cannot depend on an editor's currently active language-server session.
3. `tree-sitter (WASM)` is too prescriptive for the heavy Windows sidecar. Native tree-sitter should be the performance baseline, with WASM retained as a portability fallback if measurement supports it. Because ARCHITECTURE.md is locked, this is a proposal for governance review, not a direct document edit.
4. “Hybrid retrieval” needs measurable acceptance criteria. Without a labeled query set and latency/update budgets, the team cannot tell whether a new vector database or reranker is materially better.
5. Embedding model choice should remain replaceable and versioned in index metadata. Changing a model must create a controlled re-embedding migration, not silently mix incompatible vectors.

### Cost of being wrong

- Vector-only retrieval misses exact identifiers and creates plausible but incorrect context.
- LSP-as-authority makes completeness depend on language-server availability and capability differences.
- Whole-file embeddings increase cost and reduce symbol precision.
- Adding a separate lexical engine before measuring LanceDB duplicates storage, filters, lifecycle, and ranking logic.
- Mixing embedding versions corrupts similarity comparisons and makes relevance regressions hard to diagnose.

## 4. Evidence-backed proposals, not architecture rewrites

### Proposal A — adopt SCIP as an optional semantic feed

SCIP provides a permissively licensed interchange format for compiler-backed symbols and references. It should feed the canonical graph when a mature language indexer exists, while tree-sitter remains the universal syntax baseline. This improves precision without making SCIP a mandatory runtime or a replacement graph.

Decision: assess for M4/M5 integration. Review 2026-12-07.

### Proposal B — benchmark USearch, do not replace LanceDB yet

[USearch v2.26.6](https://github.com/unum-cloud/USearch/releases/tag/v2.26.6), released 2026-10-25, is Apache-2.0, cross-platform, dependency-light, and optimized for embedded vector search. JetBrains described using USearch for local semantic code search in a [2026-11-05 engineering article](https://blog.jetbrains.com/ai/2026/11/building-a-rag-pipeline-for-semantic-code-search-a-developer-diary-and-field-notes-part-2/), with metadata stored separately and exact reranking after approximate-nearest-neighbor candidate generation.

USearch is a credible vector-core challenger, but it does not replace LanceDB's combined vector, full-text, metadata-filtering, and table lifecycle. Replacing LanceDB would add at least one more metadata/lexical component. Run a bounded benchmark only if M4's measured latency, memory, or update targets are missed.

Decision: assess, with no architecture change. Review 2026-12-07.

### Proposal C — native tree-sitter baseline for the sidecar

Measure native tree-sitter against WASM on the supported Windows repository corpus. Adopt native execution as the sidecar baseline only if it wins the defined throughput, memory, startup, and packaging tests; retain WASM as a portability path. This proposal requires governance-verifier approval before changing locked architecture wording.

Decision: proposal only; no locked-document change.

### Alternatives not recommended now

- [Kythe](https://github.com/kythe/kythe) has a mature graph schema and compiler-indexing model, but its own repository describes the project as alpha. Its build and storage ecosystem is disproportionate for a Windows-native thin-fork product.
- [Tantivy](https://github.com/quickwit-oss/tantivy) is a strong MIT-licensed full-text engine, but adding it now would duplicate LanceDB's full-text branch and require a second metadata/filter lifecycle.
- SQLite Vec1 and sqlite-vec are worth watching, but neither has enough production evidence today to displace LanceDB for M4.

## Decision summary

| Question | Recommendation | Confidence | Review trigger |
|---|---|---|---|
| UI mechanics | Mixed stable APIs: graph/studio webviews, native navigation/memory trees, rich detail webviews; custom editor only for a true file type | High | A required interaction is impossible through stable APIs |
| Cross-project graph | Product-owned Graph Engine and SQLite tables are the sole edge authority; all named tools feed or project it | High | A candidate proves complete typed-edge coverage, durable identities, provenance, local operation, and migration control |
| M4 index | Keep the layered stack; clarify authority boundaries, late fusion, incremental identity, and measurable retrieval acceptance | High | Project benchmark shows a target miss |
| Better additions | Assess SCIP and USearch; propose native tree-sitter baseline; reject extra engines without benchmark evidence | Medium-high | Two-week radar review or milestone-start review |

## Primary sources checked 2026-11-23

- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view)
- [VS Code Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [VS Code Views contribution points](https://code.visualstudio.com/api/references/contribution-points#contributes.views)
- [VS Code Views UX guidance](https://code.visualstudio.com/api/ux-guidelines/views)
- [VS Code Webviews UX guidance](https://code.visualstudio.com/api/ux-guidelines/webviews)
- [VS Code proposed API guidance](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- [Understand Anything repository](https://github.com/Egonex-AI/Understand-Anything) and [v2.9.8 release](https://github.com/Egonex-AI/Understand-Anything/releases/tag/v2.9.8)
- [SCIP repository and protocol](https://github.com/scip-code/scip)
- [Tree-sitter v0.27.2](https://github.com/tree-sitter/tree-sitter/releases/tag/v0.27.2)
- [ast-grep v0.51.3](https://github.com/ast-grep/ast-grep/releases/tag/0.51.3)
- [LSP 3.18 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)
- [LanceDB repository](https://github.com/lancedb/lancedb), [hybrid search](https://docs.lancedb.com/search/hybrid-search), and [reranking evaluation](https://docs.lancedb.com/reranking/eval)
- [USearch repository](https://github.com/unum-cloud/USearch) and [JetBrains local code-search field notes](https://blog.jetbrains.com/ai/2026/11/building-a-rag-pipeline-for-semantic-code-search-a-developer-diary-and-field-notes-part-2/)
- [Kythe repository](https://github.com/kythe/kythe)
- [Tantivy repository](https://github.com/quickwit-oss/tantivy)
