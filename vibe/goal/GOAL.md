# Goal: build and ship Vibecodium

Build Vibecodium, the standalone Windows-first AI IDE described in `docs/vibe/VISION.md`, until every must-have in `docs/vibe/PRODUCT_SPEC.md` passes its acceptance check and a Windows installer `.exe` plus a portable zip are produced and verified on a clean machine (draft release only).

## How to work

- Follow `AGENTS.md` and `docs/vibe/GOVERNANCE.md` exactly.
- Work milestone by milestone in `docs/vibe/ROADMAP.md` order. One task slice per session.
- Each slice ends with the full guardian chain and a STATUS entry. Never skip a guardian.
- Prefer existing, maintained, permissively licensed components (see `TECH_RADAR.md`) over writing new code; prefer overlay files and built-in extensions over patches.
- Use OpenHands (local Agent Canvas, stable channel) for bounded parallel tasks when it saves time; review its branches with the same guardians.

## Definition of done

1. Every milestone M0 to M12 in `ROADMAP.md` is `done`, with acceptance evidence in `STATUS.md`.
2. `node vibe/tools/verify.mjs --strict` passes on `vibe/main`.
3. `release-manager` PASS on the release checklist up to a draft GitHub release.
4. `STATUS.md` says `Goal state: complete`.

## When to stop early

Set `Goal state: blocked` in `STATUS.md` only when every remaining task is parked for the owner or behind a hard stop, and list each one with what the owner must decide.
