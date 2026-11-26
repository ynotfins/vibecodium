# M3 first-run wizard

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-26
>
> The first-run setup experience. The headless controller lives in
> [first-run.mjs](../../../src/stable/runtime/first-run.mjs), the webview panel in
> [first-run.cjs](../../../src/stable/extensions/vibecodium-ai/src/first-run.cjs), and the acceptance
> tests in [first-run.test.mjs](../../../tests/vibe/first-run.test.mjs),
> [first-run-panel.test.mjs](../../../tests/vibe/first-run-panel.test.mjs),
> [first-run-sidecar.test.mjs](../../../tests/vibe/first-run-sidecar.test.mjs),
> [first-run-ollama.test.mjs](../../../tests/vibe/first-run-ollama.test.mjs) and
> [first-run-restart.test.mjs](../../../tests/vibe/first-run-restart.test.mjs). It composes the delivered
> probe ([m3-hardware-probe.md](m3-hardware-probe.md)), catalog and downloader
> ([m3-model-downloader.md](m3-model-downloader.md)), supervisor contract
> ([m3-llama-server.md](m3-llama-server.md)) and pinned sidecar installer
> ([m3-sidecar-binary.md](m3-sidecar-binary.md)).

## Scope

This document covers M3's fourth runtime slice, the first-run wizard, plus the later wiring of Ollama
detection and explicit daemon selection into it and of the supervisor's restart policy into the
hand-off: one flow that tells a new install what this machine can run, which pinned weights are
already present, downloads only the missing ones, and hands the caller the exact local B1 start
plan and, for the pinned path, the exact `createLlamaServer` options. It ships no `llama-server`
process and no binary: the supervisor still owns the process boundary, the pin and verified
installer are the separate [m3-sidecar-binary.md](m3-sidecar-binary.md) slice, and the wizard
installs that pin on demand through `installRuntime()` (adopting the verified executable) or an
injected effect, so the pinned start plan reports `runtime-not-bundled` only until a runtime is
installed or passed as `runtimePath`. Node built-ins only.

Out of scope: spawning or supervising `llama-server`, bundling or signing the binary (the pin and
download/install module are delivered separately in [m3-sidecar-binary.md](m3-sidecar-binary.md)),
copying the catalog into a packaged application, changing the supervisor's restart behaviour,
starting/installing/updating [PERSON_NAME], pulling [PERSON_NAME] models, switching the active B1 provider or writing
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

`createFirstRunWizard({ catalog, destinationDir, probe?, downloadModel?, verifyModel?, runtimePath?, installRuntime?, sidecar?, sidecarDir?, onChange?, discoverOllama?, restart? })`
returns a frozen controller with `refresh()`, `install()`, `startPlan()`, `runtimeOptions()`,
`installRuntime()`, `checkOllama()`, `useOllama()`, `usePinned()`, `view()` and `dispose()`.

| Option | Meaning |
|---|---|
| `catalog` | The pinned catalog object; validated once at construction. |
| `destinationDir` | Absolute local directory that holds the pinned GGUF files. It need not exist yet; the downloader creates it after proving the nearest existing ancestor real. |
| `probe` | Optional probe function, default `probeHardware`. Tests inject one; the product leaves it unset. |
| `downloadModel` | Optional downloader, default `downloadModel`. The panel leaves it unset; tests inject a local fake so no network is used. |
| `verifyModel` | Optional verifier, default `verifyInstalledModel`. It hashes an installed file and never touches the network. |
| `runtimePath` | Optional packaged `llama-server` executable. It is validated with the supervisor's `validateLlamaExecutablePath` at construction; without it the pinned `startPlan()` reports `runtime-not-bundled` until `installRuntime()` adopts an executable (a selected daemon still yields the daemon plan). |
| `installRuntime` | Optional injected async installer `({ onProgress }) => result`. It is validated as a function at construction and cannot be combined with `sidecar`/`sidecarDir`; tests inject a fake so no transfer runs. |
| `sidecar` | Optional validated sidecar pin (a `vibe/sidecars.json` entry). It must resolve for the host through `resolveSidecarTarget`, must be supplied together with `sidecarDir`, and turns the default installer into `installSidecar(sidecar, { targetDir, onProgress })`. |
| `sidecarDir` | Absolute local directory for the pinned sidecar install (no relative segments or Win32-invalid trailing dot/space). Supplied together with `sidecar`; the test only builds the configuration and never runs the installer. |
| `onChange` | Optional display callback, invoked with the current view after a phase or progress change. A throwing callback is ignored. |
| `discoverOllama` | Optional discovery effect, default the delivered `discoverOllama`. Tests inject a local fake so no socket is opened; the product leaves it unset. |
| `restart` | Optional restart policy handed to the supervisor. It is validated with the supervisor's exported `validateRestart` at construction; omitted uses the frozen conservative default `{ maxRestarts: 3, baseDelayMs: 1000, maxDelayMs: 30000, stableMs: 60000 }`. |

