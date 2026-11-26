# M3 local model downloader

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-25
>
> First-run model provisioning. The module lives in
> [model-downloader.mjs](../../../src/stable/runtime/model-downloader.mjs), the pin file in
> [catalog.json](../../../vibe/models/catalog.json), and the acceptance tests in
> [model-downloader.test.mjs](../../../tests/vibe/model-downloader.test.mjs). It sits beside the
> supervisor in [m3-llama-server.md](m3-llama-server.md) and feeds the first-run wizard.

## Scope

This is M3's second slice: fetching the weights the local runtime needs. It ships a model catalog with
two pinned GGUF files, a validator for that catalog and for a single entry, a resumable downloader that
installs only verified bytes, and a `verifyInstalledModel` check the wizard can call before it starts a
server. It does not bundle or download the `llama-server` binary, pin `vibe/sidecars.json`, probe the
GPU or RAM, render the wizard, restart a failed server, detect Ollama or call the runtime.

## Catalog

`vibe/models/catalog.json` is the repository's pin file. Its version is `1`, it lists between 1 and 16
models, and every entry carries exactly twelve fields: `id`, `label`, `repo`, `revision`, `file`, `url`, `sha256`,
`sizeBytes`, `license`, `quantization`, `contextTokens` and `role`.

| Field | Rule |
|---|---|
| `id` | lowercase slug, at most 64 characters, unique in the catalog |
| `label` | display text, at most 120 characters |
| `repo` | `owner/name`, at most 96 characters |
| `revision` | 40-character lowercase commit id; a branch or tag is refused |
| `file` | one plain `*.gguf` name, at most 128 characters, no separator, no `..`, not a Win32 reserved device name, unique in the catalog |
| `url` | `https`, at most 2048 characters, no credentials, no query, no fragment; plain `http` only on a loopback host |
| `sha256` | 64-character lowercase digest of the whole file |
| `sizeBytes` | whole byte count from 1 to 12 GiB |
| `license` | one of `apache-2.0`, `mit`, `bsd-2-clause`, `bsd-3-clause` |
| `quantization` | lowercase tag, at most 24 characters |
| `contextTokens` | whole token count from 128 to 8,388,608 |
| `role` | one of `chat`, `embedding`, `code`, `edit` |

The two pinned entries are `Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF` at its pinned `q4_k_m` file and
`Qwen/Qwen3-Embedding-0.6B-GGUF` at its pinned `q8_0` file, both Apache-2.0, about 1.04 GiB and 610 MiB.
Their sizes and digests were read from the Hugging Face file listing for those exact revisions
and re-checked against the live `resolve` URLs on 2026-11-25; the downloader verifies those bytes again
before it installs them. The catalog file is copied into the built application by the packaging slice;
this slice only adds it to the repository.

`loadCatalog(text)` parses and validates JSON text, `loadCatalogFile(path)` reads and validates a file,
`validateCatalog(value)` validates an already-parsed value, and `findCatalogModel(catalog, id)` returns
one frozen entry or fails with `unknown-model`. Catalog parsing, root keys, the entry array, each entry
and each field are read through own data descriptors, so an accessor is rejected without being invoked,
a prototype cannot contribute a key, sparse arrays and null-prototype or class-instance entries are
refused, and every failure is a fixed `invalid-catalog` message that never echoes the rejected value.

## Download contract

`downloadModel(entry, options)` returns a frozen result once the pinned bytes are installed.

| Option | Meaning | Default |
|---|---|---|
| `destinationDir` | absolute local directory; created when missing | required |
| `onProgress` | receives frozen `{ received, total, resumedFrom }` events | none |
| `signal` | caller `AbortSignal`; an aborted call keeps the partial file | none |
| `fetchImpl` | request implementation | `globalThis.fetch` |
| `statfsImpl` | free-space probe used before the first request | `fs.statfsSync` |
| `idleTimeoutMs` | longest silence between body chunks, 50 to 600,000 ms | 60,000 |
| `totalTimeoutMs` | whole-transfer deadline, 1,000 to 86,400,000 ms | 3,600,000 |

The result reports `verified`, `skipped` (the final file was already correct), `resumed`,
`resumedFrom`, `restarted` (the server ignored the `Range` request or a resumed attempt was discarded),
`replacedInvalid` (an existing file with the wrong contents was replaced), `sizeBytes`, `sha256` and the
final `path`. `verifyInstalledModel(entry, { destinationDir })` resolves (and, when missing, creates) the
destination directory, returns frozen `{ verified, path, sizeBytes }` and touches no network.

Options are read through own data descriptors once: unknown fields, reserved keys, accessors, a
non-function `onProgress`, a non-`AbortSignal` signal and out-of-range numbers fail closed as
`invalid-options` without invoking a getter or echoing the supplied value. The destination must be an
absolute local path with no `..` segment and no Win32 trailing dot or space; it is created when missing
and then resolved with `realpathSync.native`, so a symlinked or junctioned directory is refused. A
`busy` guard refuses a second concurrent download of the same final path in this process.

## Transfer and resume

