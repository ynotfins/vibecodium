# Understand-Anything integration decision

> Doc class: living · Owner: tech-scout · Last reviewed: 2026-11-24
>
> Decision record for the M5 Understand-Anything integration. The projection lives in `src/stable/index-engine/understand-projection.mjs`; the acceptance test is `tests/vibe/understand-projection.test.mjs`.

## Component and license

- Project: [Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything).
- License: MIT. Keep the copyright and license notice if any upstream file is ever bundled; this slice does not vendor or redistribute an upstream file.
- Observed release: v2.9.8 (2026-11-15), as recorded in `TECH_RADAR.md`.
- Local evidence: the installed `understand` skill writes a `knowledge-graph.json` with `version: "1.0.0"`, 13 node types, 26 edge types, `layers` and `tour` under `.ua/` (or the legacy `.understand-anything/`). That file is the integration boundary used here.
- Upstream internals beyond the documented graph shape remain unverified. Nothing in this slice calls the Understand-Anything agent, its dashboard, or its merge scripts.

## Decision

- The Vibecodium graph engine (`cross-project-graph.mjs`) stays the only owner of canonical cross-project edges.
- Understand-Anything is a read-only semantic and visual projection: `projectToUnderstandGraph()` maps an already validated `CrossProjectGraph` snapshot into the `knowledge-graph.json` shape.
- The projection is deterministic given a fixed `analyzedAt`. It copies identifiers, names, project-relative paths, route patterns, environment-variable names, ports, table names, tool names and image names only. It never reads or emits source text, environment values or request URLs, and it has no write path back into the graph.
- `validateUnderstandGraph()` checks the documented Understand-Anything inline-validator rules: required node fields, known node and edge types, no dangling edges, every file-level node in exactly one layer, and tour references that resolve.
- A future LLM enrichment phase may replace the structural `summary` and `tags` text. That is presentation work; it must not change the graph authority or add a runtime dependency.

## Mapping

| Vibecodium graph node | Understand node type | ID shape (project `p`, file `f`) |
|---|---|---|
| project | `module` | `module:project:<p>` |
| module (source file) | `file` | `file:<p>:<f>` |
| symbol | `function` | `function:<p>:<f>:<line>:<column>:<name>` |
| route | `endpoint` | `endpoint:<p>:<METHOD>:<path>` |
| package | `module` | `module:package:<p>:<name>` |
| env | `concept` | `concept:env:<p>:<name>` |
| port | `resource` | `resource:port:<p>:<port>` |
| database-table | `table` | `table:<p>:<name>` |
| mcp-tool | `endpoint` | `endpoint:mcp:<p>:<name>` |
| container | `service` | `service:<p>:<image>` |

| Vibecodium edge | Understand edge | Weight |
|---|---|---|
| project-module | `contains` | 1.0 |
| route-definition | `routes` | 0.5 |
| import | `imports` | 0.7 |
| package-dependency | `depends_on` | 0.6 |
| env-use | `reads_from` | 0.5 |
| exposes-port | `serves` | 0.5 |
| database-table-use | `related` | 0.5 |
| mcp-tool | `exports` | 0.8 |
| container-image | `deploys` | 0.7 |
| http-route-caller | `calls` | 0.8 |

`database-table-use` maps to `related` rather than `reads_from` or `writes_to` because the C3 edge does not record whether the SQL statement reads or writes; the projection does not invent a direction.

## What is and is not delivered

- Delivered: the projection module, its full-graph acceptance test, and this decision record. The project -> module `contains` edge, symbol `filePath`, and route-to-caller edge survive the projection; every node and edge carries `sourceTrust: 'untrusted-repository-content'`.
- Not delivered: running the Understand-Anything agent, its dashboard, LLM summaries, layers or tours beyond the structural ones generated from the graph, docs-mcp, and the M6 live workspace binding.
- Review trigger: an Understand-Anything release that changes the `knowledge-graph.json` version or its node and edge vocabulary, or a decision to vendor upstream code into the product.
