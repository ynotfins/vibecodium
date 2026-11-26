# M2 B6 WarpGrep code-search agent tool

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-25
>
> The bounded `codebase_search` tool around the `morph-warp-grep-v2.1` model. It lives in
> [morph-warp-grep.mjs](../../../src/stable/gateway/morph-warp-grep.mjs), and its acceptance tests
> live in [morph-warp-grep.test.mjs](../../../tests/vibe/morph-warp-grep.test.mjs).

## Scope

B6 requires WarpGrep to be available as an agent tool. This slice supplies the documented
`codebase_search` function definition and a tool that answers one natural-language question about
one workspace through a short, read-only tool loop. It uses the existing B1 provider client, so every
model turn keeps the M1 endpoint policy, bearer-key handling, timeout, redirect refusal and
response caps, exactly like the delivered Fast Apply tool.

This slice does not add the Router, hosted models, the approval-gated abliterated model, live
provider calls, agent-host wiring, streaming loop steps, GitHub repository search, remote context
compaction, caching, a persistent index or Bifrost supervision. The client is supplied by the
caller; the tool explicitly requests the WarpGrep model, never constructs a client and never reads an
environment variable.

## Tool contract

```js
const tool = createMorphWarpGrepTool({ client, workspaceRoot });
const result = await tool.execute({
  search_string: 'Where is the needle constant defined?',
  search_type: 'default',
});
```

`definition` is a frozen OpenAI function tool named `codebase_search` with a required
`search_string`, an optional `search_type` (`default` or `node_modules`) and an optional
`repo_path`, with `additionalProperties: false`. `execute` returns a frozen object with the finished
`files` (each a frozen `path`, frozen `ranges` and the bounded `content` of those lines), the
`searchType`, the `turns` used and the aggregated `usage` tokens. It never returns the finished
model text, the query, the endpoint or a credential, and no error carries them either.

The loop is at most six model turns through the supplied B1 client. The user turn carries the
documented `<repo_structure>` (a bounded flat listing of the workspace, depth two) and
`<search_string>` blocks (the structure lists workspace-relative paths, depth two, capped at 32 KiB so
no absolute local path is sent), and after every tool round a user turn reports how many turns were used and
that the model must call `finish` on the penultimate turn. Every turn sends the same five read-only
tools:

- `grep_search` searches workspace text files for a literal string and returns `path:line: text`
  matches, with optional `path`, `glob` and `case_sensitive`.
- `read` returns numbered lines of one workspace file, whole or for `start-end` ranges.
- `glob` lists workspace files whose path matches a glob such as `src/**/*.mjs`.
- `list_directory` lists one workspace directory.
- `finish` names the answering files as `path` or `path:start-end` tokens.

The model is not given a write tool. Unknown tool arguments are ignored, as the trained model is
documented to send extra fields such as `limit` or `output_lines`. A tool-level problem (escaping
path, unreadable file, invalid known field) returns a fixed `error: ...` string to the model so it
can correct itself; a loop-level problem (malformed finish, no tool call, too many tool calls, turn
limit) fails closed.
Every tool result becomes part of the next model turn, so matched lines and read content are sent to
the configured provider. The tool has no write tool and no network access of its own, and it never
returns the model text.

## File boundary

Every path the loop touches resolves inside `workspaceRoot`. A relative path is validated segment by
segment; an absolute or drive path is accepted only when its canonical form stays inside the real
workspace root (the trained model sends absolute paths, so the documented shape is accepted).
Encoded separators, empty or dot segments, traversal, colons, Windows reserved device names and
control or bidi characters are rejected. A resolved path must be a regular file or directory inside
the real workspace root. Symbolic links are skipped by the walk and rejected by `read` and `finish`.
`.git` is never searched; `node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `vendor`,
`.next`, `.cache` and `.turbo` are skipped by default, and only `node_modules` is re-included with
`search_type: 'node_modules'`. The same exclusions apply to an explicit `read`, `finish` or
`grep_search` path after the realpath resolution, so no model path can reach `.git`, a dependency
folder or a build folder. Credential-shaped names (a best-effort set: `.env*`, `.envrc`, `.netrc`, `.pgpass`, `.htpasswd`,
`.npmrc`, `.pypirc`, `.vault-token`, `.git-credentials`, `.aws`, `.azure`, `.ssh`, `.docker`, `.kube`,
`.gnupg`, `credentials` or `credentials.json`, `service-account.json`, `id_rsa`, `id_dsa`, `id_ecdsa`,
`id_ed25519` and their `_sk`/`.pub` forms, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.ppk`)
are excluded from the walk, `glob`, `list_directory` and every explicit path, so a committed secret
file is not read into the model context. On Windows and the default macOS filesystem the compared name
is case-folded, so `.GIT` or `Node_Modules` cannot alias `.git` or `node_modules`; on Windows a
trailing dot or space cannot alias an excluded name either, and a relative path segment that differs
from its normalised form is rejected.

