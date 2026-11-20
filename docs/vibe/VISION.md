# Vibecodium Vision

> Doc class: locked · Owner: vibe-overseer · Last reviewed: 2026-11-20
>
> Changing this file requires a PASS from the `governance-verifier` sub-agent (see `GOVERNANCE.md`).

## One sentence

Vibecodium is a standalone, Windows-first desktop IDE built on VSCodium that feels as close to Cursor as possible, and does better than Cursor at indexing and graphing code across many projects at once, at remembering everything losslessly, and at turning long plain-English prompts into correct, verified software with almost no human in the loop.

## Who it is for

- **Primary:** vibe coders. They write long natural-language prompts, are not professional engineers, and judge the product by whether the result works.
- **Secondary:** professional developers who want Cursor-class AI features with full provider choice, local data and no subscription lock-in.

## What "better than Cursor" means

| Area | Promise |
|---|---|
| Multi-project intelligence | Index and graph several repositories at the same time and show how they interact (shared packages, API routes and their callers, env var names, ports, database tables, MCP tools, containers). |
| Visual graph | A built-in graph panel that zooms from all projects to one project, module and symbol. No external browser. |
| Lossless memory | Every message and decision is kept verbatim on the local disk. A rolling context window summarizes old turns into a drill-down summary DAG, and any detail can be expanded back. Short-term, project and user memory persist across sessions. |
| Huge context, low cost | Use very large context windows where they help, keep prompt prefixes cache-stable so provider prompt caching cuts token spend, and retrieve instead of stuffing. |
| Prompt optimization | Long vibe prompts are rewritten into a short, checkable spec that the user approves with one click. The original prompt is kept verbatim. |
| Autonomy | Plan, build, test and fix loops run on their own. Humans are asked only for business decisions and irreversible real-world actions. |
| Provider freedom | Any provider, any model, local models, smart routing and automatic fallback when a provider fails. |
| Professional by default | Every project starts with an accurate docs suite, locked governing docs, anti-drift checks, QA gates and a technology radar maintained by sub-agents. |

## Product principles

1. **Daily driver first.** Every milestone must leave a working IDE.
2. **Extremely user friendly.** Point-and-click setup. No hand-edited config as the primary path.
3. **Local first.** Indexes, memory, traces and caches live on the user's machine (fast NVMe). Cloud is optional and user-chosen.
4. **Thin fork.** Stay close to VSCodium and VS Code. New code goes into overlay files, built-in extensions and sidecars; patches stay few and small so monthly upstream updates stay cheap.
5. **Evidence over claims.** Nothing is "done" without a passing check that anyone can re-run.
6. **Best available technology.** Components are re-evaluated continuously against the newest releases so the product never ships on an outdated choice.
7. **Portable.** Ships as a Windows installer `.exe` and a portable zip that run on other PCs without Docker or WSL.

## Non-goals (v1)

- A hosted Vibecodium cloud service.
- Mobile clients.
- Re-implementing what VS Code core already maintains under MIT (agent sessions UI, worktrees, checkpoints, inline completions UI).
