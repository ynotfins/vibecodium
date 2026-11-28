# M3 first-run wizard

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-28
>
> The first-run setup experience. The headless controller lives in
> [first-run.mjs](../../../src/stable/runtime/first-run.mjs), the webview panel in
> [first-run.cjs](../../../src/stable/extensions/vibecodium-ai/src/first-run.cjs), and the acceptance
> tests in [first-run.test.mjs](../../../tests/vibe/first-run.test.mjs),
> [first-run-panel.test.mjs](../../../tests/vibe/first-run-panel.test.mjs) and
> [first-run-ollama.test.mjs](../../../tests/vibe/first-run-ollama.test.mjs),
> [first-run-restart.test.mjs](../../../tests/vibe/first-run-restart.test.mjs),
> [first-run-sidecar.test.mjs](../../../tests/vibe/first-run-sidecar.test.mjs) and
> [first-run-embedding.test.mjs](../../../tests/vibe/first-run-embedding.test.mjs). It composes the delivered
> probe ([m3-hardware-probe.md](m3-hardware-probe.md)), catalog and downloader
> ([m3-model-downloader.md](m3-model-downloader.md)), supervisor contract
> ([m3-llama-server.md](m3-llama-server.md)) and pinned sidecar installer
> ([m3-sidecar-binary.md](m3-sidecar-binary.md)).

## Scope

This document covers M3's fourth runtime slice, the first-run wizard, plus the later wiring of Ollama
detection and explicit daemon selection into it and of the supervisor's restart policy into the
hand-off: one flow that tells a new install what this machine can run, which pinned weights are
already present, downloads only the missing ones, and hands the caller the exact local B1 start
plan and, for the pinned path, the exact `createLlamaServer` options, plus a separate embedding start
plan that carries the recorded embedding flags and its own supervisor hand-off. It ships no `llama-server`
process: the supervisor still owns the process boundary, and the pin and verified installer are the
separate [m3-sidecar-binary.md](m3-sidecar-binary.md) slice. The start action now installs that
pinned sidecar when no host-supplied `runtimePath` exists, adopting an already installed runtime
offline and validating the returned executable with the supervisor's own path check before the plan
is exposed. Node built-ins only.

Out of scope: spawning or supervising `llama-server`, bundling or signing the binary (the pin and
download/install module are delivered separately in [m3-sidecar-binary.md](m3-sidecar-binary.md)),
copying the catalog into a packaged application, changing the supervisor's restart behaviour,
starting/installing/updating Ollama, pulling Ollama models, switching the active B1 provider or writing
provider config, provider calls, model-ladder changes and NVML/vendor GPU libraries. Ollama detection
and the explicit selection of a discovered daemon as the local runtime are in scope; the wizard never
starts, installs or updates the daemon and never writes provider configuration.

## Catalog projection

`projectCatalogModels(catalog)` validates the shipped catalog with the downloader's
`validateCatalog` and returns a frozen array of exactly `{ id, role, sizeBytes, contextTokens }` for
the `chat` and `embedding` entries. The other catalog fields (`label`, `repo`, `revision`, `file`,
`url`, `sha256`, `license`, `quantization`) exist for the downloader and are not part of the
recommendation input. A `code` or `edit` entry is skipped. A catalog without a chat or an embedding
entry fails closed as `no-chat-model` or `no-embedding-model`; a malformed catalog fails as
`invalid-catalog`. The input is never mutated.

`recommendRuntime` consumes only that projection, which is the boundary described in
[m3-hardware-probe.md](m3-hardware-probe.md).

## The controller

`createFirstRunWizard({ catalog, destinationDir, probe?, downloadModel?, verifyModel?, runtimePath?, onChange?, discoverOllama?, restart?, sidecar?, installSidecar?, verifySidecar? })`
returns a frozen controller with `refresh()`, `install()`, `start()`, `startPlan()`, `runtimeOptions()`,
`embeddingPlan()`, `embeddingRuntimeOptions()`, `checkOllama()`, `useOllama()`, `usePinned()`, `view()`
and `dispose()`.

