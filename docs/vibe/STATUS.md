# Vibecodium Status

> Doc class: living · Owner: vibe-overseer · Last reviewed: 2026-11-22

Goal state: active
Owner priorities (2026-11-20): alongside M0/M1, begin the standalone engine packages (Vibe Context Engine, multi-project indexer/graph) — they are testable without the IDE build. Build-dependent work continues now that the MSVC Spectre component is installed. Milestone numbering is unchanged.

Current milestone: M0 (in progress)

## Task log

Newest first. One entry per task slice, written by `vibe-overseer` after the after-every-task chain.

### 2026-11-22 — M5 project and user memory

- Goal / must-haves: add persistent, scoped project and user memory to the standalone Vibe Context Engine, with a review surface for pending facts and recall of approved facts across sessions. D3 storage and review contract; binding the review panel UI remains a separate IDE integration step.
- Must-have IDs: D3.
- Files allowed: `src/stable/context-engine/**`, `tests/vibe/memory.test.mjs`, `docs/vibe/CHANGELOG.md`, `docs/vibe/README.md`, `docs/vibe/ROADMAP.md`, `docs/vibe/STATUS.md`, `docs/vibe/TECH_RADAR.md`, `docs/vibe/adr/README.md`, `docs/vibe/dev/BUILD.md`, `docs/vibe/user/README.md`.
- Files forbidden: upstream source, IDE integration, dependencies, AgentCore adapter, token-budget assembly, SQLite persistence, release infrastructure, locked docs.
- Acceptance commands: `node --test tests/vibe/memory.test.mjs`, `node vibe/tools/verify.mjs`.
- Out of scope: review panel UI, model-generated extraction, memory deduplication or ranking, AgentCore mirroring, token-budget assembly, SQLite.
- Branch: `vibe/m5/memory` → PR into `vibe/main`.
- Delivered: `src/stable/context-engine/memory-store.mjs` adds append-only JSONL memory for global user facts and project-scoped facts. New and revised facts are `pending`, reviews gate recall, revisions preserve stable ids, `recall` returns only approved facts by default, `includePending` is explicit, and every returned entry carries `sourceTrust: untrusted-memory-content`. The store validates JSON-safe values and ids, rejects path traversal and Windows-reserved project ids, enforces file/event/entry/nesting/key/value/query/page caps, and serializes writes per store instance. The review API is ready for the later IDE panel; that UI is not wired yet.
- Tests: `node --test tests/vibe/memory.test.mjs` PASS (6/6); `node vibe/tools/verify.mjs` PASS (4/4 steps, 63 tests); `git diff --cached --check vibe/main` clean.
- Guardians: qa-verifier PASS after adding coverage for query/pagination, `get`, serialized writes and resource caps; drift-sentinel PASS on the final staged scope; security-reviewer PASS with low notes (caller-supplied values are not secret-scanned, an own `__proto__` key is not preserved, and Windows ACLs are not tightened by `chmod`); docs-keeper PASS; governance-verifier PASS as not applicable (no locked path); tech-scout PASS as not applicable (Node built-ins only); release-manager PASS as not applicable (not a milestone exit or release build).
- Next step: continue M5 with token-budget assembly (D4); bind the project/user memory review panel in the IDE and add the noted memory hardening before user-facing release.

### 2026-11-21 — M5 summary DAG and recall tools

- Goal / must-haves: build the standalone Vibe Context Engine summary DAG over lossless session records: leaf and condensed summary nodes, a protected fresh tail, and bounded `grep`, `describe`, and `expand` recall tools. D2 (summary DAG and expand retrieval); D1 remains satisfied by the unchanged append-only store.
- Files allowed: `src/stable/context-engine/**`, `tests/vibe/context-engine.test.mjs`, `docs/vibe/dev/BUILD.md`, `docs/vibe/CHANGELOG.md`, `docs/vibe/ROADMAP.md`, `docs/vibe/STATUS.md`.
- Files forbidden: upstream source, IDE integration, dependencies, AgentCore adapter, project/user memory, SQLite persistence, cache-stable prompt assembly, release infrastructure, locked docs.
- Acceptance commands: `node --test tests/vibe/context-engine.test.mjs`, `node vibe/tools/verify.mjs`.
- Out of scope: model-backed summary quality, streaming/incremental compaction, SQLite schema, UI, prompt assembly, AgentCore mirroring, project and user memory.
- Branch: `vibe/m5/summary-dag` → PR into `vibe/main`.
- Delivered: `src/stable/context-engine/summary-dag.mjs` builds leaf and condensed summary nodes over the append-only session store, keeps a configurable fresh tail unsummarized, and exposes bounded `grep`, `describe`, `list`, and `expand` recall. `grep` is case-insensitive literal substring matching with no caller-supplied regular expressions; `expand` pages through the original records; content-bearing results carry `sourceTrust: untrusted-session-content`; and the raw transcript is never rewritten.
- Tests: `node --test tests/vibe/context-engine.test.mjs` PASS (8/8), including recovery of a turn-5 detail through `grep` and `expand` from a 210-record session; `node vibe/tools/verify.mjs` PASS (4/4 steps, 57 tests); `git diff --check` clean.
- Guardians: qa-verifier PASS after the security follow-up; drift-sentinel PASS; security-reviewer PASS after removing regex execution and bounding outputs; docs-keeper PASS after reconciling the living docs; governance-verifier PASS as not applicable (no locked path changed); tech-scout PASS as not applicable (no dependency change); release-manager PASS as not applicable (not a milestone exit or release build).
- Next step: continue M5 with project/user memory (D3) and token-budget assembly (D4) as separate standalone slices; the M4-backed graph integration remains outstanding.

