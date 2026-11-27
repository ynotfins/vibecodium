# M3 local llama-server supervisor

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-27
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
supplies the weights; the first-run wizard now hands this module its start options through
`runtimeOptions()`, the hardware probe is a sibling module, and the pin and verified installer
are delivered in [m3-sidecar-binary.md](m3-sidecar-binary.md).

## Contract

`createLlamaServer(options)` returns a frozen controller with `start()`, `stop()`, `health()`,
`auth()`, `status()`, `describe()` and `config`. `describe()` and `status()` return the same frozen
snapshot, which carries `state`, `port`, `baseUrl`, `pid`, `exitCode`, `signal`, `startedAt`,
`restarts` (automatic attempts in the current streak, `0` without a policy) and `failure` (`null`
unless the restart budget is exhausted, when it is `restarts-exhausted`). `auth()` returns
`Object.freeze({ apiKey })`, the only way for the host process to read the key; the key is
deliberately absent from `status()`, `describe()`, `config`, `start()`'s snapshot, the reserved port,
the argument list, every error message and the retained output tail.

| Option | Meaning | Default |
|---|---|---|
| `executablePath` | absolute path to the `llama-server` executable (`.exe` on Windows, executable bit on POSIX) | required |
| `commandArgs` | optional caller-provided prefix args, passed literally before the server flags | `[]` |
| `modelPath` | absolute path to an existing `.gguf` file | required |
| `apiKey` | API key the child must accept, 32 to 128 printable ASCII characters, no comma, quote, backslash, whitespace, control or bidi character | 32 random bytes in base64url (43 characters), generated once per controller and reused for its lifetime |
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

`validateRestart` is exported so a caller (the first-run wizard) validates and carries exactly the
policy this module will receive; it reads the policy through own data descriptors and returns a
frozen object with the documented defaults filled in, or `null` when it is omitted. Anything invalid
throws `invalid-restart-policy`.

The server flags are exactly `--model <path> --host 127.0.0.1 --port <port> --no-webui
--cors-origins localhost`, followed in order by `--ctx-size`, `--threads` and `--n-gpu-layers` when
supplied. The key is never an argument: llama.cpp reads it from `LLAMA_API_KEY`, so it cannot appear
in a process listing. `commandArgs` precedes that list and exists for a wrapper or a test harness; it
is not derived from user content. It may not set `-m`, `--host`, `--port`, `--model`, `--no-webui`,
`--webui`, `--ui`, `--no-ui`, `--cors-credentials`, `--no-cors-credentials`,
`--allow-unauthenticated-tools` or any `--api-key*`, `--model*`, `--cors-origins*`, `--cors-methods*`
or `--cors-headers*` spelling (the `=` forms of every one of these are refused too); the supervisor
always appends its own loopback host, reserved port, model, key posture, web-UI and CORS flags. The
refusal is applied after the same normalisation llama.cpp performs on `--` arguments, which lowercases
nothing but rewrites `_` to `-`, so `--cors_origins`, `--api_key`, `--no_webui` and the other
underscore spellings are refused exactly like their hyphenated forms rather than slipping through.