| Option | Meaning |
|---|---|
| `catalog` | The pinned catalog object; validated once at construction. |
| `destinationDir` | Absolute local directory that holds the pinned GGUF files. It need not exist yet; the downloader creates it after proving the nearest existing ancestor real. |
| `probe` | Optional probe function, default `probeHardware`. Tests inject one; the product leaves it unset. |
| `downloadModel` | Optional downloader, default `downloadModel`. The panel leaves it unset; tests inject a local fake so no network is used. |
| `verifyModel` | Optional verifier, default `verifyInstalledModel`. It hashes an installed file and never touches the network. |
| `runtimePath` | Optional packaged `llama-server` executable. It is validated with the supervisor's `validateLlamaExecutablePath` at construction; without it the pinned `startPlan()` reports `runtime-not-bundled` until `start()` installs a configured sidecar (a selected daemon still yields the daemon plan). |
| `onChange` | Optional display callback, invoked with the current view after a phase or progress change. A throwing callback is ignored. |
| `discoverOllama` | Optional discovery effect, default the delivered `discoverOllama`. Tests inject a local fake so no socket is opened; the product leaves it unset. |
| `restart` | Optional restart policy handed to the supervisor. It is validated with the supervisor's exported `validateRestart` at construction; omitted uses the frozen conservative default `{ maxRestarts: 3, baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000 }`. |
| `sidecar` | Optional pinned-runtime settings, owned by the host and never by the webview: `{ manifest, id?, appDataRoot?, targetDir?, platformKey? }`. The manifest is validated with the installer's `validateSidecarManifest`, `id` defaults to the sole entry, and the platform must have a pinned target. With `appDataRoot` the installer derives `<root>/runtime/<platformKey>/<id>-<version>` itself and receives only the owned root, so no caller directory reaches a write; `targetDir` alongside it is refused rather than ignored. Without `appDataRoot`, `targetDir` defaults to `<destinationDir>/runtime` for a host that already owns an installed runtime. A malformed bag, a non-absolute or unownable root fails closed as `invalid-sidecar`. |
| `installSidecar` | Optional installer effect, default the delivered `installSidecar`. It is called only by `start()`; tests inject a local fake so no network is used. |
| `verifySidecar` | Optional offline verifier, default the delivered `verifySidecarInstall`. `refresh()` uses it to adopt a runtime that is already on disk; it never touches the network. |

Options, the probe result, the install options, the sidecar bag and the installer result are read
through own data descriptors. A Proxy, an accessor, an unknown or reserved key, a relative, UNC or
traversal destination, a missing catalog, an invalid executable path, an invalid restart policy, an
invalid sidecar manifest, an unknown sidecar id or an unsupported platform fail closed as
`invalid-options`, `invalid-catalog` or `invalid-sidecar` without invoking a getter and before the
probe runs.

### Phases

`idle -> probing -> needs-download | ready | insufficient -> downloading -> ready | failed`.

- `probing` while the probe and the file verification run.
- `needs-download` when at least one pinned file is missing and the machine can run the selected model.
- `insufficient` when the recommendation verdict is `insufficient` (below 8 GiB RAM, or the smallest
   chat model does not fit). `install()` refuses this phase.
- `ready` when both pinned files verify and the verdict is not `insufficient`, or when a discovered
   daemon is the selected local runtime (its models already live in the daemon).
- `downloading` while `install()` runs.
- `failed` after a probe, recommendation or download failure. The view carries `{ code, message }`
   with a fixed message, so an error body or path from an injected effect is never echoed.

`refresh()` probes once, merges the probe notices and the plan notices (`gpu-probe-*` first, then the
policy codes, de-duplicated and ordered) and verifies both files. A verification error is reported as
`verify-failed` and leaves the model missing rather than failing the whole check.

### Install