### 2026-11-21 — M0 Vibecodium icon package

- Goal / must-haves: replace the upstream Codium icon sources with Vibecodium-owned vectors and make the build generate its fallback PNG/ICO assets from those local sources instead of downloading upstream artwork. A1 (user-visible branding), G4 build-contract evidence only.
- Files allowed: `icons/**`, `src/stable/resources/{win32,linux,server,[PERSON_NAME]}/*`, `src/stable/src/vs/workbench/browser/media/code-icon.svg`, `README.md`, `tests/vibe/icon-assets.test.mjs`, `docs/vibe/dev/BUILD.md`, `docs/vibe/CHANGELOG.md`, `docs/vibe/STATUS.md`.
- Files forbidden: upstream source, build orchestration outside `icons/`, CI workflows, release infrastructure, installer templates, dependencies, locked docs.
- Acceptance commands: `node --test tests/vibe/icon-assets.test.mjs`, `node vibe/tools/verify.mjs`.
- Out of scope: a full Windows rebuild, installer/zip packaging, CI changes, signing, update-feed activation, trademark clearance.
- Branch: `vibe/m0/brand-icons` → PR into `vibe/main`.
- Delivered: six Vibecodium source vectors for stable and insider replace the upstream `codium_*` artwork; the icon build no longer downloads from `VSCodium/icons` or raw GitHub, renders Linux PNG, Windows ICO, and macOS ICNS fallbacks locally, validates `mktemp`, and fails closed when a renderer is missing. Checked-in app, server, Linux, macOS, Inno, and workbench artwork is regenerated from those vectors; the root README points at the live brand logo and the icon README and build guide describe the contract. `icons/overlay-assets.json` records the branded binary render hashes.
- Tests: `node --test tests/vibe/icon-assets.test.mjs` PASS (7/7); `node vibe/tools/verify.mjs` PASS (4/4 steps, 53 tests); `git diff --check` clean.
- Guardians: qa-verifier PASS after fixing the workbench 1024px transform, README link, and binary evidence; drift-sentinel PASS after fixing README branding, the checked-in macOS icon, and build-guide/tooling wording; security-reviewer PASS (the pre-existing fail-open tool check is now fail-closed); docs-keeper PASS after adding the changelog entry and labelling the unavailable renderer command unverified; governance-verifier PASS as not applicable (no locked path changed); tech-scout PASS (no dependency change); release-manager PASS (not a milestone exit or release build).
- Evidence boundary: this slice proves the source contract, checked-in branded renders, and asset consistency; it did not run a full Windows rebuild or the renderer-backed `bash icons/build_icons.sh` because the loop environment lacks rsvg-convert/png2icns/icotool. Before release, regenerate a clean worktree with that toolchain and compare to `icons/overlay-assets.json`.
- Next step: continue M0 with own update-feed activation and Windows CI parity; the `-p` installer/zip artifact smoke remains parked on the writable native-header cache.

### 2026-11-21 — M0 packaging-smoke correction

