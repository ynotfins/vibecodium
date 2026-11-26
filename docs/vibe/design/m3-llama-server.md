# M3 local llama-server supervisor

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-26
>
> The process supervisor for the local runtime. The module lives in
> [llama-server.mjs](../../../src/stable/runtime/llama-server.mjs), its fake-server fixture in
> [fake-llama-server.mjs](../../../tests/vibe/fixtures/fake-llama-server.mjs), and its acceptance
> tests in [llama-server.test.mjs](../../../tests/vibe/llama-server.test.mjs). The decision is
> recorded in [ADR-0010](../adr/0010-local-runtime-llama-server-supervisor.md).

## Scope

This is M3's local runtime boundary. It starts, health-checks and stops a direct `llama-server` child
on loopback, it proves that the delivered B1 `llama-cpp` preset serves chat, streaming, tool calls and
embeddings through it, and it offers an opt-in bounded restart/back-off policy for a child that dies
while serving. It does not bundle or download llama.cpp or any weights, probe the hardware, render the
first-run wizard, proxy chat itself or manage descendants. The model downloader is a sibling slice that
supplies the weights; the wizard will pass its start plan to this module in a later M3 slice, the
hardware probe is a sibling module, and the binary pinning belongs with `vibe/sidecars.json`.

## Contract

`createLlamaServer(options)` returns a frozen controller with `start()`, `stop()`, `health()`,
`status()`, `describe()` and `config`. `describe()` and `status()` return the same frozen snapshot,
which carries `state`, `port`, `baseUrl`, `pid`, `exitCode`, `signal`, `startedAt`, `restarts`
(automatic attempts in the current streak, `0` without a policy) and `failure` (`null` unless the
restart budget is exhausted, when it is `restarts-exhausted`).

| Option | Meaning | Default |
|---|---|---|
| `executablePath` | absolute path to the `llama-server` executable (`.exe` on Windows, executable bit on POSIX) | required |
| `commandArgs` | optional caller-provided prefix args, passed literally before the server flags | `[]` |
| `modelPath` | absolute path to an existing `.gguf` file | required |
| `port` | loopback port from 1024 to 65535 | one reserved ephemeral port |
| `contextSize` | `--ctx-size`, 1 to 1,048,576 | omitted |
| `threads` | `--threads`, 1 to 256 | omitted |
| `gpuLayers` | `--n-gpu-layers`, 0 to 1,000 | omitted |
| `startupTimeoutMs` | readiness deadline, 50 to 120,000 ms | 30,000 |
| `healthIntervalMs` | poll interval, 10 to 10,000 ms | 100 |
| `stopTimeoutMs` | graceful-exit wait, 50 to 30,000 ms | 5,000 |
| `env` | caller overrides merged over the allowlist | `{}` |
| `restart` | optional restart policy: `maxRestarts` (required, 1-10), `baseDelayMs` (50-300,000 ms, default 1,000), `maxDelayMs` (default the larger of `baseDelayMs` and 30,000, must be at least `baseDelayMs` and at most 300,000) and `stableMs` (0, or 1,000-600,000 ms, default 60,000) | omitted: no automatic restart |
| `fetch` | health-request implementation | `globalThis.fetch` |

The server flags are exactly `--model <path> --host 127.0.0.1 --port <port>`, followed in order by
`--ctx-size`, `--threads` and `--n-gpu-layers` when supplied. `commandArgs` precedes that list and
exists for a wrapper or a test harness; it is not derived from user content. It may not set `--host`
or `--port` (including the `--host=` and `--port=` forms); the supervisor always appends its own
loopback host and reserved port.