`install({ signal? })` is single-flight. It validates its options, sets the phase to `downloading`,
assigns the single-flight promise and only then calls `onChange`; the work starts on a microtask, so a
downloader that throws synchronously yields a normal `install-failed` result (and a retry can run)
instead of leaving the wizard permanently busy. It downloads only the missing models, chat before
embedding, and forwards each downloader progress event as
`{ modelId, role, received, total, fraction }` after clamping it to the pinned size. A returned file must report `verified: true` and pass
`verifyModel` before it is marked installed. An abort, a stall or a failed transfer keeps the partial
file for the downloader to resume, keeps the files that already verified and returns a safe code
(`aborted`, `checksum-mismatch`, `install-failed`, ...). A second call after a failure retries only
the remaining models; a call on a ready machine returns `{ ok: true, installed: 0, reason: 'already-installed' }`.
While the daemon is the selected runtime, `install()` returns
`{ ok: true, installed: 0, reason: 'ollama-selected' }` and performs no download.

### Start action

`start({ signal? })` is the install-then-start preparation and is single-flight. It returns the same
plan shape as `startPlan()`: a frozen pinned plan, the daemon plan, or `{ available: false, reason }`
with `not-ready`, `insufficient`, `runtime-not-bundled`, `busy` or `disposed`. It never spawns a
process.

With a validated `sidecar` and no host-supplied `runtimePath`, a ready machine calls `installSidecar`
once, forwards `{ received, total, fraction }` progress clamped to the pinned archive size, and
validates the returned `executablePath` with the supervisor's `validateLlamaExecutablePath` before
publishing it. A missing `sidecar` keeps `runtime-not-bundled`; an installer failure, abort, unverified
result or hostile (accessor, Proxy, non-string) result returns
`{ available: false, reason: 'runtime-install-failed', code }` with a bounded code and leaves the plan
unchanged, so a retry can run. A second start reuses the validated executable and does not call the
installer again. `refresh()` adopts an existing runtime through the injected offline `verifySidecar`
without a download; a failed or hostile check is advisory. With `appDataRoot` the verifier receives exactly
`{ ownedRoot, platformKey }` and the installer receives the same bag plus its existing `signal` and
`onProgress` controls, so the installer derives `<root>/runtime/<platformKey>/<id>-<version>` and no
caller directory is passed; without it the default `targetDir` is `<destinationDir>/runtime`. The
host, not the webview, owns both surfaces.

### Start plan and runtime options

`startPlan()` returns frozen data only when the phase is `ready`. The two shapes are:

```
{ available: true, kind: 'llama-server', executablePath, modelPath, model, embeddingModelPath, contextSize, threads, gpuLayers, restart }
{ available: true, kind: 'ollama', baseUrl, model, embeddingModel }
```

The pinned shape's `model` is the catalog chat entry's `id`, the B1 model name the host sends with a
request; the supervisor still receives the weights as `modelPath`, not as a name. It is the one field the
local provider host reads from this plan (see [m3-local-provider.md](m3-local-provider.md)) so it does
not have to map the installed file back to a provider model.

The daemon shape is returned while the discovered daemon is the selected runtime and its summary
still carries validated `providerOptions`; its `baseUrl` and `model` are exactly the overrides the
B1 `ollama` preset takes, and `embeddingModel` is the discovered optional embedding model. Otherwise
the pinned shape is returned when a validated `runtimePath` exists; without it the result is
`{ available: false, reason: 'runtime-not-bundled' }` until `start()` installs the configured sidecar.
`view().runtime` reports `{ configured, installed, version, progress }` so the panel can offer the
start action before the runtime exists. Before a successful refresh, or when the phase is not
`ready`, `startPlan()` is `{ available: false, reason: 'not-ready' }`. The caller passes a pinned plan to
the supervisor, which still validates the executable, the model path and every flag. `restart` is the
effective policy (`DEFAULT_FIRST_RUN_RESTART_POLICY` or the validated caller policy), the same frozen
object the supervisor will receive. The wizard never spawns the process.

`runtimeOptions()` is the hand-off to the supervisor. When the pinned path is available it returns
`{ available: true, options }` where `options` contains exactly the `createLlamaServer` fields
`executablePath`, `modelPath`, `contextSize`, `threads`, `gpuLayers` and `restart`; it omits `kind`,
the plan-only `model` and `embeddingModelPath`, plus `available`, a port and a `fetch`
implementation. A caller can
therefore write `createLlamaServer(wizard.runtimeOptions().options)` and the supervisor re-validates
the executable, the model path, every flag and the policy. While a daemon is selected it returns the
daemon start plan instead (there are no supervisor options), and otherwise it returns the same
`{ available: false, reason }` value as `startPlan()`. The wizard always chooses a bounded restart
policy; a caller that wants no automatic restart builds its own supervisor options instead.