Options, the probe result and the install options are read through own data descriptors. A Proxy, an
accessor, an unknown or reserved key, a relative, UNC or traversal destination, a missing catalog, an
invalid executable path, a non-function `installRuntime`, a half-configured or unresolvable sidecar
pin and an invalid restart policy fail closed as `invalid-options` or `invalid-catalog` without
invoking a getter and before the probe runs.

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

### Start plan and runtime options

`startPlan()` returns frozen data only when the phase is `ready`. The two shapes are:

```
{ available: true, kind: 'llama-server', executablePath, modelPath, embeddingModelPath, contextSize, threads, gpuLayers, restart }
{ available: true, kind: 'ollama', baseUrl, model, embeddingModel }
```

The daemon shape is returned while the discovered daemon is the selected runtime and its summary
still carries validated `providerOptions`; its `baseUrl` and `model` are exactly the overrides the
B1 `ollama` preset takes, and `embeddingModel` is the discovered optional embedding model. Otherwise
the pinned shape is returned when a validated `runtimePath` exists; without it the result is
`{ available: false, reason: 'runtime-not-bundled' }`. Before a successful refresh, or when the phase
is not `ready`, it is `{ available: false, reason: 'not-ready' }`. The caller passes a pinned plan to
the supervisor, which still validates the executable, the model path and every flag. `restart` is the
effective policy (`DEFAULT_FIRST_RUN_RESTART_POLICY` or the validated caller policy), the same frozen
object the supervisor will receive. The wizard never spawns the process.

`runtimeOptions()` is the hand-off to the supervisor. When the pinned path is available it returns
`{ available: true, options }` where `options` contains exactly the `createLlamaServer` fields
`executablePath`, `modelPath`, `contextSize`, `threads`, `gpuLayers` and `restart`; it omits `kind`,
the wizard-only `embeddingModelPath` and `available`, a port and a `fetch` implementation. A caller can
therefore write `createLlamaServer(wizard.runtimeOptions().options)` and the supervisor re-validates
the executable, the model path, every flag and the policy. While a daemon is selected it returns the
daemon start plan instead (there are no supervisor options), and otherwise it returns the same
`{ available: false, reason }` value as `startPlan()`. The wizard always chooses a bounded restart
policy; a caller that wants no automatic restart builds its own supervisor options instead.

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

## The runtime install hand-off

The wizard can install the pinned `llama-server` sidecar it is about to start. Two configurations
are accepted, never both:

- `sidecar` plus `sidecarDir`: the product default. The pin must resolve for the host
   (`resolveSidecarTarget`) and the directory must be an absolute local path (no relative segments or
   Win32-invalid trailing dot/space); the wizard then calls the delivered `installSidecar` with
   `{ targetDir, onProgress }`.
- `installRuntime`: an injected async effect with the same shape, for tests and for a host that owns
   the installer. It cannot be combined with a pin, and half a pin fails closed.

`installRuntime()` is single-flight and refuses (`busy`) while a model download or the first hardware
check (`probing`) runs, while the model install refuses while a runtime install runs. Disposing the
wizard during an install leaves a terminal `{ status: 'failed', code: 'disposed' }` instead of a
stuck `installing` state, and the in-flight transfer is not cancelled (a later slice can own an abort
signal). It exposes `view().runtime`: `null` before the first attempt (the panel renders it as idle),
then `{ status: 'installing', received, total }` with the runtime step `active`,
`{ status: 'installed', version, sizeBytes, installed, skipped }` or `{ status: 'failed', code }`,
with byte counts clamped to the reported total and no path. The executable is adopted only when the
answer is a plain data object with `verified: true`, boolean `installed` and `skipped`, a bounded
version and size, and an `executablePath` that the supervisor's `validateLlamaExecutablePath` accepts;
a forged, accessor-backed, revoked-Proxy, malformed or non-executable answer, and a thrown effect,
leave the path unset on a first attempt and report one bounded code (a failed re-install keeps an
earlier verified path, which the supervisor re-validates at start). On success the runtime step turns `ready` once the
pinned models are installed, when the start plan and `runtimeOptions()` become available with that
path (before that the phase stays `needs-download` and the plan `not-ready`), and the returned result
carries no path. The wizard still never downloads in a test, never extracts, never spawns and never
starts the server.

