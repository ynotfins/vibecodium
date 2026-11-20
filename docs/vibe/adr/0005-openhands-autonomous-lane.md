# ADR-0005: OpenHands as the autonomous background lane

> Doc class: living · Owner: docs-keeper · Last reviewed: 2026-11-20

- Status: accepted
- Date: 2026-11-20

## Context

OpenHands Agent Canvas (MIT core) is maintained and ships often: v1.43.0 on 2026-11-20 with agent-server 1.63.1. Releases v1.16 through v1.42 added Apps (beta), local Plan Mode, ACP agent profiles, automations and per-repo git provider selection. The old OpenHands CLI is no longer maintained. The agent runtime does not support native Windows; it runs in Docker.

## Decision

- The product offers OpenHands as an optional background lane (PRODUCT_SPEC E5) through the agent-server API, with a stable channel (pinned release tag) and an edge channel (rolling `main` image), selectable in settings.
- The core IDE never requires Docker.

## Consequences

Integration work is in M8. The owner's workstation already runs both channels; that setup is documented in the owner's workstation notes, not in the product.