- Goal / must-haves: harden and correct the packaging-smoke slice after its merge; A1 (packaged identity/version checks only). No new product acceptance is claimed.
- Files allowed: `vibe/tools/windows-packaging-smoke.mjs`, `tests/vibe/windows-packaging-smoke.test.mjs`, `docs/vibe/dev/BUILD.md`, `docs/vibe/CHANGELOG.md`, `docs/vibe/STATUS.md`.
- Files forbidden: upstream source, build scripts, CI workflows, release publication, signing policy, installer assets, dependencies.
- Acceptance commands: `node --test tests/vibe/windows-packaging-smoke.test.mjs`, `node vibe/tools/verify.mjs`.
- Out of scope: clean-machine install/uninstall, MSI generation, signing, publishing a release, creating a feed repository, changing CI or build scripts.
- Branch: `vibe/m0/packaging-smoke-correction` → PR into `vibe/main`.
- Delivered: rejected empty artifacts, restricted architecture to x64/arm64, expanded the 7-Zip stdout buffer, rejected unsafe zip paths, and required unique portable entries. Corrected the PR #14 status bullet to match its actual merged state and CI outcome.
- Tests: `node --test tests/vibe/windows-packaging-smoke.test.mjs` PASS (5 tests); `node vibe/tools/verify.mjs` PASS.
- Guardians: governance-verifier PASS as not applicable (no locked path changed); tech-scout PASS as not applicable (no dependency changed). Release-manager remains not applicable because no release checkpoint was crossed. Other guardians are pending the branch check.
- Next step: keep the real `-p` artifact smoke parked until the build environment provides a writable native-header cache.

### 2026-11-21 — M0 Windows packaging smoke (parked after tooling)

- Goal / must-haves: create and test a local verifier for Windows system installer, user installer, and portable zip artifacts. This supports later M0 artifact work but claims no G1 or G4 acceptance.
- Must-have IDs: A1 (partial packaged identity/version check only).
- Files allowed: `vibe/tools/windows-packaging-smoke.mjs`, `tests/vibe/windows-packaging-smoke.test.mjs`, `docs/vibe/dev/BUILD.md`, `docs/vibe/CHANGELOG.md`, `docs/vibe/STATUS.md`.
- Files forbidden: upstream source, build scripts, CI workflows, release publication, signing policy, installer assets, dependencies.
- Acceptance commands: `node --test tests/vibe/windows-packaging-smoke.test.mjs`, `node vibe/tools/verify.mjs`. The documented artifact-smoke command is not an acceptance claim because the required local `-p` build remains parked.
- Out of scope: clean-machine install/uninstall, MSI generation, signing, publishing a release, creating a feed repository, changing CI or build scripts.
- Branch: `vibe/m0/windows-packaging-smoke` → PR into `vibe/main`.
- Delivered: `vibe/tools/windows-packaging-smoke.mjs` validates the three required local Windows artifacts, computes SHA-256 for each, checks the portable zip contents, and reads the packaged app identity/version/commit from `resources/app`. `docs/vibe/dev/BUILD.md` documents the command. The actual `-p` packaging run remains parked.
- Attempts: three `bash vibe/dev/build-windows.sh -p` runs failed before compilation. (1) Git Bash used a non-executable winget `jq` shim, fixed by staging an official checksum-verified jq 1.7.1 locally. (2) node-gyp hit `EPERM` writing to the user Electron-header cache; setting `npm_config_devdir` fixed header download but the VS Code preinstall still hardcoded the user cache for custom-header overlay. (3) A retry with a slice-local cache failed because a Windows path contained an accidental tab; the build did not reach native compilation. No repository source or build script was changed in these attempts.
- Blocked artifact smoke: the three attempts stopped in environment/cache setup before compilation, so the `-p` build and this smoke remain unverified; no product-code dependency is known to be missing. The full acceptance still requires a successful `-p` build plus the packaging smoke command above.
- Guardians: qa-verifier PASS after fixing a false-pass CLI guard and adding the nonzero-exit test; drift-sentinel PASS after removing build cache, enforcing packaged commit identity, and adding the “Parked for owner” row; security-reviewer PASS; docs-keeper PASS after correcting the smoke command to build-stamped values and documenting the 7-Zip prerequisite; governance-verifier PASS as not applicable (no locked path changed); tech-scout PASS as not applicable (no new dependency); release-manager PASS as not applicable (no release checkpoint).
- Final verdict: PASS for the delivered packaging-smoke tooling; the actual `-p` installer/zip smoke remains parked and must be rerun after a writable build-cache environment fix.
- Merge outcome: PR #14 merged at 2026-11-21T17:46:22Z as `59af95f9643f1e85c848edfb6f08256f10e6a428`. At the PR head, Windows/Linux compile, Windows/macOS x64 builds, lint, verify, and Devin Review were green or completed, but `build (macos-14, arm64)` was cancelled on the unsupported runner label and two Linux checks later failed on GitHub API 403 rate limits. The rerun was token-blocked; a post-merge correction is in progress.

