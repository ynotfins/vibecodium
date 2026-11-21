# Release Checklist

> Doc class: living · Owner: release-manager · Last reviewed: 2026-11-21

Run by `release-manager` before any release build. Public publication is a hard stop (see `GOVERNANCE.md`); everything up to a draft release is autonomous.

1. `node vibe/tools/verify.mjs` passes on `vibe/main`.
2. Every milestone included in the release is `done` in `ROADMAP.md` with acceptance evidence in `STATUS.md`.
3. `CHANGELOG.md` has a section for the version, moved out of `[Unreleased]`.
4. `TECH_RADAR.md` has no overdue rows for shipped components.
5. License audit passes: no GPL, AGPL, non-commercial, ELv2 or SSPL code in shipped artifacts.
6. Build with `bash vibe/dev/build-windows.sh -p` on a clean worktree; record artifact SHA-256 values.
7. Signing: sign the exe and every bundled sidecar once a signing route is chosen; until then mark the release "unsigned".
8. Smoke on a clean Windows machine: silent install, launch, open a project, run one agent task, uninstall. Repeat with the portable zip.
9. Update feed: publish `latest.json` for the new version to the update repository (draft until the owner approves publication).
10. Create a **draft** GitHub release with artifacts, checksums and release notes.
