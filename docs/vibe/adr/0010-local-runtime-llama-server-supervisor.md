# ADR-0010: Local models run under a caller-supplied llama-server supervisor

> Doc class: living - Owner: docs-keeper - Last reviewed: 2026-11-27

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
- The server flags are fixed: `--model`, `--host`, `--port`, `--no-webui`,
   `--cors-origins localhost`, plus optional bounded `--ctx-size`, `--threads` and `--n-gpu-layers`.
   Caller prefix arguments may not set the bind host, port, model, API key, web UI or CORS posture.
- Every controller owns one API key for its lifetime (32 random bytes in base64url, or a validated
   caller-supplied one), reused across stops and restarts. The child receives it only as
   `LLAMA_API_KEY`, the web UI is off, and a client that is given the key authenticates with
   `Authorization: Bearer <key>`.
- Readiness means the public `GET /health` returned 200 and an authenticated `GET /props` with the
   key returned 200 before the startup deadline. A listener that answers `/health` but rejects the
   key is not our child: the start stops the child and fails as `readiness-mismatch`. A never-ready
   or exited child is stopped before the start error surfaces.
- The child environment is an allowlist (`SystemRoot`/`TEMP`/`TMP` on Windows, `TMPDIR`/`LANG`/
   `LC_ALL` elsewhere) with `PATH` pinned empty and loader/system names refused, so provider keys and
   user-writable search paths do not reach the local server.
- `stop()` is idempotent and escalates from `SIGTERM` to `SIGKILL`. The controller and its snapshots
   are frozen; child output is retained in a bounded tail but is not exposed.
- An optional, validated `restart` policy recovers a child that exits while serving: it restarts on
   the same loopback port with exponential back-off, a small bounded budget and a stability reset,
   and reports `failed` with `restarts-exhausted` once the budget is spent. Without the policy the
   supervisor keeps the earlier behaviour, where an exit is reported as `exited`.

Bundling the llama.cpp release is a later M3/M12 slice; the pin and its verified installer are
delivered in `vibe/sidecars.json` and `src/stable/runtime/sidecar.mjs`, and the model downloader and
the Ollama discovery are separate modules delivered since. This ADR approves the
supervisor boundary, not a binary version.

## Consequences

- The IDE can start, health-check and stop the local runtime deterministically, and the first-run
   wizard has one small API to drive.
- A local model server runs on loopback only and inherits no provider credential or user `PATH`.
- The supervisor is a process boundary, not a content boundary: request bodies and model output do
   not pass through it.
- The loopback port is authenticated, so a local process cannot drive the model without the key, and
   the web UI is off, so a visited web page has nothing to scrape; `--cors-origins localhost` makes
   the API same-origin only for a page. The key lives in the controller's closure and the child's
   environment, so a debugger or an administrator can still read it. Readiness and `health()` reject a
   listener that answers `/health` but rejects the key; a listener that binds the reserved port and
   answers 200 on `/props` too is still accepted, and the probe sends it the key, so a narrow
   bind-then-close race (wider on a caller-supplied fixed port) remains and a client that checks only
   `/health` would still accept a foreign listener between the child's exit and the next start.
- The key must reach the B1 client: the `llama-cpp` preset uses `auth: 'bearer'` with
   `apiKeyRequired: false`, and the local provider host
   ([local-provider.mjs](../../../src/stable/runtime/local-provider.mjs),
   [m3-local-provider.md](../design/m3-local-provider.md)) starts this controller from the first-run
   plan, reads `runtime.auth().apiKey` and hands a ready `llama-cpp` client to the host, so the
   product's own local chat path authenticates against this supervisor while the key stays in the
   controller and the client closure, never in a snapshot or an error.
- The caller-supplied executable is trusted to live in a directory an attacker cannot replace. The
   bundled binary will be installer-owned, which closes that gap.
- Only the direct child is terminated on Windows; a server that spawns descendants would leave them
   until a later process-tree slice, and a parent crash leaves the child running on loopback until it
   is killed. The opt-in restart policy recovers a direct child that dies while serving within a
   bounded budget and then stops in `failed`; it does not supervise descendants. The ephemeral port is
   reserved before the child binds (a narrow race).
- A bundled binary needs a radar row, a pinned version, a SHA-256 checksum, the seven-day rule and a
   signing route before it ships; none of that is approved by this ADR.