`start()` resolves only after `GET /health` on `127.0.0.1:<port>` returns 200 and reports the state
`running`, the chosen port, `http://127.0.0.1:<port>/v1` and the child pid. A second `start()` while
running returns the same snapshot. A concurrent `stop()` is serialized with `start()`: the stop flag
is checked after the port is reserved (before the spawn), at the start of every health iteration, and
after a successful probe (before readiness is accepted), so a stop that arrives while the port is
being reserved or `/health` is still loading cannot leave a running child behind; the start then
rejects with `start-aborted` (or with `server-exited` when the stop's kill is observed as the child's
exit first). `stop()` is idempotent: it sends `SIGTERM`, waits for the graceful-exit
timeout, escalates to `SIGKILL`, and waits again. It clears the reported pid and port, so `status()`
after a stop shows `state: stopped`, `pid: null`, `port: null` and `baseUrl: null`, while
`exitCode`, `signal` and `startedAt` report the last child. A `start()` issued while a `stop()`
is still tearing the old child down waits for that stop first, so a restart cannot be clobbered by a
teardown that was already in flight. A child exit is reported as `exited` until the stop or the
failed-start cleanup resets the controller to `stopped`, so a snapshot can briefly show `exited`. An
exit during an explicit `start()` is never retried automatically; a failed automatic attempt still
spends the budget and is retried until the budget is spent. An exit while `running` becomes
`restarting` under a restart policy and stays `exited` without one.
`health()` never throws and only probes while the controller is running: outside that state it
reports `{ ok: false, status: 0 }`, so a released port cannot be mistaken for a healthy server. A
reachable non-200 answer reports its HTTP status as `{ ok: false, status: <http status> }`.

## Restart and back-off

The policy is opt-in. Without `restart`, an unexpected exit keeps the previous behaviour: the state
stays `exited`, `restarts` is `0` and nothing is spawned. With a policy, an exit observed while the
controller was `running` and the budget is not yet spent sets the state to `restarting`, keeps the last
port as the restart target, and schedules a fresh `start()` after `baseDelayMs * 2 ** attempts`,
capped at `maxDelayMs` and never below `baseDelayMs`. The restart is a normal start: the executable
and model paths are re-validated, readiness is health-gated again, and the child runs with the same
validated arguments and environment. On success the state returns to `running` with a new pid,
`restarts` counts the attempts in the current streak, and the same port is reused so a client's base
URL does not change; a caller-supplied `port` keeps working as before. A restart attempt that fails
to become ready counts against the budget and, while budget remains, schedules the next one.

`restarts` counts automatic attempts since the last stable run or explicit start/stop. A run that
stays healthy for `stableMs` clears the streak and the `failure` code, so an occasional crash can use
the budget again; `stableMs` of `0` disables that reset. A non-zero window below 1,000 ms is
refused, so a caller cannot configure a near-instant reset that would turn the policy into a tight
respawn loop. Once `restarts` is at `maxRestarts` without a stable run, the next exit while `running`,
or a failed automatic attempt, ends the controller as `failed` with `failure: 'restarts-exhausted'`,
`port: null` and no child, and further exits schedule nothing. `health()` reports not-ready in
`restarting` and `failed`. `stop()` cancels a pending back-off timer, clears the streak and leaves the
controller `stopped` with no spawn; an explicit `start()` after a failure is allowed and clears the
failure. Timers are `unref()`ed so a pending restart cannot keep the process alive.

The child is spawned with `shell: false`, `windowsHide: true`, `detached: false`, and the executable
directory as its working directory, so a workspace-relative file or DLL cannot be picked up through
the parent's current directory. No shell parses the arguments. Standard output and error are retained
in a 16,384-character tail each and are not returned by `status()`, `describe()`, `config`, an error
or a serialized controller.

## Environment

