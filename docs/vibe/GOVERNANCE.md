# Vibecodium Governance

> Doc class: locked · Owner: governance-verifier · Last reviewed: 2026-11-20
>
> How documents are classified, how locked documents change, how the autonomous build loop runs, and which actions always stop for the owner. Changing this file requires a PASS from the `governance-verifier` sub-agent.

## 1. Document classes

Every Markdown file under `docs/vibe/` starts with a header line: `Doc class: <class> · Owner: <agent> · Last reviewed: <YYYY-MM-DD>`.

| Class | Meaning | Who may change it |
|---|---|---|
| `locked` | Governing intent: vision, spec, architecture principles, governance, agent contract | Any agent may propose; the change lands only with a `governance-verifier` PASS record |
| `living` | Must always match reality: roadmap, status, tech radar, build guide, user guide, changelog, designs | The owning agent updates it after every task; `docs-keeper` reconciles |
| `generated` | Produced by a tool | Only the generator; never hand-edited |
| `archive` | Historical input kept for reference | Never edited except the header |

## 2. The lock

- `.vibe/governance/locks.json` lists every locked path and its SHA-256 (computed on LF-normalized content).
- `.vibe/governance/approvals/NNNN-<slug>.md` is the approval chain. Each record names the verifier, the verdict and one or more lines `lock: <path> <old-sha|-> -> <new-sha>`.
- `node vibe/tools/governance.mjs check` fails when a locked file's content does not match the latest approved hash, when `locks.json` disagrees with the chain, or when a record is malformed or not a PASS.
- The check runs in `node vibe/tools/verify.mjs`, before every goal-loop session (the runner refuses to start when it fails) and in CI (`.github/workflows/vibe-governance.yml`).
- The lock covers the check itself and the autonomous loop: the governance tool and its helper library, the governance-verifier definition, the CI workflow, the goal runner, its prompt, its registration script, `vibe/goal/GOAL.md`, this file and `AGENTS.md` are locked. The runner refuses to start a session when the governance check fails.

Honest limit: this is a process lock, not a security boundary. A determined agent could forge a record. Forgery is detectable because records must be created in their own commit and must reference a proposal; `drift-sentinel` and CI review this on every change.

## 3. Changing a locked document

1. The proposer writes `.vibe/governance/proposals/<date>-<slug>.md`: what changes, why, the affected must-have IDs and the exact new text.
2. The proposer spawns `governance-verifier` (a separate sub-agent with no stake in the change).
3. The verifier checks: the change serves `VISION.md`; it does not silently drop a must-have; it does not weaken a hard stop; dependent docs, roadmap and tests are updated in the same change; ADRs exist for component changes.
4. On PASS the verifier applies the text and runs `node vibe/tools/governance.mjs approve --slug <slug> --proposal <file> --path <path>...`, which writes the record and updates `locks.json`. On FAIL it writes the reasons into the proposal and nothing is applied.
5. Record, doc change and lock update go in one commit titled `governance: <slug>`.

## 4. The after-every-task chain

Every task slice, by any agent, ends with this chain before it is committed. Each guardian is a separate sub-agent defined in `.vibe/agents/` (OpenCode copies are generated into `.opencode/agent/`; each declares a model class that the runner maps to one of our models).

| Order | Guardian | Runs when | Blocks on |
|---|---|---|---|
| 1 | `qa-verifier` | always | failing or missing tests for changed behaviour; no evidence |
| 2 | `drift-sentinel` | always | change outside the task card; contradiction with a locked doc; dependency with no radar row |
| 3 | `security-reviewer` | dependencies, config, CI, packaging, network or secret-adjacent code changed | secret exposure, disallowed license, unpinned binary |
| 4 | `docs-keeper` | always | docs check failure; living doc out of date with the change |
| 5 | `governance-verifier` | a locked path changed | missing or failed approval |
| 6 | `tech-scout` | a dependency or component was added or changed, at every milestone start, and weekly | new dependency without a radar row; adopted version younger than 7 days without a security reason |
| 7 | `vibe-overseer` | always | writes the STATUS entry, commits, opens or merges the PR, picks the next task |

`release-manager` runs at every milestone exit and before any release build.