### Embedding start plan and runtime options

`embeddingPlan()` is the second plan, separate from `startPlan()`, for the pinned embedding weights: it
carries the exact flags a `llama-server` needs to serve embeddings from the delivered catalog file
without the caller rebuilding them. It returns frozen `{ available: false, reason }` with `disposed`,
`not-ready` (before a successful refresh or outside `ready`), `no-embedding-model` (a selected daemon
with no local embedding model) or `runtime-not-bundled` (the pinned runtime is not installed yet; the
panel's start action still installs it through `start()`). On a ready pinned machine the shape is:

```
{ available: true, kind: 'llama-server', executablePath, modelPath, commandArgs, restart }
```

`executablePath` is the same validated runtime path the chat plan uses, `modelPath` joins
`destinationDir` and the catalog's embedding entry `file`, `commandArgs` is the exported frozen
`EMBEDDING_SERVER_ARGS` (`--embedding`, `--pooling`, `last`, `-c`, `8192`, `-b`, `8192`, `-ub`,
`8192`), and
`restart` is the same effective policy `startPlan()` reports. The context is pinned to
`RECOMMENDED_EMBEDDING_CONTEXT_TOKENS`, the same cap the hardware probe's embedding memory estimate
counts: at the pinned `b12426` build `--ctx-size` defaults to 0, so an unpinned server takes the
model's trained 32768-token context and allocates a far larger KV cache than the shown estimate. All
three batch/context switches carry 8192 on purpose: `llama_context` sizes the physical batch as
`min(n_batch, n_ubatch)`, clamps the logical batch to the context for a causal model, and
`--batch-size` defaults to 2048, so `-ub 8192` alone would start cleanly but batch at 2048 (and a
context below the batch would silently shrink it). While the discovered daemon is the selected runtime and its
summary carries an embedding model the plan is `{ available: true, kind: 'ollama', baseUrl, model }`
where `baseUrl` and `model` are the validated loopback URL and embedding model; a daemon that reports
only a chat model stays `no-embedding-model`, and switching back to `usePinned()` restores the pinned
plan. `view().embedding` carries the same plan.

`embeddingRuntimeOptions()` is the matching hand-off. A pinned plan becomes
`{ available: true, options }` where `options` contains exactly the `createLlamaServer` fields
`executablePath`, `modelPath`, `commandArgs` and `restart`, frozen at both levels, so a caller can write
`createLlamaServer(wizard.embeddingRuntimeOptions().options)` and the supervisor still validates the
executable, the model, every flag (the pinned flags set no bind host or port and enable no agent or MCP
switch) and the policy. A daemon plan is returned as-is because a daemon is not spawnable, and a blocked
plan is the same `{ available: false, reason }` value. The wizard never spawns an embedding server, and
the plan never accepts caller-supplied flags, a port, a context or a batch or ubatch override.

### Ollama detection and selection

`checkOllama()` is a read-only detection that runs beside the pinned plan. `view().ollama` stays `null`
until it is called, then carries a frozen summary
`{ checked, available, reason, baseUrl, chatModel, embeddingModel, modelCount, notices, providerOptions }`.
It is single-flight, never changes the phase, models, progress, error or start plan, never downloads,
and never adopts the daemon on its own. A documented available answer yields `providerOptions` only after the
reviewed `toOllamaProviderOptions` re-validates the whole result, so a forged, stale, remote,
embedding-only or wrong-base answer yields `providerOptions: null` with `no-chat-model` or
`invalid-result`. An unavailable answer keeps its bounded `unreachable`, `timeout`, `http-error`,
`invalid-response` or `policy-denied` reason and its notice. A thrown effect, a Proxy, an
accessor-backed answer, an unknown reason, a non-array model list and an oversized or accessor-backed
notice list fail closed as `check-failed` or `invalid-result`; no URL, model text, body, error message
or credential is echoed. A disposed wizard returns `{ checked: false, reason: 'disposed', ... }` and
stores nothing. The product default is the delivered loopback probe, which the M1 endpoint policy gates
before any request.

`useOllama()` is the explicit selection: it succeeds only after a check found a daemon whose summary
still carries `providerOptions` and only while no download is in flight (`not-checked`,
`ollama-unavailable`, `not-ready`, `busy` and `disposed` otherwise), then sets `view().source` to
`'ollama'`, makes the phase `ready` and emits. `usePinned()` switches back and recomputes the phase
from the pinned verdict and installed files. The selection survives a refresh while the summary stays
usable; a re-check that loses the daemon releases it and restores the pinned phase. `view().source`
is `'pinned'` until a selection succeeds.

## The panel

`createFirstRunController({ vscode, extensionUri, wizardProvider })` registers
`vibecodium.firstRun.open` and `vibecodium.firstRun.setWizard`. The webview renders the phase, verdict,
acceleration, the four steps (hardware check, pinned models, model download, local runtime), the model
rows and sizes, the notice codes, a progress element during a download, a pinned-runtime progress
line while the start action installs it, an embedding-server section, an Ollama section, and five or six buttons: **Check again**,
**Download models**, **Start local runtime**, **Check for Ollama**, **Use Ollama** and, while the
daemon is selected, **Use pinned models**. The buttons post `refresh`, `install`, `start`, `ollama`,
`use-ollama` and `use-pinned`; `open()` performs one automatic Ollama check after the first refresh.
**Start local runtime** is enabled when the pinned plan is available, and also when a sidecar is
configured and the phase is ready although the plan still says `runtime-not-bundled`; the section
then says the runtime will be downloaded and verified on start and the button calls `start()`
(falling back to `startPlan()` for a wizard that does not expose it). **Use Ollama** is enabled only when the summary is available and
carries `providerOptions`. The Ollama section shows the not-checked, available (base URL, chat and
embedding model, and whether the daemon is in use) and unavailable (bounded reason) states with every
value escaped. An **Embedding server** section renders the same plan: the executable and model paths and
the exact flags when the pinned plan is available, the loopback base URL and embedding model when the
daemon is selected, and one bounded sentence per blocked reason, including `runtime-not-bundled`,
`no-embedding-model`, the not-ready case and a closed-wizard message for `disposed`. `embeddingFlags` reads at most 16 bounded `commandArgs`
strings through own data descriptors (a non-array, a revoked Proxy or a hostile trap renders no flags, and an
accessor-backed entry is skipped without being invoked, while the other data entries still show), and every rendered value is escaped like the rest of the page. When the pinned start plan is available, the local-runtime section also shows the
bounded restart policy (up to N attempts, the back-off range and the stability window) read through own
data descriptors; a missing, malformed, out-of-range, accessor-backed or revoked value omits that line
instead of throwing. Every message must be a plain object (not a Proxy or an array) with exactly one own enumerable
data `type` property; a Proxy or revoked Proxy, an array, an unknown key, an accessor, a non-object and
a non-string `type` are rejected as `invalid-message`, and a `type` above 64 KiB of UTF-8 is
`message-too-large`; any other string is `unknown-message`, and a wizard without the optional
`useOllama`/`usePinned` methods answers `unknown-message` for those two. The page sets one fresh
24-character base64 CSP nonce in `default-src 'none'; style-src 'nonce-...'; script-src 'nonce-...';
base-uri 'none'; form-action 'none'` and on the matching `<style>` and `<script>` tags, and the
fallback page carries a valid nonce too. It escapes every dynamic value, and never includes a file
path from a model row unless it came from the validated wizard view. A missing wizard or a wizard
error is reported with a fixed message.

The panel is unit-tested against the same fake `vscode` API as the provider setup panel. A real
extension-host smoke of this panel and a rebuilt-app screenshot remain M6/M12 integration work; the
built `Vibecodium.exe` cannot start under this host ACL. The start action can now install the pinned
runtime, but a real download and start are still a manual smoke because the tests inject the
installer.

## Security boundary

The controller owns no child process and reads no model file, and it performs no I/O of its own. The
network effects this slice adds are the injected `discoverOllama`, whose product default is the
reviewed loopback probe (one credential-free `GET` to `http://127.0.0.1:<port>/api/tags`, gated by
the M1 endpoint policy before the request and bounded by its own deadline and body cap), and the
injected `installSidecar`, whose product default is the reviewed pinned installer (a credential-free
bounded transfer that verifies the archive and every extracted file before writing). The wizard
validates the manifest, the sole id, the host-owned `appDataRoot` or absolute `targetDir` (never both)
and the platform target at construction, and validates the returned executable path with the
supervisor's own check before the
plan uses it. The probe, both sidecar effects, the verifier and the downloader are injected, and the
product uses the reviewed modules. The catalog is validated before any entry is projected; the
recommendation validates the hardware and model descriptors again; the downloader validates the URL,
the destination and the bytes; `toOllamaProviderOptions` re-validates the whole daemon answer before a
provider override is exposed; `validateRestart` validates the restart policy through own data
descriptors; `runtimeOptions()` copies only the six supervisor fields; and the supervisor re-validates
the executable, the model, the flags and the policy. `EMBEDDING_SERVER_ARGS` is frozen at module load and
`embeddingPlan()` reuses it, so a caller cannot supply embedding flags; `embeddingRuntimeOptions()`
copies only the four supervisor fields and a daemon plan carries only the validated base URL and
embedding model.
Errors expose only a code matching `^[a-z0-9][a-z0-9-]{0,63}$` and a fixed message, so an injected
error body, path or credential is never echoed; the Ollama summary carries only a validated base URL,
model names, a count and bounded notice codes; the restart line carries bounded integers only; the
progress view carries byte counts and catalog ids
only, never a URL, a response body or a credential. Selecting the daemon cannot start, install or
update it, cannot run before a successful check or during a download, and cannot write provider
configuration; a daemon start plan exposes only the validated loopback base URL, chat model and
optional embedding model. The panel escapes every dynamic value, caps each message `type` at 64 KiB
of UTF-8, and uses the same nonce in `style-src`, `script-src`, the `<style>` tag and the `<script>` tag.

Residual risks: the wizard trusts its injected `probe`, `downloadModel`, `verifyModel`, `discoverOllama`,
`installSidecar`, `verifySidecar` and `runtimePath` exactly as the supervisor trusts a caller-supplied
binary; the product wiring leaves them at their reviewed defaults. The sidecar `appDataRoot` (preferred)
or `targetDir` is host-owned: with a root the installer derives and proves the directory itself, and the
legacy absolute directory must still be one the application controls, never a webview value; a caller
that passes a writable, attacker-controlled directory can still be redirected by a filesystem junction
the installer already rejects. Any loopback service that answers `/api/tags` with a
valid shape is reported as Ollama, though the only effect is a displayed base URL and the overrides
offered to that same endpoint, with no secret and no write. The start action installs the pinned
runtime but still only assembles data, so a bug there cannot start a process with unexpected flags or
an unbounded restart loop; the eventual caller must still pass the options through the supervisor
rather than building a child itself. The supervisor's `commandArgs` check enumerates the long-form
`--host`/`--port` forms, the `-ag`/agent/MCP switches and every registered spelling of the
remote-model switches (`-hf`/`-hfr`/`--hf-repo`/`--hf-repo-draft`, `-hff`/`--hf-file`,
`-hft`/`--hf-token`, `-hfd`/`-hfrd`/`--spec-draft-hf`, `-mmu`/`--mmproj-url`, `-mu`/`--model-url`,
`-dr`/`--docker-repo`, and the eleven value-less presets that write a remote repository), and the
server's router-mode model family (`--models-dir`/`--models-preset` with the `--models-max`,
`--models-memory-margin` and `--models-autoload`/`--no-models-autoload` switches, refused through the
`--models-`/`--no-models-` prefix because a preset INI can name an `hf-repo` and a directory can hold
any model), so the short-alias gap this note recorded is closed in the supervisor, and this plan only
ever passes the frozen embedding list. An `--embedding` server is narrower than the chat plan because it does
not serve completions, but it runs under the same supervisor contract: `createLlamaServer` always sets
`LLAMA_API_KEY` (its own generated key or a validated caller key, written into the child environment last),
so `/props` requires the bearer key and a caller without it cannot drive the process.