### 2026-11-21 — M0 release-feed tooling (staging)

- Goal / must-haves: generate platform- and target-scoped update-feed manifests from Windows release asset checksums without publishing them or changing the feed repository. Bridges the completed local manifest contract toward the release pipeline.
- Must-have IDs: G2 (own update-feed contract integration only).
- Files allowed: `vibe/tools/release-feeds.mjs`, `tests/vibe/release-feeds.test.mjs`, `docs/vibe/dev/BUILD.md`, `docs/vibe/CHANGELOG.md`, `docs/vibe/STATUS.md`, `docs/vibe/ops/RELEASE.md`.
- Files forbidden: upstream product source, locked docs, release secrets, installer assets, release workflows, feed or release publication, signing policy.
- Acceptance commands: `node --test tests/vibe/release-feeds.test.mjs`, `node vibe/tools/verify.mjs`.
- Out of scope: release-workflow edits, creating the feed repository, uploading `latest.json`, altering release tags, MSI generation, signing, real release manifests.
- Branch: `vibe/m0/release-feed-tooling` → PR into `vibe/main`.
- Delivered: `vibe/tools/release-feeds.mjs` reads checksum sidecars, maps Windows system/user/archive/MSI assets to scoped feeds, skips the updates-disabled MSI, validates release metadata through the existing feed contract, and writes `latest.json` only to a local staging directory.
- Tests: `node --test tests/vibe/release-feeds.test.mjs` PASS (2 tests); `node vibe/tools/verify.mjs` PASS (4/4 steps, 41 tests). Tests cover scoped output paths, checksum rejection, and update-disabled MSI exclusion.
- Guardians: qa-verifier PASS; drift-sentinel PASS after refreshing rebased evidence; security-reviewer PASS; docs-keeper PASS after correcting scope, behavior, and evidence claims. Governance-verifier not applicable (no locked path changed); tech-scout not applicable (no dependency changed); release-manager not applicable (not a milestone exit or release build).
- Next step: wire release-workflow staging once the loop token has `workflow` scope; then continue with feed-repository selection and the `-p` installer/zip smoke. A later hardening slice should pin release tooling to an immutable product revision.

### 2026-11-21 — M5 lossless session store

- Goal / must-haves: implement the standalone M5 context-engine session store so messages, tool calls, and tool results remain recoverable verbatim after compaction. This is the owner-priority standalone engine work that does not depend on the M0 IDE build.
- Must-have IDs: D1.
- Files allowed: `src/stable/context-engine/**`, `tests/vibe/context-engine.test.mjs`, `docs/vibe/STATUS.md`, `docs/vibe/dev/BUILD.md`, `docs/vibe/ROADMAP.md`.
- Files forbidden: upstream files, release infrastructure, locked docs, dependencies, installer assets.
- Acceptance commands: `node --test tests/vibe/context-engine.test.mjs`, `node vibe/tools/verify.mjs`.
- Out of scope: summary DAG construction, recall tools, embeddings, AgentCore adapter, UI, provider integration, Windows session-root ACL integration, ADR changes.
- Branch: `vibe/m5/lossless-session-store` → PR into `vibe/main`.
- Delivered: `src/stable/context-engine/session-store.mjs` adds an append-only JSONL `SessionStore` for `user`, `assistant`, `system`, `tool_call` and `tool_result` records. Payloads are captured into a canonical JSON-safe snapshot; `Map`, `Date`, `undefined`, `NaN`, functions, symbols, cycles and `toJSON` are rejected. Appends are serialized per instance with contiguous sequence numbers, and the store enforces path containment plus file, record, payload and nesting limits. `compact({ tailCount })` returns the retained tail and removed count without rewriting the append-only log, so the raw transcript stays byte-identical.
- Tests: `node --test tests/vibe/context-engine.test.mjs` PASS (4/4); `node vibe/tools/verify.mjs` PASS (4/4 steps, 39 tests).
- Guardians: qa-verifier PASS; drift-sentinel PASS; security-reviewer PASS (Windows session-root ACL hardening deferred to product integration as a Low note); docs-keeper PASS; governance-verifier PASS (no locked path changed); tech-scout PASS (Node built-ins only; ADR-0003 product design remains separate); release-manager PASS (not a milestone exit or release build).
- Next step: continue M5 with the summary DAG, recall tools, cache-stable assembly, project/user memory, AgentCore adapter and docs-mcp.

### 2026-11-21 — M0 update-feed contract

