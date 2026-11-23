# Building Vibecodium on Windows

> Doc class: living - Owner: docs-keeper - Last reviewed: 2026-11-23

Vibecodium builds with VSCodium's scripts. Run everything in **Git Bash** from the repository root.

## 1. Toolchain

| Tool | Version | Notes |
|---|---|---|
| Git for Windows | any current | Provides Git Bash |
| Node.js | exactly the version in `.nvmrc` | A portable Node folder works; point `VIBE_NODE_HOME` at it |
| Python | 3.11.x | Used by node-gyp; point `VIBE_PYTHON` at it if `py -3.11` is not available |
| jq, 7-Zip | any current | 7-Zip is found in `C:\Program Files\7-Zip` automatically |
| Rust | stable via rustup | |
| Visual Studio Build Tools | 2022 with the C++ workload | |
| MSVC Spectre-mitigated libraries | component `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre` | Required by VS Code's native modules (MSB8040 without it). Install from an **elevated** PowerShell, see below |

If the Spectre libraries are missing, add them (one time, needs administrator rights):

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe" modify --installPath "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools" --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --passive --norestart
```

Check everything:

```bash
bash vibe/dev/preflight.sh
```

Every line must say `PASS`. *Verified 2026-11-20 (all PASS, including `spectre`).* The `spectre` component is installed on the build workstation.

## 2. Build

### Brand icons

The source vectors are `icons/<quality>/vibe_*.svg`. The checked-in overlay icons under `src/stable/resources/` (Windows app and Inno artwork, Linux, server, and the workbench icon) are generated from those vectors. `bash icons/build_icons.sh` regenerates any missing icon asset (delete an existing target to force a re-render); it requires ImageMagick, librsvg, png2icns, icotool and coreutils `mktemp`; `docs/howto-build.md` describes the upstream icon toolchain. The regeneration command was not executed in this slice because the renderer toolchain (rsvg-convert, png2icns, icotool) is not installed in the loop environment; the checked-in outputs and the contract test are verified. The icon contract test verifies the vectors, the build script's local-only sources, and the shipped overlay dimensions:

```bash
node --test tests/vibe/icon-assets.test.mjs
```

### Context engine: summary DAG

The standalone Vibe Context Engine builds a leaf-and-condensed summary DAG over the lossless session records and keeps the newest records in a protected fresh tail. Summaries are model-agnostic: the caller supplies a summarizer, so the engine does not depend on a provider, network connection, or IDE build. The DAG object exposes bounded `grep`, `describe`, and `expand` tools; `grep` is a case-insensitive literal substring search (no caller-supplied regular expressions), `list` and `expand` paginate, and content-bearing results carry `sourceTrust: untrusted-session-content` for later quarantine. `expand` pages through the original records inside a summary node without rewriting the append-only transcript.

The contract test builds a 210-turn session, finds a detail stored at record sequence 5 with `grep`, and retrieves it through `expand`; it also proves that `expand` returns only summarized records and that `grep` excludes the fresh tail unless `includeTail` is requested:

```bash
node --test tests/vibe/context-engine.test.mjs
```

### Context engine: project and user memory

The standalone memory store persists facts across sessions in two scopes. User memory is global at `<root>/user/memory.jsonl`; project memory is isolated at `<root>/projects/<sha256-of-projectId>/memory.jsonl`, so identifiers that differ only by case cannot collide on Windows. The store accepts JSON-safe values, serializes writes per scope within a store instance, and normally appends `put`, `review`, and `delete` events. Repeating a key writes a new `put` with the same id and the next `revision`.

New and revised facts start as `pending`. `recall` returns approved facts only unless `includePending` is requested, in which case pending facts are included alongside approved facts; every returned entry carries `sourceTrust: untrusted-memory-content`. `review` defaults to the pending queue and can filter by `approved`, `rejected`, or `all`. `approve`, `reject`, and `forget` require the id and exact revision just reviewed; a stale revision is rejected rather than applying a decision to a newer value. A new key is rejected once 10,000 facts are live, while revisions of existing facts remain allowed. The review panel UI is not wired yet.

The store enforces hard caps: 20,000,000 bytes per log, 256,000 bytes per event, 10,000 live entries, 32 levels of value nesting, 200 characters for keys and queries, 16,000 characters for string values, and at most 500 items per review or recall page (default 100). If the next event cannot fit, the store atomically compacts the log to one `put` per live fact, preserving ids, revisions, status, values, and timestamps, then appends the new event. Event history before such a compaction is intentionally discarded; live state and review and deletion semantics are preserved.

```bash
node --test tests/vibe/memory.test.mjs
```

### Context engine: token-budget assembly

`assembleContext` turns the fixed prompt sections into one budgeted string in the architecture order: system, rules, spec, repo map, summary blocks, fresh tail. It never returns more than `modelWindow - reserveTokens`. Required `system`, `rules`, and a provided `spec` fail closed with `ContextBudgetError` when they cannot fit; section text is never rewritten or truncated. Summary blocks are included whole, and once one does not fit the remaining blocks are dropped; the fresh tail keeps a contiguous newest suffix while dropping older records. The report lists included and omitted sections, summary ids, tail sequences, total tokens, the estimator, and per-section sha256 hashes. The fully joined prompt, including section separators, is measured with the bounded token count (the supplied tokenizer floored at the conservative UTF-8 byte upper bound) before a fit is reported; if that exact count exceeds the budget, optional content is removed until it fits. Passing the previous hash list back in reports the first changed section and how much prefix can be reused, so a growing tail leaves the summary prefix cached while a revised summary invalidates the cache from the summaries section onward. Content from the repo map, summaries and the tail is wrapped in in-band untrusted markers and carries `sourceTrust: untrusted-repository-content` or `untrusted-session-content`; marker strings inside content are escaped. System, rules and spec are trusted configuration. The in-band markers are a warning boundary, not a security boundary; normalization and quarantine remain M6 work, and `reserveTokens` defaults to 0, so callers should reserve output space explicitly. Tail payloads must be trees: repeated object references and cycles are rejected, with caps on nodes, object keys, array items, key length and accumulated strings, and the tail and summary totals are capped. The summary loop stops rendering blocks once the budget closes.

Token counts default to a conservative UTF-8 byte upper bound (`bytes + 1`) plus per-section or per-record overhead, so a byte-level BPE tokenizer cannot exceed the reported budget. The budget decision always uses at least that byte bound; a caller-supplied `tokenizer(text) -> tokens` can only raise the count (it tightens the budget), never lower it, so an under-counting host tokenizer cannot make the assembled prompt exceed `modelWindow - reserveTokens`. The report records `estimator: provided-bounded-by-utf8-byte-upper-bound` or `estimator: utf8-byte-upper-bound`. Caller tokenizers must be functions, must return a non-negative integer, and must return 0 only for empty text; the assembler measures the fully joined prompt, including separators, before reporting a fit. Whitespace-only `rules`, `spec` or `repoMap` values are rejected rather than silently treated as absent. IDE integration and memory-fact assembly are separate slices.

```bash
node --test tests/vibe/token-budget.test.mjs
```

### Context engine: optional AgentCore adapter

`AgentCoreAdapter` mirrors a `SessionStore` transcript to `agentcore-memory` when the caller supplies a client with `hydrate({ sessionId })`, `append({ sessionId, records })` and `close({ sessionId })`. Without a client the adapter is a local-only no-op, so the context engine keeps working offline. `hydrate()` copies missing remote records into the local append-only store and fails closed on a shorter or conflicting remote transcript; it compares records by content rather than object prototype or key order, so a null-prototype client record matches the ordinary object that `SessionStore` reads back. Missing records are imported through `SessionStore.appendIfUnchanged(expected, records)`, which re-reads the local store under the same write queue that serializes appends, verifies the expected prefix is unchanged, and only then writes; a local append that lands while the remote fetch is in flight therefore makes hydration fail closed instead of appending a stale remote tail or advancing the cursor. The store passed to the adapter must provide `readAll()`, `append()` and `appendIfUnchanged()`. `append()` sends only unmirrored records in batches of at most 1,000 and requires an `accepted` count for each batch; `close()` flushes the tail, then closes the remote session. A caller can pass `mirrored` to resume from a persisted cursor. The local store stays authoritative: remote failures are wrapped in `AgentCoreAdapterError` with the phase and session id, never retain the raw client error as `cause`, and do not alter the local transcript, so payload text from a client error never crosses the boundary and a later call retries.

The compare-and-append path pre-validates the entire batch before writing any record, so a rejected batch leaves the store unchanged; an I/O failure after pre-validation can still leave an already-written valid prefix, and the unadvanced cursor makes a retry resume safely. The lock is in-process only, consistent with the store's single-writer assumption.

Caps fail closed before any local write: 200 characters per session id, 100,000 records, 999,999 bytes per record (one below the local store's 1,000,000-byte line cap, which includes the trailing newline), 49,900,000 bytes per session (the local 50,000,000-byte file cap less one newline per record), 32 levels of payload nesting and 250,000 payload nodes; records must be contiguous from sequence 0 and contain exactly `kind`, `payload` and `sequence`, with a `kind` the session store supports. The byte budget is charged during the payload walk, including the record envelope, keys and JSON escape expansion. The walk also builds a validated snapshot, and only that snapshot is stored, so an oversized string, key or array is rejected before any serialization and a `toJSON` hook, getter or later mutation cannot change what was measured; an unreadable property (a throwing accessor or a proxied object) fails as `AgentCoreAdapterError` without payload text. Valid JSON keys are preserved verbatim, including an own `__proto__` key, which the session store now captures as an own data property. The client is caller-supplied and must cap its own response size; the adapter can only validate records after the client materializes them. Hydrated results carry `sourceTrust: untrusted-session-content`. The `append` client call must be idempotent per `(sessionId, sequence)` because a batch whose acknowledgement is lost may be retried. The adapter has not been exercised against a live AgentCore gateway or PostgreSQL; the contract test uses an in-memory fake:

```bash
node --test tests/vibe/agentcore-adapter.test.mjs
```

### Code index: project symbols and text

`src/stable/index-engine/index-engine.mjs` is the standalone per-project index. It extracts TypeScript and JavaScript declarations (functions, classes, interfaces, types, enums, namespaces, variables, class methods, getters and setters) with a deterministic built-in parser; tree-sitter and LSP providers remain M4 work. The same pass builds a case-insensitive identifier index, excluding comment and string-literal contents. Declarations inside comments and strings are not indexed, and a UTF-8 BOM does not hide the first declaration.

The index is written atomically to `.vibe/index/index.json` by default, with a configurable relative `indexDir` and simple JSON `indexFile`. A refresh reuses entries whose SHA-256 hash is unchanged; `reindexFile(relativePath)` reads and hashes one file and rewrites the index. File and directory symlinks are not followed. Every source read is opened with no-follow where the platform supports it, then revalidated against its directory entry so a swapped path fails closed. Every index-directory segment is checked before creation, and the write is revalidated before and after the atomic rename. File, directory, file-size, symbol, token and index sizes are capped, and the persisted index contains only per-file entries and metadata, never a derived symbol array. A corrupt, oversized or inconsistent index is rejected on load and rebuilt by the next refresh. Paths are project-relative POSIX paths; absolute paths, drive prefixes, traversal segments, alternate-data-stream colons and control characters are rejected. indexDir and indexFile also reject Windows reserved device names. Comment, string and regex-literal bodies are excluded from the identifier index.

```bash
node --test tests/vibe/index-engine.test.mjs
```

The fixture at `tests/fixtures/repo-ts` has 24 known symbols. The test requires at least 95% of them to be indexed and requires a one-file reindex to finish in under 2 seconds. It also covers persistence, corrupt-index rejection, identifier search, symlink and oversized-file skipping, path traversal rejection, BOM handling, and declaration extraction without false matches from comments or strings.

### Code index: multi-project registry

`src/stable/index-engine/project-registry.mjs` registers up to 32 project roots by caller-supplied id. Each project keeps its own `ProjectIndex` and the registry-owned index stays in memory; persistence remains the standalone index engine's default, but the registry does not publish to disk until a later verified IDE binding. Registration resolves and pins the real root plus its device/inode identity, rejects duplicate roots and unsafe ids, refreshes the index, revalidates the root after indexing, installs watchers, and performs a catch-up refresh before recording the project. A failed catch-up clears the timer and watchers before the project is removed. `ProjectIndex` accepts a pinned `expectedRoot` identity; pinned indexes enforce their stored identity on every refresh and reject reindex calls, reject a root that changes around reads, and `verifySnapshot()` re-hashes every candidate file against the pinned root. Every registry refresh validates the pinned root before and after indexing; if a check fails, the previous in-memory snapshot is restored instead of serving content from the moved tree. Unix uses a bounded per-directory `fs.watch` tree that excludes ignored directory names before installing watches; Windows uses reconciliation polling at the configured interval because recursive watches can crash on unreadable directories and open directory handles can block root swaps. The watcher ignores the resolved index file and its temporary files, while source files in a custom index directory remain watched; moving that directory out of the project drops its stale entries and watches. Ignored path segments are compared case-insensitively, and registration and refresh queues are bounded to 32 pending operations. If watcher creation fails, a directory cannot be listed, a watcher errors, or an event arrives without a usable filename, polling takes over at the configured interval. Watcher events are coalesced into an immediate refresh plus at most one queued follow-up; refreshes are serialized per project, and one project's failure is recorded in `stats()` without stopping the others. `stats()` exposes `mode` (`watch` or `poll`) and the number of active directory watchers. `list()` reports registered ids and roots; `get()`, `index()`, `symbols()` and `searchText()` read one project without crossing boundaries; `refresh()`, `refreshAll()` and `close()` manage lifecycle. The registry is in-memory only, and IDE binding is later M4/M6 work.

```bash
node --test tests/vibe/project-registry.test.mjs
```

The registry test copies the fixture three times, registers all three repositories, edits the same relative source file in parallel, and waits for each project to expose only its own new symbol. It also covers duplicate roots, unsafe ids, unknown projects, case-insensitive duplicate ids, root swaps during registration and refresh, forged snapshots built from outside content, conflicting caller identities that cannot override the stored pin, empty-filename watcher events falling back to polling, native per-directory watches on Unix, Windows reconciliation polling, files saved during registration, atomic file replacement, ignored-tree exclusion, source edits inside a custom index directory, custom-directory moves, generated index files that must not feed the watcher, valid Linux filenames that cannot be indexed, the `index()` accessor, and a parallel `refreshAll()`. Four Unix-only cases skip on Windows.

### Update-feed manifests - local staging only

To prepare the platform-scoped `latest.json` files for the own update feed without publishing, create a release manifest containing the product fields and one entry per artifact:

```json
{
   "name": "Vibecodium",
   "version": "1.147.0",
   "commit": "<commit>",
   "date": "YYYY-MM-DD",
   "quality": "stable",
   "assets": [
      {
         "platform": "win32",
         "architecture": "x64",
         "target": "system",
         "path": "Vibecodium-x64-system.exe",
         "sha256": "<64-hex-checksum>",
         "size": 123456
      }
   ]
}
```

Run the generator against a non-public staging folder:

```bash
node vibe/tools/update-feed.mjs --manifest release.json --out ../update-feed-staging --asset-url-root https://releases.example.com/vibecodium/1.147.0
```

The generator validates the update-service fields, requires a SHA-256 checksum and size for every artifact, emits `sha256hash`, and writes one manifest per quality/platform/architecture combination, with an extra target segment for Windows installer and archive assets. `version` follows the updater contract as the commit and `productVersion` as the semver product version. It does not upload or publish anything.

The packaged app's `updateUrl` is `https://raw.githubusercontent.com/${GH_REPO_PATH:-ynotfins/vibecodium}/refs/heads/vibe/main/update-feed` and its `downloadUrl` defaults to `https://github.com/${ASSETS_REPOSITORY:-ynotfins/vibecodium}/releases`; a local `dev/build.sh -i` insider build targets the branded `ynotfins/vibecodium-insiders` repository, matching the primary CI value `${repository}-insiders`. That repository does not exist yet; the upstream winget job still hardcodes the VSCodium insider repository (`VSCodium/vscodium-insiders`), and creating/wiring the branded insider repository is release work (M12) and out of scope here. Publishing the generated manifests into `vibe/update-feed` is also release work (M12) and is not done here.

