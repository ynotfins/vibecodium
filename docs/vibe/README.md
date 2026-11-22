# Vibecodium Documentation

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-22

Vibecodium is a standalone, Windows-first AI IDE built on VSCodium. This folder is the product's documentation suite. The upstream VSCodium docs in `docs/` (outside `docs/vibe/`) describe the base build and are left unchanged.

## Governing documents (locked)

| Doc | Purpose |
|---|---|
| [VISION.md](VISION.md) | What the product is, who it is for, what "better than Cursor" means |
| [PRODUCT_SPEC.md](PRODUCT_SPEC.md) | Must-have capabilities with IDs and acceptance checks |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Binding architecture principles and component choices |
| [GOVERNANCE.md](GOVERNANCE.md) | Doc classes, the lock, the after-every-task chain, autonomy contract and hard stops |
| [../../AGENTS.md](../../AGENTS.md) | Operating rules for every agent working in this repo |

## Living documents

| Doc | Purpose |
|---|---|
| [ROADMAP.md](ROADMAP.md) | Milestones and their status |
| [STATUS.md](STATUS.md) | Current state, task log, parked decisions |
| [TECH_RADAR.md](TECH_RADAR.md) | Every component, its version, the latest release and alternatives |
| [CHANGELOG.md](CHANGELOG.md) | User-visible changes per release |
| [SECURITY.md](SECURITY.md) | Security model and how to report issues |
| [adr/README.md](adr/README.md) | Architecture decision records |
| [dev/BUILD.md](dev/BUILD.md) | How to build Vibecodium on Windows |
| [ops/RELEASE.md](ops/RELEASE.md) | Release checklist |
| [user/README.md](user/README.md) | User guide |

## Archive

| Doc | Purpose |
|---|---|
| [research/2026-11-08-architecture-plan.md](research/2026-11-08-architecture-plan.md) | Original research and architecture plan |

## Checks

`node vibe/tools/verify.mjs` runs every documentation, governance and agent-definition check. It must pass before any commit.