- Goal / must-haves: establish a platform-scoped update manifest format for the own update feed without publishing a feed, creating a repository, or changing release infrastructure. Supports M0's "own update feed repo" work and later M12 update-feed acceptance.
- Must-have IDs: A1 (identity metadata only), G2 (own update feed contract only).
- Files allowed: `vibe/tools/update-feed.mjs`, `tests/vibe/update-feed.test.mjs`, `tests/vibe/automation.test.mjs`, `docs/vibe/dev/BUILD.md`, `docs/vibe/CHANGELOG.md`, `docs/vibe/STATUS.md`.
- Included verification stabilization: make the Codex guard's `gh pr list` test use an explicit repository so it does not depend on the local dry-run fixture's git remotes.
- Files forbidden: `.github/workflows/**`, upstream files, locked docs, release secrets, installer assets.
- Acceptance commands: `node --test tests/vibe/update-feed.test.mjs`, `node vibe/tools/verify.mjs`.
- Out of scope: publishing artifacts, creating a feed repository, MSI generation, CI changes, signing, real release manifests.
- Branch: `vibe/m0/update-feed-contract` → PR into `vibe/main`.
- Delivered: `vibe/tools/update-feed.mjs` validates release metadata and writes platform/target-scoped `latest.json` files for local staging. It uses the upstream updater contract (`version` = commit, `productVersion` = SemVer, `sha256hash`, timestamp), rejects credential-bearing URLs and unsafe paths, and requires SHA-256 plus size for every artifact. No feed repository was created and nothing was published.
- Tests: `node --test tests/vibe/update-feed.test.mjs` PASS (4 tests, including the documented CLI arguments); `node vibe/tools/verify.mjs` PASS (4/4 steps, 33 tests); `node vibe/tools/verify.mjs --strict` PASS (33 tests); documented CLI command executed with exit 0.
- CI fix: ecformat's PR run flagged tab indentation in the new JavaScript and Markdown indentation in the example. The JavaScript now uses two-space indentation, the Markdown example uses multiples of three spaces, and BUILD.md stays non-BOM UTF-8; both verify modes pass again locally.
- Guardians: qa-verifier PASS; drift-sentinel PASS; security-reviewer PASS after resolving its initial findings (upstream checksum field, credential-bearing URL rejection, SemVer validation, writer path validation); docs-keeper PASS after resolving its initial CLI argument mismatch and correcting the must-have mapping to G2. No locked path changed, so governance-verifier was not applicable. No dependency changed, so tech-scout was not applicable.
- Next step: create or select the own update-feed repository and wire the generated feed into release infrastructure; that remains outside this task card.

### 2026-11-21 — F0 guard test avoids an empty-remote false failure

- Branch: `vibe/f0/gh-pr-list-guard-test` → PR into `vibe/main`.
- Goal / must-haves: make the Codex hard-stop guard test prove that ordinary `gh pr list` remains allowed even when a task fixture has no git remote. Foundation process correctness only; no must-have ID.
- Files allowed: `tests/vibe/automation.test.mjs`, `docs/vibe/STATUS.md`.
- Files forbidden: `vibe/goal/run-goal.ps1`, `.vibe/agents/`, `.opencode/agent/`, locked docs, dependency manifests, upstream paths.
- Acceptance commands: `node --test tests/vibe/automation.test.mjs`, `node vibe/tools/verify.mjs`.
- Delivered: the guard-allowlist regression now invokes `gh pr list --repo ynotfins/vibecodium` explicitly instead of relying on `GH_REPO` injected by the shim, so an empty task fixture cannot hide a false failure.
- Evidence: `node --test tests/vibe/automation.test.mjs` PASS (9/9); `node vibe/tools/verify.mjs` PASS (4/4 steps, 31/31 tests).
- Guardians: qa-verifier PASS; drift-sentinel PASS; security-reviewer PASS after correcting the test to exercise the explicit repository argument; docs-keeper PASS. No locked path, dependency, milestone exit, or release build changed, so governance-verifier, tech-scout, and release-manager were not applicable.

### 2026-11-21 — M0 windows-build delivery + guard hotfix (A1, G4)