When the M12 publish wiring lands, the stable and insider Windows publish workflows will check out the product tooling from `vibe/main` and run `node vibecodium-tooling/vibe/tools/release-feeds.mjs` after checksum preparation. The tool reads the release asset directory and its `.sha256` sidecars, skips the updates-disabled MSI, and maps the remaining Windows assets to `system`, `user`, `archive`, and `msi` feeds. The workflows will upload the resulting `latest.json` files as build artifacts named `update-feeds-<architecture>` for staged verification only; they do not upload feeds to a release or create a feed repository.

```bash
bash vibe/dev/build-windows.sh       # app only
bash vibe/dev/build-windows.sh -p    # app plus installer .exe and zip (not yet verified in this slice)
```

After a stable `-p` build, verify the Windows system installer, user installer, and portable zip:

```bash
source dev/build.env
node vibe/tools/windows-packaging-smoke.mjs --assets assets \
   --name Vibecodium \
   --version "$RELEASE_VERSION" \
   --commit "$BUILD_SOURCEVERSION"
```

Run this in Git Bash with 7-Zip on `PATH` (source `vibe/dev/preflight.sh` in the same session; it adds `C:\Program Files\7-Zip` when present). `dev/build.sh` writes the generated `RELEASE_VERSION` and the stamped `BUILD_SOURCEVERSION` to `dev/build.env`. `--commit` is the value the build stamps into `resources/app/product.json`; it is `BUILD_SOURCEVERSION`, not the upstream VS Code commit (`MS_COMMIT`).