The transfer requests `entry.url` with no credential, with `redirect: 'follow'`, an `application/octet-stream` accept header (plus the runtime's own standard transport headers) and
`Range: bytes=<n>-` when a `.part` file already holds `n` bytes. The runtime follows the redirect chain,
and the final response URL must again be `https` - or plain `http` on loopback only when the pinned URL
itself is loopback - without credentials, query or fragment; anything else fails as `insecure-redirect`
before a byte is written. The status is then classified:

- `200`: the server ignored the range, so the partial file is truncated and the transfer restarts at
   zero (`restarted` is reported). A declared `content-length` on a `200` that answers a non-resume
   request must equal the pinned size.
- `206`: `content-range` must start at the resume offset and declare the pinned total, otherwise the
   call fails as `invalid-range-response`.
- `416`: fails as `range-not-satisfiable` and keeps the partial file. A partial file that already
   holds the full pinned size is verified and installed before any request is made, so it never
   reaches this branch.
- any other status: `http-status` with an integer `status` and no body.

Bytes stream into `<final>.part` with `createWriteStream`, under the idle and total deadlines, and are
never allowed to exceed the pinned size. A progress callback that throws is ignored so a failing panel
redraw cannot break a long download. Cancellation, a stalled connection (`stalled`), a total deadline
(`timeout`) and a dropped or short body (`network-error`) all keep the partial file, so the next call
resumes from what is on disk; the incomplete `.part` is never installed under the final name.

## Verification and install

A finished partial file is checked for exact size and then hashed with SHA-256 in one streaming pass.
Only a match is renamed into place with `renameSync`, after the final path and the partial path were
inspected as regular, non-symlink files (the partial path again at the point of use). A mismatch
removes the partial file; a failed attempt that started from a resumed offset is retried once from zero,
and then fails as `size-mismatch` or `checksum-mismatch`. A byte count above the pinned size fails as
`size-mismatch` without installing anything. An existing final file is hashed first: a match returns
`skipped`, and a mismatch is replaced by the verified download (`replacedInvalid`). Free space for the
whole file is checked before the first request when the host exposes `statfsSync`; an unknown or failing
probe is not treated as an error.

## Failure model

`invalid-model`, `invalid-catalog`, `unknown-model`, `invalid-destination`, `invalid-options`,
`runtime-unavailable`, `busy`, `aborted`, `insufficient-space`, `network-error`, `stalled`, `timeout`,
`http-status`, `invalid-range-response`, `range-not-satisfiable`, `size-mismatch`, `checksum-mismatch`,
`insecure-redirect`, `invalid-response`, `write-failed`, `unsafe-path` and `install-failed`. Every
error is a `ModelDownloadError` with a fixed message; only `http-status` carries one extra integer field.
No error, result, progress event or frozen entry contains the URL, a credential, a response body or the
rejected value.

## Security boundary

The catalog is the trust anchor: a download is installed only when its bytes match the pinned size and
digest, so a compromised mirror or a redirected response cannot substitute another file. The URL may not
carry credentials, a query or a fragment, and the catalog format deliberately has no header or token
field, so a presigned URL cannot smuggle a secret into the pin file. The final redirect target must be
`https`, or loopback `http` only when the pinned URL was loopback, and no header from the caller is
forwarded. A missing destination is created only after the nearest existing ancestor has been resolved
and confirmed to be a real, non-symlink directory, and the destination, final and partial paths must
each be real, non-symlink paths when they exist, so a planted junction cannot redirect a create, a
write or an append; a Win32 reserved device name or a colon segment is refused. The `.part` name is
derived from the catalog file name, never from a response header. Free space for the whole file is
checked before a request so a download cannot fill the disk silently, one deadline covers both attempts,
and every buffer is bounded by the pinned size.

Residual risks: the runtime, not this module, performs the intermediate redirect hops, so an
intermediate host sees the `accept` header and, on a resume, the `Range` offset; no credential is ever
attached and the digest remains the gate. A file written by this process can still be replaced between
the final hash and the rename by another local process with write access to the same directory (the
product will own that directory), and a hard link is indistinguishable from a regular file. The
downloaded weights are data, but a later loader parsing a malicious GGUF is outside this module, and the
download is not authenticated beyond the digest, so a pinned digest is also the integrity and
authenticity record for that revision.

## Verification

`node --test tests/vibe/model-downloader.test.mjs` runs the downloader against a local HTTP server with
no network access. It covers the shipped catalog pin (revision, digest, size and `resolve` URL shape),
malformed JSON and non-object input, every rejected catalog field (unknown version, duplicate id and
file, uppercase id, traversal and nested file names, non-GGUF file, branch revision, short digest,
zero and fractional size, disallowed license, plain-http non-loopback URL, userinfo, query and fragment
URLs, unknown and missing entry keys, accessors, sparse arrays, null-prototype and class-instance
entries, prototype keys, reserved device names and the model cap), a complete download with ordered
progress, resume with an exact `Range` request, a server that ignores `Range`, checksum mismatch, a short
and a dropped body that keep the partial file, an oversized body, an already verified file with no
request, replacement of an existing invalid file, caller cancellation followed by a successful resume,
an already aborted signal, a stalled connection, bounded HTTP failures without body leakage, a complete
partial file that installs without a request even when the server would reject a range, an incomplete
partial file that keeps its bytes, an insufficient-space probe that stops before any request, invalid
destinations and options, the concurrent-download guard, a followed redirect, final-URL checks, a
throwing progress callback, `verifyInstalledModel`, credential-free error
messages, creatable nested destinations, a symlinked destination, partial file or final file where the
host allows creating one, a junction above a missing destination, a reserved Win32 destination name, a
loopback plain-http downgrade, and a transfer that outlives the shared total deadline.

The full acceptance uses `node vibe/tools/verify.mjs --strict` and
`node vibe/tools/docs-check.mjs --strict`.

## Next steps

The hardware probe maps GPU and RAM to the runtime start plan, the wizard drives `downloadModel` with a
progress bar, and `vibe/sidecars.json` pins and signs the `llama-server` binary itself. Bundling a
binary, pinning it by digest and detecting Ollama remain M3 work.