The child never receives the full process environment. The base environment copies only
`SystemRoot`, `TEMP` and `TMP` on Windows and `TMPDIR`, `LANG` and `LC_ALL` elsewhere, and pins
`PATH` to an empty string: Windows would otherwise synthesise a system/user `PATH` that includes
user-writable directories, and the local server does not need one. A caller that needs a specific
`PATH` passes it as an override (a Windows override replaces the copied name case-insensitively).
Caller overrides are validated (bounded name and value, no NUL, bounded key count and total size,
reserved keys refused) and may not set loader or system-resolution names: `NODE_OPTIONS`,
`NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES`,
`DYLD_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH` and the `DYLD_*` fallback paths, `SystemRoot`,
`GGML_BACKEND_PATH` or any `LLAMA_ARG_*` name are rejected, case-insensitively. Provider keys and
loader-hijack names are therefore not inherited from the parent, and explicit caller overrides of
ordinary names are trusted. A Windows child may still carry a few OS-added identity variables
(`USERNAME`, `WINDIR` and similar) that Node adds on Windows; the security-relevant
inheritance property is that no arbitrary parent variable or provider key reaches the child.

Caller prefix arguments are a trusted surface: `--host`/`--port` (and their `=` forms) must not be
set, and `--reuse-port`, `--agent`/`-ag`/`--ui-agent`, `--tools`, `--mcp-*` and `--ui-mcp-proxy`
are refused because they would weaken the loopback-only or no-tools guarantee. `--` is not a
terminator in llama.cpp (it rejects the argument), and a duplicated `--model`/`--host`/`--port` is
overwritten by the supervisor's appended copy.

## Failure model

- `server-exited`: the child exited before `/health` returned 200.
- `startup-timeout`: the readiness deadline passed; the child is stopped before the error surfaces.
- `start-aborted`: a concurrent stop arrived before readiness; no child is left behind.
- `spawn-failed`: the spawn call threw synchronously and nothing is left running; an asynchronous
   spawn error is reported as `server-exited`.
- `no-port`: the ephemeral loopback port could not be reserved; the state returns to stopped.
- `already-starting`: a defensive guard; a concurrent `start()` normally joins the in-flight one.
- `invalid-executable`, `invalid-model-path`: the path is relative, drive-relative, UNC, missing,
   empty, not a regular file of the required type, a symlink, or under a symlinked/junction parent;
   on POSIX an executable without any execute bit is also rejected.
- `invalid-port`, `invalid-context-size`, `invalid-threads`, `invalid-gpu-layers`, `invalid-timeout`,
   `invalid-command-args`, `invalid-env`, `invalid-options`: a bounded option is malformed, an
   accessor was supplied, an unknown field appeared or a reserved key was read.
- `invalid-host`: validator-only (`validateLoopbackHost`); it accepts only `127.0.0.1`, and the
   controller has no host option.
- `runtime-unavailable`: the host has no `fetch` implementation.
- `invalid-restart-policy`: the policy is not a plain object, an accessor, a reserved key or an
   unknown key appeared, `maxRestarts` is missing, a field is not an integer or is out of range, or
   `maxDelayMs` is below `baseDelayMs`.
- `restarts-exhausted`: a reported `failure` code, not a thrown error. The restart budget was spent
   without a stable run, so the controller reports `failed`, `failure: 'restarts-exhausted'` and no
   port or child, and schedules nothing further.

## Security boundary

The supervisor is a process boundary, not a content boundary. It does not read credentials, log its
environment, or pass the full process environment; see Environment above. Request bodies,
responses and model text never pass through this module.

The executable and model paths are resolved through `realpathSync.native` and must equal their
`path.resolve` form, so a symlink or junction anywhere in the path is rejected; on POSIX the
executable must also carry at least one execute bit. Path segments with a
Win32 trailing dot or space are rejected. Options, argument arrays, environment and the exported
argument builder are read through own data descriptors, so a getter is not invoked and a prototype
cannot contribute a key. Validation errors are fixed strings and never echo the rejected value. The
health request refuses redirects and is bounded by a 2-second deadline.

Residual risks:

- The executable is trusted to live in a directory an attacker cannot replace; it is also the
   child's working directory and the first Windows DLL search directory. A bundled binary will be
   installer-owned, which closes this for the shipped product.
- Readiness accepts a 200 from any listener on the chosen port. The supervisor checks that its own
   child has not exited, but not that the answer came from it. An ephemeral port narrows this to a
   close-to-bind race; a caller-supplied port has no such narrowing, so the client-wiring slice must
   add a port-ownership or per-start authenticated readiness check before prompts flow through it.