The command fails if any required artifact is missing, if a SHA-256 cannot be computed, if `7z` cannot list or extract the portable zip, or if the packaged app does not carry the expected Vibecodium name, version, commit, executable, launcher, and product metadata. It does not install anything.

*Verified 2026-11-20 for the app-only build on the build workstation (preflight PASS including `spectre`; full build from clean clone through `npm ci`, native modules, compile and `vscode-win32-x64-min-packing`, producing `VSCode-win32-x64/` in the repository root, branded as Vibecodium).* The wrapper runs the preflight, pins node-gyp to Python 3.11 and calls `dev/build.sh` with the same flags. The `-p` installer/zip smoke remains pending. Output appears in the repository root (`VSCode-win32-x64/`, beside the `vscode` checkout).

## 3. Checks before committing

```bash
node vibe/tools/verify.mjs
```

*Verified 2026-11-20; also run by CI and covered by `tests/vibe/`.*

## 4. Upstream sync

`master` mirrors `VSCodium/vscodium`. To take a new upstream release (*not yet verified; first exercised at the first upstream release after M0*):

```bash
git fetch upstream
git checkout master && git merge --ff-only upstream/master
git checkout vibe/main && git merge master
node vibe/tools/verify.mjs && bash vibe/dev/build-windows.sh
```
