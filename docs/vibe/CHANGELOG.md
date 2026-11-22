# Changelog

> Doc class: living · Owner: release-manager · Last reviewed: 2026-11-21

All notable user-visible changes to Vibecodium. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow the VSCodium scheme `<vscode-version>.<build>` plus a Vibecodium revision once releases start.

## [Unreleased]

### Added

- Project foundation: locked governing docs, documentation suite, guardian sub-agents, governance and docs checks, Windows build preflight.
- The standalone Vibe Context Engine now builds leaf and condensed summary DAGs over lossless session records, protects a fresh tail, and exposes bounded `grep`, `describe`, and `expand` recall tools as module APIs (not yet surfaced in the IDE).

### Changed

- The shipped app, server, Linux, macOS, and Windows installer artwork now use the Vibecodium icon package; upstream icon downloads were replaced with local brand vectors and checked-in branded fallbacks.
- Stable-build product identity defaults now use Vibecodium, including a distinct Windows application identity and artifact base name.
- `dev/build.sh` identity exports (`APP_NAME`, `BINARY_NAME`, `GH_REPO_PATH`, `ORG_NAME`) now respect pre-set environment values and default to the Vibecodium identity, so local builds stamp patch placeholders and name artifacts with Vibecodium branding instead of VSCodium's (CI parity is a separate M0 slice). `ASSETS_REPOSITORY` keeps the upstream `VSCodium/vscodium` assets feed until the own-update-feed slice.