Files are opened with `O_NOFOLLOW` where the platform supports it, checked with an lstat/realpath
containment pass and a stable device/inode identity around the read, and decoded as strict UTF-8.
Binary files (any NUL byte), undecodable files and files above 1 MiB are invisible to the search and
rejected by `finish`. On Windows, where `O_NOFOLLOW` is unavailable, the path, realpath and identity
checks carry that boundary.

`repo_path` is accepted for host compatibility. When present it must resolve to the configured
workspace root (compared case-insensitively on Windows and through `realpath`); anything else fails
closed as `outside-workspace`.

## Bounds

The walk is capped at 20,000 entries and 16 levels of depth, and a grep stops after 8 MiB of decoded
file text; a grep is capped at 200 matching lines and 32 KiB of output; a glob is capped at 200 paths
and 32 KiB; `list_directory` is capped at 500 entries and 32 KiB; the repo-structure listing is capped
at 200 entries and 32 KiB; a read is capped at 400 lines
and 32 KiB; a finish is capped at 32 files, 32 KiB per file and 256 KiB in total; and a loop is capped
at 6 turns, 8 tool calls per turn and 24 tool calls in total. `grep_search` and `read` stop at their
caps while rendering and mark the tool output `(truncated)` (an empty result that stopped early reports
`no matches (truncated)`); a `finish` applies its file and total budgets while it selects lines and
fails closed as `result-too-large` instead of building an oversized result first. Grep matches the literal
string case-insensitively by default (a plain a-or-b alternation matches either word), and globs are matched with a linear segment walk, never a
regular expression, so a model-supplied pattern or glob cannot backtrack catastrophically.

## Input and error boundary

Options, input and finish arguments are read through own data descriptors; the `grep_search` and
`read` arguments arrive as JSON text and are parsed and validated field by field. Unknown
fields, missing fields, reserved keys, accessors, duplicate enumerations, non-string values and
oversized strings fail closed without invoking a getter. Provider failures are reported as
`provider-error` with only an integer HTTP status when the B1 client supplied the failure. Every other
failure uses a fixed `WarpGrepError` code (`invalid-input`, `invalid-options`, `outside-workspace`,
`invalid-response`, `no-tool-calls`, `too-many-tool-calls`, `turn-limit`, `invalid-finish`,
`result-too-large`).

## Verification

`node --test tests/vibe/morph-warp-grep.test.mjs` runs 39 tests. They cover the immutable schema, loop
tools and `describe()` surface; a real B1 client against a local mock endpoint running a scripted
grep/read/finish loop with the finished spans, bounded content, aggregated usage and the exact
five-tool request shape with no stream; whole-file and line-range finishes; default
`.git`/`node_modules` exclusion and the `node_modules` opt-in; escaping, symlinked, binary, directory,
missing and oversized targets, including absolute, drive, UNC, encoded and oversized path strings;
text-only answers, empty, malformed and oversized finishes; a finish with too many files; an oversized
result; malformed provider answers and a sparse or null tool call reported as `invalid-response`; a 503
provider status and a closed-port network error that carry no endpoint, query or key; a turn-limit run;
the per-turn and total tool-call caps; explicit `.git`, `node_modules` and build-folder access through
`grep_search`, `read` and `finish`; a symlinked directory that cannot escape the root; `repo_path`
acceptance and rejection; a multi-range read with true line numbers and a glob-limited grep; a
pathological glob that must finish quickly and a build folder that a `read` cannot reach; a grep with a
file path and a dot path; oversized tool arguments; an unknown tool name that returns a fixed message
without ending the loop; a file whose own name is an excluded folder name; repeated ranges that exceed
the finish budget; a provider answer with a throwing accessor; a grep that stops after 8 MiB of decoded
text and marks the output truncated; a grep that stops before any match and reports
`no matches (truncated)`; a read that renders within its 400-line cap and marks the output truncated; a
read that returns the head of a single over-long line; and accessor non-invocation for options and
input.