## The panel

`createFirstRunController({ vscode, extensionUri, wizardProvider })` registers
`vibecodium.firstRun.open` and `vibecodium.firstRun.setWizard`. The webview renders the phase, verdict,
acceleration, the four steps (hardware check, pinned models, model download, local runtime), the model
rows and sizes, the notice codes, a progress element during a download, the runtime install status
line and button, an Ollama section, and six or seven buttons: **Check again**, **Download models**,
**Install local runtime**, **Start local runtime**, **Check for Ollama**, **Use Ollama** and, while
the daemon is selected, **Use pinned models**. The buttons post `refresh`, `install`,
`install-runtime`, `start`, `ollama`, `use-ollama` and `use-pinned`; `open()` performs one automatic Ollama
check after the first refresh. **Use Ollama** is enabled only when the summary is available and
carries `providerOptions`. The Ollama section shows the not-checked, available (base URL, chat and
embedding model, and whether the daemon is in use) and unavailable (bounded reason) states with every
value escaped. When the pinned start plan is available, the local-runtime section also shows the
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
built `Vibecodium.exe` cannot start under this host ACL, and the workbench still has to connect the
wizard and give it a sidecar pin or installer before a pinned start is reachable.

## Security boundary

The controller owns no child process and reads no model file. It performs no transfer of its own: the
runtime install delegates to the reviewed sidecar installer (a credential-free, bounded, digest-checked
transfer) through its product default, and the injected `discoverOllama` defaults to the
reviewed loopback probe: one credential-free `GET` to
`http://127.0.0.1:<port>/api/tags`, gated by the M1 endpoint policy before the request and bounded
by its own deadline and body cap. The probe, the verifier, the downloader and the installer are
injected, and the product uses the reviewed modules. The catalog is validated before any entry is
projected; the recommendation validates the hardware and model descriptors again; the downloader
validates the URL, the destination and the bytes; the installer validates the pin, the archive and every
extracted file; `toOllamaProviderOptions` re-validates the whole daemon answer before a
provider override is exposed; `validateRestart` validates the restart policy through own data
descriptors; `runtimeOptions()` copies only the six supervisor fields; and the supervisor re-validates
the executable, the model, the flags and the policy.
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
`installRuntime` (or the `sidecar` pin it delegates to) and `runtimePath` exactly as the supervisor
trusts a caller-supplied binary; the product wiring leaves them at their reviewed defaults. Any loopback service that answers `/api/tags` with a valid shape is
reported as [PERSON_NAME], though the only effect is a displayed base URL and the overrides offered to that
same endpoint, with no secret and no write. The start action and `runtimeOptions()` only assemble data,
so a bug there cannot start a process with unexpected flags or an unbounded restart loop, but the
eventual caller must still pass the options through the supervisor rather than building a child itself.

## Verification

`tests/vibe/first-run-sidecar.test.mjs` covers the runtime install hand-off: the option contract and
its fail-closed paths (including a hostile `sidecar` pin and a half configuration), the single-flight
and mutual-exclusion guards against a model install and a probe, the bounded progress view, the
adoption rule for a verified executable, the refusal of a forged, accessor-backed, revoked-Proxy,
malformed or non-executable answer, a hostile thrown effect, and the terminal `disposed` state.
`tests/vibe/first-run-panel.test.mjs` adds the runtime status rendering, the hostile-view omission and
the one-message `install-runtime` forwarding.

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
`node vibe/tools/docs-check.mjs --strict`.

## Next steps

Bundle the pinned `llama-server` binary (the pin and verified installer are delivered in
[m3-sidecar-binary.md](m3-sidecar-binary.md)), copy `vibe/models/catalog.json` into the packaged
application, run one live install/start smoke, and start the embedding server from a
second plan (with `--embedding --pooling last -ub 8192` for the embedding weights). Offering the
same discovered daemon in the B5 provider setup panel is M2
work. A real extension-host smoke of the panel and a rebuilt-app screenshot remain M6/M12 integration
work.
