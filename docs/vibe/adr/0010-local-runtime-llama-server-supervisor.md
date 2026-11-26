# ADR-0010: Local models run under a caller-supplied llama-server supervisor

> Doc class: living - Owner: docs-keeper - Last reviewed: 2026-11-25

- Status: accepted
- Date: 2026-11-25

## Context

M3 needs a local runtime so the B1 `llama.cpp` preset can work without a cloud provider. The
architecture selects llama.cpp `llama-server` as the bundled local runtime and auto-detected Ollama
as an alternative. Two shapes were possible: run the server as a supervised child of the IDE, or let
the user start it outside the product and only point a provider at a port.

An externally started server is simple, but the product cannot know whether it is ready, cannot
choose a free port, cannot stop it, and cannot bind it to loopback on the user's behalf. It also
leaves the first-run wizard with nothing to drive. A bundled server must still be a child process,
not an in-process native addon, because a crash or a GPU fault in the inference library must not
take the editor down.

## Decision

Ship `src/stable/runtime/llama-server.mjs` as a dependency-free supervisor for a caller-supplied
`llama-server` executable.

- The executable and the `.gguf` model are absolute local files, validated through `lstat` and
   `realpathSync.native`; a symlink or junction anywhere in the path is rejected.
- The child is spawned directly (`shell: false`) on loopback `[127.0.0.1]` with a loopback port
   (ephemeral by default, or a caller-supplied one), `windowsHide`, the executable directory as its working directory, and
   no process group of its own.
- The server flags are fixed: `--model`, `--host`, `--port`, plus optional bounded `--ctx-size`,
   `--threads` and `--n-gpu-layers`. Caller prefix arguments may not set the bind host or port.
- Readiness means `GET /health` returned 200 before the startup deadline. A never-ready or exited
   child is stopped before the start error surfaces.
- The child environment is an allowlist (`SystemRoot`/`TEMP`/`TMP` on Windows, `TMPDIR`/`LANG`/
   `LC_ALL` elsewhere) with `PATH` pinned empty and loader/system names refused, so provider keys and
   user-writable search paths do not reach the local server.
- `stop()` is idempotent and escalates from `SIGTERM` to `SIGKILL`. The controller and its snapshots
   are frozen; child output is retained in a bounded tail but is not exposed.

Bundling the llama.cpp release, pinning it in `vibe/sidecars.json`, downloading weights and
detecting Ollama are later M3 slices. This ADR approves the supervisor boundary, not a binary
version.

## Consequences

- The IDE can start, health-check and stop the local runtime deterministically, and the first-run
   wizard has one small API to drive.
- A local model server runs on loopback only and inherits no provider credential or user `PATH`.
- The supervisor is a process boundary, not a content boundary: request bodies and model output do
   not pass through it. It also adds no API key and no CORS restriction to `llama-server` yet, and it
   accepts a health 200 from any listener on the chosen port; the client-wiring slice must add an
   ownership or authenticated readiness check before prompts flow through the port.
- The caller-supplied executable is trusted to live in a directory an attacker cannot replace. The
   bundled binary will be installer-owned, which closes that gap.
- Only the direct child is terminated on Windows; a server that spawns descendants would leave them
   until a later process-tree slice, and a parent crash leaves the child running on loopback until it
   is killed. There is no restart/back-off policy yet, and the ephemeral port is reserved before the
   child binds (a narrow race).
- A bundled binary needs a radar row, a pinned version, a SHA-256 checksum, the seven-day rule and a
   signing route before it ships; none of that is approved by this ADR.
