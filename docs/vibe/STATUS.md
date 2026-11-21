# Vibecodium Status

> Doc class: living · Owner: vibe-overseer · Last reviewed: 2026-11-21

Goal state: active
Owner priorities (2026-11-20): alongside M0/M1, begin the standalone engine packages (Vibe Context Engine, multi-project indexer/graph) — they are testable without the IDE build. Build-dependent work continues now that the MSVC Spectre component is installed. Milestone numbering is unchanged.

Current milestone: M0 (in progress)

## Task log

Newest first. One entry per task slice, written by `vibe-overseer` after the after-every-task chain.

### 2026-11-21 — M0 windows-build delivery + guard hotfix (A1, G4)

- Branch: `vibe/m0/windows-build` → PR #7 into `vibe/main`.
- Delivered: resolved the PR #8 merge conflicts; fixed the guard shim so hyphen arguments pass through and `git push --force` still reports the hard-stop message; gave the GitHub CLI shim non-secret repository context; accepted an ASCII `-` docs header separator for ASCII-only files; and reconciled STATUS, BUILD, CHANGELOG, TECH_RADAR, and related docs/tests. Locked changes are covered by governance approvals 0006 and 0007.
- Tests: `node vibe/tools/verify.mjs --strict` PASS (31/31 tests); new docs-check regression covers ASCII headers; the codex harness test confirms `git push --force` is blocked and `gh pr list` is not. Local `ecformat` is unavailable, so CI remains the final format gate.
- Guardians: qa-verifier PASS after format fixes; drift-sentinel PASS after scope/proposal-location corrections; security-reviewer PASS; docs-keeper PASS; governance-verifier PASS for approvals 0006 and 0007. tech-scout not applicable (no dependency change); release-manager not applicable (not a milestone exit or release build).
- Next: push this branch, wait for PR #7 CI green, merge it, then continue M0 with the own update feed, icons, CI Windows parity, and `-p` installer/zip smoke.

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
- Remaining M0 evidence: a full Windows build and installer smoke remain blocked on the parked MSVC Spectre libraries. Update-feed activation and icon work are separate M0 slices.
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
| Create a fine-grained GitHub token for the goal loop | Only the owner can mint tokens. Scope: repository `ynotfins/vibecodium`, permissions Contents and Pull requests read/write; store as User environment variable `VIBECODIUM_GH_TOKEN` | Loop uses the owner's broad `GITHUB_TOKEN` and logs a warning |
| Code-signing route | Paid certificate vs SignPath Foundation (free for open source, needs an application) | Unsigned builds; Windows SmartScreen shows "More info → Run anyway" |
| Public repository | `ynotfins/vibecodium` is a public fork; GitHub forks cannot be made private. A closed-source product needs a separate private repository | Continue in the public fork; no secrets or machine details in the repo |
| Product name and trademark check for "Vibecodium" | Legal decision | Working name stays "Vibecodium" |
| MSI installer | WiX v3 is archived; WiX v6+ binaries carry a maintenance-fee EULA for revenue-generating users | Ship Inno `.exe` and portable zip only |
| Upstream base | Stay on VSCodium's cadence or move ahead to newer VS Code | Stay on VSCodium's cadence |