`start()` resolves only after `GET /health` on `127.0.0.1:<port>` returns 200 and an authenticated
`GET /props` with `Authorization: Bearer <key>` also returns 200, then reports the state `running`,
the chosen port, `http://127.0.0.1:<port>/v1` and the child pid. The second probe narrows the
readiness gap: `/health` is public in llama.cpp, so any local process can answer it, while `/props`
requires the key. A 401 or 403 from `/props` therefore means the listener is not our child: the start
stops the child, returns the state to `stopped` and rejects with `readiness-mismatch`. A listener
that binds the reserved port and answers 200 on both endpoints is still accepted, so the second probe
is not a proof of ownership; the port is reserved with a bind-then-close and an ephemeral port
narrows that race, while a caller-supplied fixed port makes it reachable by any local process that
wins the race. A second `start()` while
running returns the same snapshot. A concurrent `stop()` is serialized with `start()`: the stop flag
is checked after the port is reserved (before the spawn), at the start of every health iteration, and
after a successful probe (before readiness is accepted), so a stop that arrives while the port is
being reserved or the readiness probes are still loading cannot leave a running child behind; the start
then rejects with `start-aborted` (or with `server-exited` when the stop's kill is observed as the
child's exit first). `stop()` is idempotent: it sends `SIGTERM`, waits for the graceful-exit
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
reports `{ ok: false, status: 0 }`, so a released port cannot be mistaken for a healthy server. The
probe is the authenticated `GET /props` with the controller's key, not the public `/health`, so a
listener that rejects the key reports not-ready instead of healthy (a listener that answers 200 on
`/props` is still treated as the runtime). A reachable non-200 answer
reports its HTTP status as `{ ok: false, status: <http status> }`.

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
`GGML_BACKEND_PATH` or any `LLAMA_ARG_*` name are rejected, case-insensitively. `LLAMA_API_KEY` is
the supervisor's own: an `env` override named `llama_api_key` in any casing is refused, and the
validated key is written last, so it is never read from the parent process or inherited by accident.
Provider keys and
loader-hijack names are therefore not inherited from the parent, and explicit caller overrides of
ordinary names are trusted. A Windows child may still carry a few OS-added identity variables
(`USERNAME`, `WINDIR` and similar) that Node adds on Windows; the security-relevant
inheritance property is that no arbitrary parent variable or provider key reaches the child.

Caller prefix arguments are a trusted surface, but the supervisor's own posture is not: `-m`,
`--host`/`--port`/`--model` (and their `=` forms), every `--api-key*` spelling, the web-UI flags, the
CORS flags and `--allow-unauthenticated-tools` must not be set (the `=` form of each boolean flag is
refused too); `--reuse-port`, `--agent`/`-ag`/
`--ui-agent`, `--tools`, `--mcp-*` and `--ui-mcp-proxy` are refused because they would weaken the
loopback-only, authenticated or no-tools guarantee, and the remote-model sources `-mu`/`--model-url`,
`-hf`/`--hf-repo`, `-dr`/`--docker-repo` and the peer tunnel `--connect` are refused so `commandArgs`
cannot point the child at a remote GGUF or a peer. `--` is not a terminator in llama.cpp (it rejects
the argument), and the supervisor's own flags cannot appear earlier in the list, so none of them can
be duplicated or shadowed. Caller-chosen numeric flags such as `--threads` remain a trusted surface.

## Failure model

- `server-exited`: the child exited before `/health` returned 200.
- `readiness-mismatch`: something answered the public `/health` with 200 but rejected the
   authenticated `/props` probe with 401 or 403, so the listener on the reserved port is not our
   child; the child is stopped, the state returns to `stopped` and the port is released.
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
- `invalid-api-key`: a caller-supplied key is not a string, is shorter than 32 or longer than 128
   characters, or contains a comma, quote, backslash, whitespace, a non-ASCII or a control or bidi
   character. The message is fixed and never echoes the value.
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

The loopback port is authenticated for the controller's lifetime. Each controller owns one key,
generated from 32 random bytes (base64url, 43 characters) unless the caller supplies one, and reuses
it across stops and restarts; the child receives it only as `LLAMA_API_KEY`. The web UI is disabled
and CORS is same-origin only, while the API key is what stops another local process from driving the
model. Readiness requires an authenticated `/props` answer, so a listener that rejects the key fails
the start as `readiness-mismatch`; a listener that answers 200 on both endpoints is still accepted,
and that port race is recorded as a residual risk. `auth()` is the only read path, so a snapshot, a
log line or a crash report cannot carry the key. The `llama-cpp` preset now uses
`auth: 'bearer'` with `apiKeyRequired: false`, so a client that is given the key sends
`Authorization: Bearer <key>` while a plain `llama-server` without a key still works. The host
wiring that passes `runtime.auth().apiKey` to that client is the next M3 slice; until it lands the
local chat path is unauthenticated against this supervisor.

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
- The key is held in the controller's closure and the child's environment. Any process that can read
   the child's environment (a debugger, or an administrator) can recover it, and a local process
   that can bind the port after the child exits can still answer `/health`; the authenticated
   `/props` probe now refuses it, but a client that only checks `/health` would not.
- `SIGKILL` terminates only the direct child on Windows, so a `llama-server` that spawns descendants
   would leave them; a parent crash also leaves the direct child running on loopback until killed.
   There is no job object or parent-death signal yet. The restart policy covers only an exit of the
   direct child that the supervisor spawns; it is bounded to at most `maxRestarts` automatic restarts
   per stable window (plus the initial explicit start), refuses a stable window below one second,
   ends in `failed`, and a stop always wins over a pending restart.
- The retained stdout/stderr tail is bounded in memory and never exposed; redaction is not
   implemented because nothing reads it yet.
- `commandArgs` and `env` are a trusted caller surface. Only the supervisor's own flags, the key
   name, shared-port, agent/MCP and loader/system values are refused.

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
streamed and non-streamed tool calls, embeddings and `/infill`, with the key and a 401 from the
fixture for the same paths without it; the first-run wizard will use the same client and key.

The authenticated loopback boundary has its own cases in the same file: a started controller reports
a generated key of 43 base64url characters through `auth()` and nowhere in `status()`, `describe()`,
`config`, the argument list or the child's argv log, while the fixture sees `LLAMA_API_KEY`; the two
length bounds (32 and 128) are accepted and two controllers generate different keys; a caller-supplied
key is accepted, sent on chat and `/props`, unchanged across a stop and reused on restart; a key that
is too short or too long, contains a comma, a quote, a backslash, a space, a newline, a control or
bidi character or is not a string fails as `invalid-api-key` without echoing the value, including a
sample of valid length so the character check cannot be masked by the length check, and an accessor
is refused without being invoked; a fake listener that answers `/health` with 200 and `/props` with
401, and one that answers 403, fails the start as `readiness-mismatch`, leaves the controller
`stopped` with no pid or port, is proven dead through `process.kill(pid, 0)` and is seen to have
received the `Authorization: Bearer` header; and the fail-closed option matrix refuses the reserved
`commandArgs` families (`-m`, `--api-key`, `--api-key-file`, `--model`, the UI and CORS flags,
`--allow-unauthenticated-tools`, the remote-model sources `-mu`/`--model-url`, `-hf`/`--hf-repo`,
`-dr`/`--docker-repo` and the peer tunnel `--connect`, with representative case, underscore and `=`
spellings) and refuses an `LLAMA_API_KEY` environment override, while a non-reserved flag such as
`--chat_template` still passes in either spelling. The living `llama-cpp` preset contract is covered by
`node --test tests/vibe/provider-presets.test.mjs`.

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