## Verification

`node --test tests/vibe/first-run-ollama.test.mjs` covers the detection: the null-before-check view,
the provider overrides and summary, the no-chat-model case, forged/stale/remote/wrong-base rejection,
every unavailable reason, thrown and malformed effects (including a Proxy, an accessor and a throwing
trap), unknown and oversized fields, single-flight, the unchanged provisioning state, disposal, and
option validation without invoking a getter. It also covers the selection: `useOllama` before a check
and after a refresh without one, the daemon start plan and its frozen shape, `install()` returning
`ollama-selected` without a download, `usePinned` restoring the pinned phase, an insufficient machine
becoming ready while the daemon is selected, the selection being released when a re-check loses the
daemon, and the chat-less, busy and disposed refusals.

`node --test tests/vibe/first-run-restart.test.mjs` covers the hand-off: the default policy in the plan,
the view and the runtime options, one frozen policy object shared by both, the six exact supervisor
fields accepted unchanged by `createLlamaServer` with no spawn, a supplied policy copied and frozen but
never mutated, the documented partial-policy defaults, and the invalid cases (null, array, string,
empty object, missing or out-of-range fields, a cap below the base delay, a reserved key, an accessor
that is never invoked, a revoked Proxy and a throwing Proxy) failing closed as `invalid-options`
before the probe runs. It also proves `runtimeOptions()` reports `not-ready` and
`runtime-not-bundled` without a process. The panel test renders the restart line for a valid policy,
formats milliseconds and seconds, omits a malformed or out-of-range policy (an unknown, reserved or
extra key, a non-integer, or a cap below the base delay), and proves an accessor-backed or revoked
`restart` value is never invoked. A bounds-alignment test imports the supervisor's `MIN_`/`MAX_`
restart constants so a change there fails the panel test instead of silently drifting.

