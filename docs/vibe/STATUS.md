# Vibecodium Status

> Doc class: living · Owner: vibe-overseer · Last reviewed: 2026-11-20

Goal state: active

Current milestone: M0 (next)

## Task log

Newest first. One entry per task slice, written by `vibe-overseer` after the after-every-task chain.

### 2026-11-20 — F0 foundation

- Branch: `vibe/f0/foundation` → PR into `vibe/main`.
- Delivered: governance (locked docs, approval chain, check), docs suite, eight guardian agent definitions with generated Codex copies, verify suite and tests, Codex Stop-hook validation, CI workflow, Windows build preflight and wrapper, goal runner.
- Checks (run by the bootstrapping session; the guardian sub-agents are defined in this slice and take over from the next one): `node vibe/tools/verify.mjs` PASS (governance, agents, docs, 19 tests); lock tamper test PASS (editing a locked doc fails the check); formatting check against `.editorconfig` PASS; no secrets, no new runtime dependencies.
- Build evidence: toolchain installed (jq 1.8.2, rustup 1.29.3 / cargo 1.100.0, portable Node 24.18.0, Python 3.11.9, VS Build Tools 2022). A stock baseline build (`bash vibe/dev/build-windows.sh` on `master`) fetched VS Code 1.143.1 and failed in `npm install` with MSB8040: the MSVC Spectre-mitigated libraries are missing. The preflight now checks for them. Installing them needs administrator rights, so it is parked for the owner below; M0 build acceptance waits on it, other M0 work does not.

## Parked for owner

| Item | Why it needs the owner | Default until decided |
|---|---|---|
| Install MSVC Spectre-mitigated libraries | Needs an elevated (administrator) PowerShell; command in `dev/BUILD.md` §1 | M0 build acceptance waits; other work continues |
| Code-signing route | Paid certificate vs SignPath Foundation (free for open source, needs an application) | Unsigned builds; Windows SmartScreen shows "More info → Run anyway" |
| Public repository | `ynotfins/vibecodium` is a public fork; GitHub forks cannot be made private. A closed-source product needs a separate private repository | Continue in the public fork; no secrets or machine details in the repo |
| Product name and trademark check for "Vibecodium" | Legal decision | Working name stays "Vibecodium" |
| MSI installer | WiX v3 is archived; WiX v6+ binaries carry a maintenance-fee EULA for revenue-generating users | Ship Inno `.exe` and portable zip only |
| Upstream base | Stay on VSCodium's cadence or move ahead to newer VS Code | Stay on VSCodium's cadence |