- Branch: `vibe/m0/windows-build` → PR #7 into `vibe/main`.
- Delivered: resolved the PR #8 merge conflicts; fixed the guard shim so hyphen arguments pass through and `git push --force` still reports the hard-stop message; gave the GitHub CLI shim non-secret repository context; accepted an ASCII `-` docs header separator for ASCII-only files; and reconciled STATUS, BUILD, CHANGELOG, TECH_RADAR, and related docs/tests. Locked changes are covered by governance approvals 0006 and 0007.
- Tests: `node vibe/tools/verify.mjs --strict` PASS (31/31 tests); new docs-check regression covers ASCII headers; the codex harness test confirms `git push --force` is blocked and `gh pr list` is not. Local `ecformat` is unavailable, so CI remains the final format gate.
- Guardians: qa-verifier PASS after format fixes; drift-sentinel PASS after scope/proposal-location corrections; security-reviewer PASS; docs-keeper PASS; governance-verifier PASS for approvals 0006 and 0007. tech-scout not applicable (no dependency change); release-manager not applicable (not a milestone exit or release build).
- Next: push this branch, wait for PR #7 CI green, merge it, then continue M0 with the own update feed, icons, CI Windows parity, and `-p` installer/zip smoke.

### 2026-11-21 — I1: loop transport measured and hardened

- Branch: `vibe/f0/ssh-transport` → PR into `vibe/main`.
- Problem: the loop's Codex session crashed `git-remote-https.exe` and raised a focus-stealing dialog.
- Measured inside the sandbox (the environment that fails): schannel TLS is unusable (`SEC_E_NO_CREDENTIALS`, curl 35, git 128); `http.sslBackend=openssl` clones, commits and pushes cleanly (all exit 0). SSH is unusable too — the sandbox user cannot read the private key. So OpenSSL stays, with a comment recording why, and nobody should "fix" a transport error by switching back.
- Also fixed: the runner now creates `<clone>.worktrees` before each session (the sandbox can write inside it but cannot create it — that broke the first transport test); `GIT_TERMINAL_PROMPT=0` so a prompt can never block an unattended run.
- Dialog class suppressed at OS level for this user (`HKCU\...\Windows Error Reporting\DontShowUI=1`), outside the repo and reversible.
- Approval record 0009, verifier run on Codex BYOK; `node vibe/tools/verify.mjs` PASS.

### 2026-11-21 — F0 loop uses the repository-scoped GitHub token

- Branch: `vibe/f0/token-from-registry` → PR into `vibe/main`.
- Problem: the owner created `VIBECODIUM_GH_TOKEN`, but the loop's scheduled-task process received a stale environment block and fell back to the account-wide `GITHUB_TOKEN`.
- Delivered: the runner reads that one name from the user registry when the environment lacks it; the value stays in memory and is redacted like every other secret. Verified in a dry run (`gh_token_source=VIBECODIUM_GH_TOKEN`, `secret_vars_left=0`); approval record 0008, written by the verifier running on Codex BYOK.

### 2026-11-20 — M0 reproducible Windows build (A1, G4)

- Branch: `vibe/m0/windows-build` → PR into `vibe/main`.
- Goal: the parked MSVC Spectre-mitigated libraries are installed on the workstation (vswhere reports the component; `lib\spectre\x64\msvcrt.lib` present), so run the first full Vibecodium-branded Windows build and capture A1 acceptance evidence.
- Must-haves: A1 (rebranded build reports its own name and version), G4 evidence baseline (local build script runs end to end on Windows).
- Delivered: `dev/build.sh` identity exports (`APP_NAME`, `ASSETS_REPOSITORY`, `BINARY_NAME`, `GH_REPO_PATH`, `ORG_NAME`) now use `${VAR:-default}` form, defaulting to the Vibecodium identity from `utils.sh` instead of upstream's hardcoded VSCodium values, so patch placeholders (`!!APP_NAME!!`, `!!ORG_NAME!!`, `!!GH_REPO_PATH!!`) and artifact names stamp Vibecodium branding. Insider flag keeps insider identity (`vibecodium-insiders`). `ASSETS_REPOSITORY` stays on the upstream assets repo until the update-feed slice (deferred by task card).
- Tests: new `dev/build.sh must not defeat the branded identity defaults` in `tests/vibe/branding.test.mjs` (written first, red, then green); `node vibe/tools/verify.mjs` PASS (governance, agents, docs, 29 tests).
- Build evidence (A1, G4 baseline): `bash vibe/dev/preflight.sh` all PASS including `spectre`; full `bash vibe/dev/build-windows.sh` from clean clone of VS Code 1.143.1 → EXIT=0 in ~37 min (npm ci incl. native modules with Spectre libs, compile, `vscode-win32-x64-min-packing` 5.73 min, REH 2.72 min). Output `VSCode-win32-x64/`: `Vibecodium.exe` (FileVersion/ProductVersion 1.143.17795, ProductName/FileDescription/CompanyName Vibecodium), `bin/vibecodium{,.cmd,-tunnel.exe}`, `resources/app/product.json` reports nameShort/nameLong `Vibecodium`, `applicationName vibecodium`, `dataFolderName .vibecodium`, `serverApplicationName vibecodium-server`, `urlProtocol vibecodium`, `win32AppUserModelId Vibecodium.Vibecodium`, quality stable; `policies/Vibecodium.admx` (group policy namespace `Software\Policies\Vibecodium`); CLI smoke: `bin/vibecodium --version` → `1.143.17795`, `bin/vibecodium-tunnel.exe --version` → `vibecodium 1.143.17795`.
- Branding scan: only remaining `VSCodium` strings in `product.json` are `updateUrl`/`downloadUrl`/`serverDownloadUrlTemplate` (update feed — separate M0 slice); the built `package.json` keeps `@vscodium/*` npm dependency names (not user-visible).
- Guardians: qa-verifier PASS (independently reproduced test-first red/green, verify suite 29/29, build evidence from log and artifacts); drift-sentinel PASS (scope inside card, no locked-doc contradiction, no dependency drift; notes: keep build-windows.log out of the commit, reh-URL hybrid resolves in the update-feed slice); security-reviewer PASS (no secrets, no new dependencies; residuals: update-feed trust concern until the own-feed slice, env identity values interpolated into sed unsanitized — hardening note); docs-keeper FAIL then PASS (five fixes applied: TECH_RADAR spectre row now truthful, resolved parked row removed, CHANGELOG ASSETS_REPOSITORY caveat, BUILD.md output path corrected, branding-scan attribution fixed); governance-verifier not applicable (no locked path changed — confirmed by governance.mjs status); tech-scout PASS (radar row truthful, version scheme 1.143.1+7795 explained, no missing rows); release-manager PASS (light review: no release created, CHANGELOG and evidence citable for RELEASE.md later).
- Next M0 slices: own update feed repo activation, icons, then CI Windows build parity (G4) and `-p` installer/zip packaging smoke.