`node --test tests/vibe/first-run-sidecar.test.mjs` covers the start action: `runtime-not-bundled`
without a sidecar, one install then a cached plan, the default `<destinationDir>/runtime` target, an
`appDataRoot` that derives `<root>/runtime/<platformKey>/<id>-<version>` and passes only `{ ownedRoot,
platformKey }` (plus the installer's existing `signal`/`onProgress`) instead of a caller directory, adoption of an owned runtime through `appDataRoot` without
a download, a bounded failure with a retry, an unverified/relative/missing/Proxy installer result, an
accessor-backed result that is never invoked, the not-ready and insufficient refusals, adoption of an
already installed runtime through the offline verifier, a throwing or hostile verifier that never
breaks refresh, clamped progress, busy while a model download runs, disposal, the daemon plan with no
install, and construction validation (Proxy, accessor, unknown key, malformed manifest, unknown id,
unsupported platform, relative or traversal target directory, `targetDir` alongside `appDataRoot`,
non-function effects) with no getter invoked. The panel tests add the enabled **Start local runtime**
button for a configured sidecar, the
explanatory text, the bounded runtime progress line, an accessor-backed runtime that is never
invoked, and the `start()` call with its success and bounded failure statuses.

`node --test tests/vibe/first-run-embedding.test.mjs` covers the embedding plan: `not-ready` before a
refresh, `disposed` after disposal, `runtime-not-bundled` while the pinned runtime is missing, the frozen
pinned shape whose `modelPath` joins the destination directory and the catalog's embedding file and
whose `commandArgs` deep-equals `EMBEDDING_SERVER_ARGS`, the delivered `createLlamaServer` accepting
those options unchanged (its own flag validation accepts the pinned list without mutating it), the same
restart policy as the chat plan, and
`embeddingRuntimeOptions()` returning exactly the four fields frozen at both levels and accepted
unchanged by `createLlamaServer` without spawning. One focused test pins the recorded context: the `-c`
value equals `String(RECOMMENDED_EMBEDDING_CONTEXT_TOKENS)` (the test imports the constant, so the flag
and the policy cannot drift), sits before the batch flags, is not below the recorded `-b`, and appears
exactly once beside a single `--pooling`. It also proves the daemon shape, the
`no-embedding-model` case for a chat-only daemon, the restoration of the pinned plan after `usePinned`,
and that the view carries the same plan. The panel test renders the escaped embedding section for a ready
plan, a hostile `modelPath` and flag list, every blocked reason, the daemon shape, an accessor-backed
plan that is never invoked, and an older view without the plan that still shows the heading.

`node --test tests/vibe/first-run.test.mjs tests/vibe/first-run-panel.test.mjs` covers the projection,
both required roles, the ready, needs-download, insufficient and failed phases, merged notices, the
download order and progress, idempotence, single-flight, abort, retry after a failure, safe error
text, accessor and Proxy rejection, the start plan with and without a binary, escaping and the panel
message vocabulary. It also proves the CSP `style-src` and `script-src` nonces equal the `<style>` and
`<script>` tag nonces (with `base-uri 'none'`, `form-action 'none'` and a valid fallback nonce), a
revoked Proxy is rejected as `invalid-message`, a `type` above 64 KiB of UTF-8 fails as
`message-too-large`, and a synchronous downloader throw reports `install-failed` and leaves the wizard
free for a retry that finishes the missing models. The panel tests also cover the three Ollama states,
the automatic check on open, the bounded `ollama` message and the rejection of a wizard without
`checkOllama`. The selection tests cover both control buttons, the disabled state without provider
options, the daemon start plan rendering, the two control messages, the precise `ollama-selected`
install status and the unknown-message answer when a wizard lacks the optional methods. `node --test src/stable/extensions/vibecodium-ai/src/extension-contract.test.cjs`
covers the two new commands. The full acceptance uses `node vibe/tools/verify.mjs --strict` and
`node vibe/tools/docs-check.mjs --strict`; the docs check also rejects an unmerged conflict marker in
any `docs/vibe` Markdown file, because the #78 merge had left one in `ROADMAP.md` and `CHANGELOG.md`
without failing a check.

## Next steps

Copy the installed files and `vibe/models/catalog.json` into the packaged application (the pin,
verified installer and start-action wiring are delivered in
[m3-sidecar-binary.md](m3-sidecar-binary.md)), place the generated third-party notice beside the
installed files and the application (see [m3-third-party-notices.md](m3-third-party-notices.md)),
supply the Microsoft VC++ 2015-2022 x64 runtime, and run one live install/start smoke on a clean Windows
machine. The installer-owned runtime directory is delivered: the host configures `appDataRoot`, the
installer derives `<root>/runtime/<platformKey>/<id>-<version>` and refuses a caller `targetDir`
alongside it, and the wizard still keeps the legacy `targetDir` for a host that already owns a runtime.
The embedding
start plan and its supervisor hand-off are delivered above; the caller that actually starts and
supervises that second process is the M6 index binding, its first consumer, and the wizard itself ships
no process. That binding must smoke-start the pinned `b12426` archive with `EMBEDDING_SERVER_ARGS` before
it relies on them. The frozen constant pins `-c 8192`, `-b 8192` and `-ub 8192`: at `b12426`
`--ctx-size` defaults to 0 so an unpinned server would take the trained 32768-token context,
`llama_context` sizes the physical batch as `min(n_batch, n_ubatch)`, clamps the logical batch to
the context for a causal model, and the default `--batch-size` of 2048 would otherwise clamp the
requested ubatch, so `-ub 8192` alone starts cleanly but batches at 2048. The `-c` value is the
hardware probe's `RECOMMENDED_EMBEDDING_CONTEXT_TOKENS`, so the estimate the wizard shows and the
server it describes count the same context. Offering
the same discovered daemon in the B5 provider setup panel is M2
work. A real extension-host smoke of the panel and a rebuilt-app screenshot remain M6/M12 integration
work.
