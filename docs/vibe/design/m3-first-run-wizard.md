# M3 first-run wizard

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-26
>
> The first-run setup experience. The headless controller lives in
> [first-run.mjs](../../../src/stable/runtime/first-run.mjs), the webview panel in
> [first-run.cjs](../../../src/stable/extensions/vibecodium-ai/src/first-run.cjs), and the acceptance
> tests in [first-run.test.mjs](../../../tests/vibe/first-run.test.mjs) and
> [first-run-panel.test.mjs](../../../tests/vibe/first-run-panel.test.mjs). It composes the delivered
> probe ([m3-hardware-probe.md](m3-hardware-probe.md)), catalog and downloader
> ([m3-model-downloader.md](m3-model-downloader.md)) and supervisor contract
> ([m3-llama-server.md](m3-llama-server.md)).

## Scope

This slice is M3's fourth runtime slice: one flow that tells a new install what this machine can run,
which pinned weights are already present, downloads only the missing ones, and hands the caller the
exact local B1 start plan. It ships no `llama-server` process and no binary: the supervisor still
owns the process boundary, and the start action reports `runtime-not-bundled` until the llama.cpp
binary is pinned and bundled in a later M3 slice. Node built-ins only.

Out of scope: spawning or supervising `llama-server`, bundling, downloading or signing the binary,
copying the catalog into a packaged application, restart/back-off, Ollama detection, provider calls,
model-ladder changes and NVML/vendor GPU libraries.

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

`createFirstRunWizard({ catalog, destinationDir, probe?, downloadModel?, verifyModel?, runtimePath?, onChange? })`
returns a frozen controller with `refresh()`, `install()`, `startPlan()`, `view()` and `dispose()`.

| Option | Meaning |
|---|---|
| `catalog` | The pinned catalog object; validated once at construction. |
| `destinationDir` | Absolute local directory that holds the pinned GGUF files. It need not exist yet; the downloader creates it after proving the nearest existing ancestor real. |
| `probe` | Optional probe function, default `probeHardware`. Tests inject one; the product leaves it unset. |
| `downloadModel` | Optional downloader, default `downloadModel`. The panel leaves it unset; tests inject a local fake so no network is used. |
| `verifyModel` | Optional verifier, default `verifyInstalledModel`. It hashes an installed file and never touches the network. |
| `runtimePath` | Optional packaged `llama-server` executable. It is validated with the supervisor's `validateLlamaExecutablePath` at construction; without it `startPlan()` reports `runtime-not-bundled`. |
| `onChange` | Optional display callback, invoked with the current view after a phase or progress change. A throwing callback is ignored. |

Options, the probe result and the install options are read through own data descriptors. A Proxy, an
accessor, an unknown or reserved key, a relative, UNC or traversal destination, a missing catalog and
an invalid executable path fail closed as `invalid-options` or `invalid-catalog` without invoking a
getter.

### Phases

`idle -> probing -> needs-download | ready | insufficient -> downloading -> ready | failed`.

- `probing` while the probe and the file verification run.
- `needs-download` when at least one pinned file is missing and the machine can run the selected model.
- `insufficient` when the recommendation verdict is `insufficient` (below 8 GiB RAM, or the smallest
   chat model does not fit). `install()` refuses this phase.
- `ready` when both pinned files verify and the verdict is not `insufficient`.
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

### Start plan

`startPlan()` returns frozen data only when the phase is `ready` and a validated `runtimePath` exists:

```
{ available: true, executablePath, modelPath, embeddingModelPath, contextSize, threads, gpuLayers }
```

Otherwise it returns `{ available: false, reason: 'not-ready' | 'runtime-not-bundled' }`. The caller
passes this to the supervisor, which still validates the executable, the model path and every flag.
The wizard never spawns the process.

## The panel