### 2026-11-20 — F0 harness v2: Codex BYOK on OmniRoute + OpenCode fallback

- Branch: `vibe/f0/codex-byok` → PR into `vibe/main`. Owner clarified Codex is wanted for the loop — on our own models (BYOK), never the ChatGPT subscription (ADR-0008).
- Delivered: dual-harness runner — OmniRoute (forced first by health check) runs `codex exec` in the `workspace-write` sandbox with an isolated `CODEX_HOME` (no `auth.json` can exist); Morph direct and DeepInfra run OpenCode as the fallback because Codex no longer supports their API format. Morph classes: DeepSeek V4.1 Flash first (standard/cheap), GLM-5.3 for strong/review; Kimi removed per owner. Morph tools through `cmd /c npx` in both harnesses.
- Evidence: `node vibe/tools/verify.mjs` PASS (29 tests incl. dry runs for both harnesses: BYOK config, writable roots, no auth.json, per-class agent TOMLs, deny rules, guard, secret removal); approval record 0005 written by the verifier running on Codex BYOK. Live earlier this session: codex exec on OmniRoute created files, ran commands, spawned a custom agent and listed the four Morph tools.
- Note for the operator: `VIBECODIUM_GH_TOKEN` is not present in Windows user/machine environment variables as of 18:56 — the runner falls back to `GITHUB_TOKEN` until it exists.

### 2026-11-20 — F0 build harness: our own models (OpenCode + OmniRoute + Morph)

- Branch: `vibe/f0/opencode-harness` → PR into `vibe/main`. Owner decision: the build must not use Codex as its primary agent; it runs on our own models (ADR-0007).
- Delivered: runner starts OpenCode 1.19.5 with the `vibe-overseer` agent; providers health-checked in order OmniRoute → Morph direct → DeepInfra (`vibe/goal/models.json`); per-agent model classes; Morph MCP tools (WarpGrep, Fast Apply, GitHub search) always on; isolated OpenCode config and data folders; hard-stop deny list; `.codex/` removed; agents generated into `.opencode/agent/`. Morph added to the product spec as the direct second option (B6) with Fast Apply, WarpGrep, Compact, Router and hosted open models.
- Evidence: `node vibe/tools/verify.mjs` PASS; live smoke on OmniRoute: overseer on `omniroute/agent` launched docs-keeper on `omniroute/cheap` (docs check PASS), Morph tools listed, `git push --force` blocked by the deny list; Morph direct answered on `morph-glm53-744b` and `morph-dsv41flash`.
- Governance: changes to locked files go through the governance-verifier subagent running on our own models (record in `.vibe/governance/approvals/`).

### 2026-11-20 — M0 product identity metadata