- Upstream `llama-server` defaults to no API key and permissive CORS; this slice adds neither, so a
   local process or a visited web page can reach the loopback port until client wiring restricts it.
- `SIGKILL` terminates only the direct child on Windows, so a `llama-server` that spawns descendants
   would leave them; a parent crash also leaves the direct child running on loopback until killed.
   There is no job object or parent-death signal yet. The restart policy covers only an exit of the
   direct child that the supervisor spawns; it is bounded to at most `maxRestarts` automatic restarts
   per stable window (plus the initial explicit start), refuses a stable window below one second,
   ends in `failed`, and a stop always wins over a pending restart.
- The retained stdout/stderr tail is bounded in memory and never exposed; redaction is not
   implemented because nothing reads it yet.
- `commandArgs` and `env` are a trusted caller surface. Only the named host/port, shared-port,
   agent/MCP and loader/system values are refused.

## Verification

`node --test tests/vibe/llama-server.test.mjs` starts the Node fixture through the real `spawn` and
covers the exact argument list, health-gated readiness (`stopped` -> `starting` -> `running`), the
derived base URL, pid/status transitions, idempotent start and stop, the cleared port and base URL,
`health()` after stop, literal `commandArgs` (no shell parsing), a never-ready child that is proven
dead through `process.kill(pid, 0)`, an unhealthy child, an early exit, a failing health fetch, stop
during start (no spawn and a later clean start), a start issued during a stop (waits, then runs on a
new pid), a model deleted between creation and start (the paths are re-validated before any spawn),
model/executable path rejection including relative, drive-relative, UNC, empty files,
symlink and junction ancestors (junction creation is skipped where the host refuses it) and the
POSIX execute-bit rule, option, accessor, unknown-field, revoked-proxy and upper-bound rejection
without spawning, case-insensitive loader/system and `LLAMA_ARG_*` environment names, reserved env
keys, oversized env keys and totals, denied shared-port/agent/MCP prefix arguments, the copied
platform allowlist key, the non-inherited
`PATH` and an explicit `PATH` override, a running `health()` that sees a 503 or a failed request, a
SIGTERM-ignoring child that is escalated to SIGKILL with the graceful wait honoured (POSIX only;
Windows terminates the direct child on SIGTERM), and child stdout/stderr output that is retained in
the bounded tail but never exposed through `status()`, `describe()`, `config` or a serialized
controller. The same test
creates a real B1 `llama-cpp` client against the running server and verifies chat, streaming,
streamed and non-streamed tool calls, embeddings and `/infill`; the first-run wizard will use the
same client.

The restart policy has its own cases in the same file, with the fixture counting boots through
`FAKE_LLAMA_STARTS` and dying after readiness in `crash-once`, `crash-twice`, `crash-after` and
`crash-once-then-exit` modes (the last fails its later starts before readiness):
a bad policy (null, an array, a string, an empty object, a missing, unknown or out-of-range field, a
cap below the base delay, an accessor, a revoked or trap-throwing Proxy or a reserved key) fails
closed as `invalid-restart-policy` without a spawn; without a policy an unexpected exit stays
`exited` with `restarts: 0`; with a policy the crash moves through `restarting` to `running` on the
same port with a new pid, `restarts: 1` and a working B1 client; the first restart waits at least
`baseDelayMs` and the second at least twice that; a child that keeps crashing ends as `failed` with
`failure: 'restarts-exhausted'`, `port: null`, no pid and no further spawn; a run stable for `stableMs`
resets the streak so a later crash restarts again, while `stableMs: 0` never resets; a `stop()` during
the back-off cancels the pending restart and spawns nothing; and a crash during an explicit `start()`
still rejects with `server-exited` and never auto-restarts.

The full acceptance uses `node vibe/tools/verify.mjs --strict` and
`node vibe/tools/docs-check.mjs --strict`.