`createFirstRunController({ vscode, extensionUri, wizardProvider })` registers
`vibecodium.firstRun.open` and `vibecodium.firstRun.setWizard`. The webview renders the phase, verdict,
acceleration, the four steps (hardware check, pinned models, model download, local runtime), the model
rows and sizes, the notice codes, a progress element during a download, and three buttons: **Check
again**, **Download models** and **Start local runtime**. The buttons post `refresh`, `install` and
`start`. Every message must be a plain object (not a Proxy or an array) with exactly one own enumerable
data `type` property; a Proxy or revoked Proxy, an array, an unknown key, an accessor, a non-object and
a non-string `type` are rejected as `invalid-message`, and a `type` above 64 KiB of UTF-8 is
`message-too-large`; any other string is `unknown-message`. The page sets one fresh 24-character base64
CSP nonce in `default-src 'none'; style-src 'nonce-...'; script-src 'nonce-...'; base-uri 'none';
form-action 'none'` and on the matching `<style>` and `<script>` tags, and the fallback page carries a
valid nonce too. It escapes every dynamic value, and never includes a file path from a model row unless
it came from the validated wizard view. A missing wizard or a wizard error is reported with a fixed
message.

The panel is unit-tested against the same fake `vscode` API as the provider setup panel. A real
extension-host smoke of this panel and a rebuilt-app screenshot remain M6/M12 integration work; the
built `Vibecodium.exe` cannot start under this host ACL, and the start action is blocked until the
binary is bundled anyway.

## Security boundary

The controller performs no I/O of its own. It does not open a socket, read a model file or spawn a
process: the probe, the verifier and the downloader are injected, and the product uses the reviewed
modules. The catalog is validated before any entry is projected; the recommendation validates the
hardware and model descriptors again; the downloader validates the URL, the destination and the bytes;
the supervisor validates the executable, the model and the flags. Errors expose only a code matching
`^[a-z0-9][a-z0-9-]{0,63}$` and a fixed message, so an injected error body, path or credential is never
echoed; the progress view carries byte counts and catalog ids only, never a URL, a response body or a
credential. The panel escapes every dynamic value, caps each message `type` at 64 KiB of UTF-8, and
uses the same nonce in `style-src`, `script-src`, the `<style>` tag and the `<script>` tag.

Residual risks: the wizard trusts its injected `probe`, `downloadModel`, `verifyModel` and
`runtimePath` exactly as the supervisor trusts a caller-supplied binary; the product wiring leaves
them at their reviewed defaults. The start action only assembles data, so a bug there cannot start a
process with unexpected flags, but the eventual caller must still pass the plan through the
supervisor rather than building a child itself.

## Verification

`node --test tests/vibe/first-run.test.mjs tests/vibe/first-run-panel.test.mjs` covers the projection,
both required roles, the ready, needs-download, insufficient and failed phases, merged notices, the
download order and progress, idempotence, single-flight, abort, retry after a failure, safe error
text, accessor and Proxy rejection, the start plan with and without a binary, escaping and the panel
message vocabulary. It also proves the CSP `style-src` and `script-src` nonces equal the `<style>` and
`<script>` tag nonces (with `base-uri 'none'`, `form-action 'none'` and a valid fallback nonce), a
revoked Proxy is rejected as `invalid-message`, a `type` above 64 KiB of UTF-8 fails as
`message-too-large`, and a synchronous downloader throw reports `install-failed` and leaves the wizard
free for a retry that finishes the missing models. `node --test src/stable/extensions/vibecodium-ai/src/extension-contract.test.cjs`
covers the two new commands. The full acceptance uses `node vibe/tools/verify.mjs --strict` and
`node vibe/tools/docs-check.mjs --strict`.

## Next steps

Pin and bundle the `llama-server` binary, copy `vibe/models/catalog.json` into the packaged
application, and pass the start plan to the supervisor (with `--embedding --pooling last -ub 8192` for
the embedding weights). Then add restart/back-off and Ollama detection. A real extension-host smoke of
the panel and a rebuilt-app screenshot remain M6/M12 integration work.