- Branch: `vibe/m0/product-identity` → PR into `vibe/main`.
- Goal / must-haves: establish the stable Windows product identity for A1 and G4 without changing upstream source, icons, dependencies, or release infrastructure.
- Delivered: stable build defaults now use `Vibecodium` / `vibecodium`, separate user-data, server, protocol, mutex, application, and context-menu identities; package, server-manifest, Electron, support-link, and Windows installer publisher substitutions are also branded for Vibecodium.
- Tests: `node --test tests/vibe/branding.test.mjs` PASS (covers all changed transformations and replacement Windows identifiers); `node vibe/tools/verify.mjs` PASS (governance, agents, docs, 26 tests).
- Guardians: qa-verifier PASS (after strengthening per-transformation assertions); drift-sentinel PASS; security-reviewer PASS; docs-keeper PASS; tech-scout PASS. No locked path or dependency changed, so governance-verifier was not applicable.
- Technology note: verified upstream VS Code `1.147.0` is only two days old; it is recorded in `TECH_RADAR.md` and deferred to 2026-11-25 under the seven-day policy.
- Remaining M0 evidence after that entry: CI Windows build parity, icon work, update-feed activation, and the `-p` installer/zip smoke. The app-only full-build evidence was subsequently delivered by the M0 windows-build slice.
- Delivery: the unattended session could not push (its sandbox removed the GitHub token from its environment). The bootstrapping session pushed the branch and opened the PR on 2026-11-20; the loop's GitHub access is fixed in the OpenCode runner change.

### 2026-11-20 — F0 foundation

- Branch: `vibe/f0/foundation` → PR into `vibe/main`.
- Delivered: governance (locked docs, approval chain, check), docs suite, eight guardian agent definitions with generated Codex copies, verify suite and tests, Codex Stop-hook validation, CI workflow, Windows build preflight and wrapper, goal runner.
- Checks: `node vibe/tools/verify.mjs` PASS (governance, agents, docs, 25 tests including a Windows dry run of the goal runner); lock tamper test PASS (editing a locked doc fails the check and makes the runner refuse to start).
- Guardians (real Codex sub-agents from `.codex/agents`, three review rounds):
- Round 1: drift-sentinel FAIL (genesis lacked a proposal and its own commit; CI action had no radar row); security-reviewer FAIL (unrestricted sandbox, raw event logs, unvalidated task root).
- Round 2: qa-verifier FAIL (no automation tests); security-reviewer FAIL (writes allowed across sibling worktrees, machine secrets visible to the agent, broad GitHub credential, unsigned bypassed script, no quarantine); docs-keeper FAIL (missing toolchain radar rows, unlabelled unverified commands, branch name); drift-sentinel PASS.
- Round 3, after fixes: qa-verifier PASS, drift-sentinel PASS, security-reviewer PASS (remaining risks documented and mitigated in GOVERNANCE §5), docs-keeper PASS.
- Build evidence: toolchain installed (jq 1.8.2, rustup 1.29.3 / cargo 1.100.0, portable Node 24.18.0, Python 3.11.9, VS Build Tools 2022). A stock baseline build (`bash vibe/dev/build-windows.sh` on `master`) fetched VS Code 1.143.1 and failed in `npm install` with MSB8040: the MSVC Spectre-mitigated libraries are missing. The preflight now checks for them. Installing them needs administrator rights, so it is parked for the owner below; M0 build acceptance waits on it, other M0 work does not.

## Parked for owner

| Item | Why it needs the owner | Default until decided |
|---|---|---|
| Code-signing route | Paid certificate vs SignPath Foundation (free for open source, needs an application) | Unsigned builds; Windows SmartScreen shows "More info → Run anyway" |
| Public repository | `ynotfins/vibecodium` is a public fork; GitHub forks cannot be made private. A closed-source product needs a separate private repository | Continue in the public fork; no secrets or machine details in the repo |
| Product name and trademark check for "Vibecodium" | Legal decision | Working name stays "Vibecodium" |
| MSI installer | WiX v3 is archived; WiX v6+ binaries carry a maintenance-fee EULA for revenue-generating users | Ship Inno `.exe` and portable zip only |
| Complete M0 `-p` Windows artifact smoke | Three unattended build attempts failed before compilation on native-header cache permissions; a writable build cache needs an environment fix outside this task worktree | Retry after the build environment provides a writable node-gyp cache and rerun the packaging smoke command in `docs/vibe/dev/BUILD.md` |
| Upstream base | Stay on VSCodium's cadence or move ahead to newer VS Code | Stay on VSCodium's cadence |