## 5. Autonomy contract

The owner granted full autonomy for the build (UNLOCK of `D:\vscodium\AGENTS.md`, 2026-11-20). The loop does not pause between tasks or milestones.

- **Uncertain choices** go on a branch named `vibe/alt/<slug>` with a draft PR and an ADR in status `proposed`. Trunk continues with the conservative option. The owner can switch later.
- **Parked business decisions** are written to `STATUS.md` under "Parked for owner" and the loop continues with other work.
- **Stuck work** (three failed attempts at the same acceptance test) is parked the same way with the evidence, and the loop moves to the next unblocked task.

### Enforcement

Instructions alone are not a boundary, so the loop is also constrained mechanically. The loop runs on our own models through OpenCode (ADR-0007); OpenCode has no operating-system sandbox, so the controls are:

- The goal loop runs in a dedicated clone used by nothing else, so a mistake cannot touch the owner's other checkouts through git.
- Secret-looking environment variables (API keys, tokens, passwords, database URLs) are removed from the runner before OpenCode starts. Only the model-provider keys the runner allows (OmniRoute, Morph, DeepInfra) and `GH_TOKEN` are passed on. `GH_TOKEN` comes from a fine-grained token scoped to this repository (`VIBECODIUM_GH_TOKEN`) when the owner has created one; otherwise the runner falls back to the owner's `GITHUB_TOKEN` and logs a warning.
- OpenCode runs with its own generated config and data folders, so the owner's MCP servers, global rules and session history are neither loaded nor modified.
- Hard-stop shell commands are denied by OpenCode permission rules: force-push and remote branch deletion, release creation or editing, repository deletion or settings, GitHub auth and secrets, package publishing, software installs, environment dumps, global git config, scheduled tasks, registry edits and recursive deletes of system paths.
- GitHub branch protection on `master` and `vibe/main` forbids force-pushes and branch deletion.
- Runner logs keep only short summaries with secret values redacted; raw agent event streams are never written to disk. Logs are deleted after 14 days.

Accepted residual risks (owner decision 2026-11-20: run the build on our own models instead of a sandboxed vendor agent):

- No operating-system sandbox: a shell command that the deny list does not anticipate can write anywhere the owner's account can. `tech-scout` evaluates sandbox-runtime for the loop at M6 start, when the product needs it anyway.
- Network access is open, not allowlisted, because research, package registries and provider docs are part of the work. Prompt injection from web content could cause outbound requests.
- The model-provider keys and the GitHub credential are readable by the agent. Scope GitHub with `VIBECODIUM_GH_TOKEN` to limit the blast radius; provider keys should carry spending limits at the provider.
- The runner and the lock live in the same user-writable clone and the scheduled task uses `-ExecutionPolicy Bypass` (required by the workstation's silent-automation policy). A process already running as the owner could replace both; that attacker already controls the account, so script signing would add little.
- The in-product quarantine of untrusted content (SECURITY.md) lands with M6; until then the build loop relies on secret removal, the deny list and server-side branch protection.

### Hard stops (always pause, in every mode)

1. Writing, printing, logging or committing a secret value.
2. Spending money: purchases, paid plans, paid signing certificates, paid API tiers beyond existing keys.
3. Destroying data outside the task's own worktree and branch: deleting user files, force-pushing or rewriting history on `master` or `vibe/main`, deleting repositories.
4. Publishing to the public: a non-draft GitHub release, winget or store submissions, public announcements.
5. Legal or trademark commitments on the owner's behalf.

## 6. Branches and merges

| Branch | Purpose | Rules |
|---|---|---|
| `master` | Mirror of `VSCodium/vscodium` `master` | Fast-forward from upstream only |
| `vibe/main` | Product trunk | Changes land by PR only, after the full chain and green CI |
| `vibe/<milestone>/<slug>` | Task work, one worktree each | Created from `vibe/main` |
| `vibe/alt/<slug>` | Alternative choices waiting for the owner | Draft PR, never merged without an approval record |

Worktrees live in the folder beside the checkout: `<checkout>.worktrees/<slug>`. The goal loop uses its own dedicated clone, so its worktrees never mix with the owner's.
