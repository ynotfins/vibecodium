# M3 pinned runtime sidecar

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-26

>
> Pins the llama.cpp `llama-server` release and installs its files only after a size and digest
> check. The module lives in [sidecar.mjs](../../../src/stable/runtime/sidecar.mjs), the pin file in
> [sidecars.json](../../../vibe/sidecars.json), and the acceptance test in
> [sidecar.test.mjs](../../../tests/vibe/sidecar.test.mjs). It composes the supervisor contract in
> [m3-llama-server.md](m3-llama-server.md) and the first-run start plan in
> [m3-first-run-wizard.md](m3-first-run-wizard.md).

## Scope

This is M3's binary slice: the pin for the local runtime executable and the fetch/verify/extract half
of bundling. It downloads the pinned archive into the target directory, verifies the archive digest,
extracts only the allowlisted runtime files, verifies each file against the pin, and returns the
executable path the supervisor and the first-run wizard already accept. It never spawns, signs,
updates, executes or trusts a binary that does not match the pin.

Out of scope: copying the installed files or `vibe/models/catalog.json` into a packaged application,
signing the manifest, installing the Microsoft VC++ runtime, a live start, the CUDA/ROCm/SYCL/OpenVINO
targets (their archives exceed the 64 MiB cap, while the Vulkan x64 and OpenCL arm64 archives fit, so
a GPU backend is a scope decision rather than a size limit), resuming an interrupted archive download,
a UI and any dependency. Node built-ins only.

## The pin

`vibe/sidecars.json` pins one sidecar, `llama-server`, to the llama.cpp nightly `b12426`, MIT,
published 2026-11-15 by `ggml-org/llama.cpp`. Its `win32-x64` CPU archive is
`llama-b12426-bin-win-cpu-x64.zip`, 25,209,516 bytes, SHA-256
`61145645c26cf8d7b3ed76435812192ae42f51c4c51e895936adc61dc1eb0410`. The archive and digest were read
from the live GitHub release on 2026-11-26, and the 23 allowlisted files were hashed from that exact
archive.

The stable `v1.0.0` and `v1.1.0` tags carry no binary assets (each ships only a `nightly-tag.txt`
pointer); only the nightly builds publish Windows archives. The seven-day rule therefore selects an
older nightly: `b12426` has been public since 2026-11-15T21:08Z (10 days 19 hours, 11 calendar days)
on 2026-11-26, while the current nightly was published the same day and cannot be adopted yet. The
next pin candidate is `b12774`, the nightly `v1.1.0` names, adoptable on 2026-12-03.
The pin is a supply-chain record, not a claim that nightlies are stable; `TECH_RADAR.md` carries the
review date and the upgrade rule.

The allowlist is the CPU runtime plus its license text: `llama-server.exe`,
`llama-server-impl.dll`, `llama-common.dll`, `llama.dll`, `mtmd.dll`, `ggml.dll`, `ggml-base.dll`,
the fourteen `ggml-cpu-*.dll` variants, `libomp.dll` and `LICENSE-LLVM-OpenMP`. The archive's other
executables, benchmark tools and RPC helper are not installed. The CPU package still
needs the Microsoft Visual C++ 2015-2022 x64 runtime (`MSVCP140.dll`, `VCRUNTIME140.dll`,
`VCRUNTIME140_1.dll`); the installer must supply it in M12, and this slice only records the dependency.

## Manifest schema

```json
{
  "version": 1,
  "sidecars": [{
    "id": "llama-server",
    "version": "b12426",
    "license": "mit",
    "publishedAt": "2026-11-15",
    "source": "ggml-org/llama.cpp",
    "targets": {
      "win32-x64": {
        "url": "https://github.com/.../llama-b12426-bin-win-cpu-x64.zip",
        "sha256": "<64 hex>",
        "sizeBytes": 25209516,
        "executable": "llama-server.exe",
        "files": [{ "path": "llama-server.exe", "sha256": "<64 hex>", "sizeBytes": 9728 }]
      }
    }
  }]
}
```

| Field | Rule |
|---|---|
| `sidecars` | 1-16 entries with unique ids |
| `id` | lowercase slug, at most 64 characters |
| `version` | bounded tag, at most 64 characters |
| `license` | one of `mit`, `apache-2.0`, `bsd-2-clause`, `bsd-3-clause`, `isc` |
| `publishedAt` | real `YYYY-MM-DD` calendar date |
| `source` | `owner/name`, at most 96 characters |
| `targets` | 1-6 keys shaped `<platform>-<arch>` for win32/linux/darwin and x64/arm64 |
| `url` | HTTPS, or plain HTTP only on a loopback host; no credentials, query or fragment |
| `sha256` | 64 hex characters, normalised to lower case |
| `sizeBytes` | 1 byte to 64 MiB for the archive |
| `executable` | a path from `files`; `.exe` on a `win32` target |
| `files` | 1-64 entries with unique case-folded paths |
| file `path` | forward-slash relative, 1-128 characters, no `.`/`..`, drive, colon, backslash, control/bidi, reserved Win32 device, trailing dot or space, or duplicate segment |
| file `sha256` | 64 hex characters, normalised to lower case |
| file `sizeBytes` | 1 byte to 256 MiB; the target total may not exceed 1 GiB |

`validateSidecarManifest` reads the manifest, each sidecar, target and file through own data
descriptors, so an accessor is rejected without being invoked, a Proxy is read without running a get
trap, and a polluted prototype cannot contribute a key. A sparse array, a null-prototype or
class-instance entry, an unknown or reserved key, a duplicate id or path, a bad platform key and a
non-permissive license all fail closed as `invalid-manifest`. `loadSidecarManifest` and
`loadSidecarManifestFile` wrap JSON parsing and file reads. `findSidecar` and `resolveSidecarTarget`
read own descriptors too.

## Transfer

`installSidecar(sidecar, options)` accepts `{ targetDir, platformKey?, fetchImpl?, onProgress?,
signal?, idleTimeoutMs?, totalTimeoutMs? }`. `targetDir` is an absolute local directory that need not
exist; it is created only after the nearest existing ancestor has been proven a real, non-symlink
directory, then resolved with `realpathSync.native`. A relative, traversal, drive-relative, UNC,
control/bidi or Win32-invalid path fails as `invalid-destination`.

The archive is requested with `accept: application/zip`, no credential, `redirect: 'follow'` and an
idle deadline and a total deadline that cover the body. The final response URL must again be HTTPS, or plain HTTP on loopback
only when the pinned URL was loopback, without credentials or fragment (a query is allowed on the final redirect target, because
GitHub's release CDN signs it); anything else fails as `insecure-redirect`. Only status 200 is accepted. A declared `content-length` must equal the pinned
size, the stream is counted against that size, and the finished 64 MiB-bounded file must hash to the
pin (`size-mismatch`, `checksum-mismatch`). An idle gap, the total deadline and a caller abort fail as
`stalled`, `timeout` and `aborted`; the partial file is removed rather than left for a resume that
this version does not implement. One install per target directory may run at a time (`busy`).

## Archive extraction

A pointer-free ZIP reader parses the end-of-central-directory record, the central directory and each
local header directly from the verified bytes, inside the same numeric caps. ZIP64, multi-disk
archives and encrypted entries are refused; entry counts and the central directory are bounded. Every
entry name is checked as a safe relative path and a symbolic-link external attribute is refused
(`unsafe-entry`), as are duplicate names, encrypted entries and an allowlisted entry with an unsupported compression
method (`invalid-archive`). Only names that exactly match an allowlisted file are extracted; directory
entries and unlisted files are ignored. An allowlisted name missing from the archive is
`missing-entry`; an entry above the file cap is `entry-too-large`. Stored and deflated entries are
inflated with a hard output bound, checked for the pinned size and then hashed: a size mismatch is
`entry-size`, a digest mismatch `entry-checksum`. CRC-32 is not the gate; the pinned [ADDRESS] is
strictly stronger.

All allowlisted files are extracted and verified in memory before the first write, so a bad archive
installs nothing. Each verified buffer is written to a unique `.install-<random>.tmp` file beside its
final name and renamed into place; a rename failure is `install-failed`, a write or directory failure
`write-failed` and the temporary file is removed on a write failure. After the renames, every installed file is re-inspected and re-hashed, and the
executable is passed through the supervisor's `validateLlamaExecutablePath`, so the returned
`executablePath` satisfies the same contract the wizard already uses. A non-Windows install marks the
executable with `0755`. A file that a later pin drops is not removed from an existing target
directory; the installer only adds or replaces the pinned files. A nested file path is checked
again after its parent exists: the real parent must equal the resolved parent and stay inside the
target directory, so a planted junction cannot redirect a nested write. The archive is read once
and that same buffer is hashed and parsed, so a hash/read swap cannot mix files.

`verifySidecarInstall(sidecar, { targetDir, platformKey? })` performs the same inspection without the
network and returns a frozen `{ verified: true, executablePath, version, files, sizeBytes }`, or
`{ verified: false, reason, version }` with `missing`, `size`, `checksum` or `unsafe-path`. A
directory whose files already match the pin makes `installSidecar` return
`{ verified: true, installed: false, skipped: true, ... }` without sending a request, so the wizard
can call it offline.

## Failure model

`invalid-manifest`, `unknown-sidecar`, `unsupported-platform`, `invalid-options`,
`invalid-destination`, `unsafe-path`, `runtime-unavailable`, `busy`, `aborted`, `network-error`,
`stalled`, `timeout`, `http-status` (one integer status), `insecure-redirect`, `invalid-response`,
`size-mismatch`, `checksum-mismatch`, `invalid-archive`, `unsafe-entry`, `entry-too-large`,
`missing-entry`, `entry-size`, `entry-checksum`, `write-failed`, `install-failed` and
`invalid-executable`. Every error is a `SidecarError` with a fixed message. No error, result, progress
event or frozen summary contains the URL, an archive body, a credential or the injected error text;
progress carries only `{ received, total }`.

## Security boundary

The manifest is the trust anchor: a file is installed only when the archive and every extracted file
match a pinned size and digest. The URL carries no credential and the format has no header or token
field, so the pin file cannot smuggle a presigned secret; no caller header is forwarded, an intermediate redirect host sees only the runtime's transport
headers, and a final URL whose literal host is loopback, private, link-local, metadata or
`localhost` is refused when the pin was not loopback. A DNS name is not resolved before the
check, so a redirect target that resolves internally is a documented residual. Every archive name is either
exactly one pinned relative path or ignored, and every write is built from that pinned path, so a
zip-slip, absolute, drive-letter or backslash entry cannot leave the target directory. All files are
verified before the first write, so a malicious archive leaves no partial install. The installer never runs the
executable, the archive is deleted after the install, and the returned path is re-checked by the supervisor's own validator.

Residual risks: the pin names a nightly build, because the stable llama.cpp tags publish no binary
assets; the digest authenticates that exact archive but there is no code signature yet. The Visual C++
runtime is a separate Microsoft dependency, not covered by the digest. A local process with write
access to the target directory could replace a file after the final hash (the product will own that
directory), and a hard link is indistinguishable from a regular file. The manifest itself is not
signed in this slice, so a caller who can rewrite both the manifest and the files can point the
installer at anything; signing and an authenticated update path belong to the packaging slice. The
recursive `mkdir` runs before the realpath check, so a pre-planted junction could create empty
directories outside the target before the write is refused. The part file is read by path, so a local
writer could swap it before the read; the same buffer is hashed and parsed, so nothing unverified is
installed, but the read is not bound to the file that was hashed.

## Verification

`node --test tests/vibe/sidecar.test.mjs` covers the shipped pin and its 23 files, every rejected
manifest field and path class, accessor and Proxy behaviour, the empty, sized and checksummed install,
the symlink refusal, a complete install against a loopback server and against an injected fetch,
idempotent skip with no request, archive and entry digest/size failures, a missing entry, HTTP status,
insecure redirect, an internal literal final host, a symlinked target or nested parent, ZIP64,
multi-disk, encrypted and unsafe archive names, missing body, stall, total timeout, caller abort, the busy guard, invalid options,
traversal/absolute/backslash/symlink archive entries, duplicate entries, an unsupported method, a
truncated and a non-ZIP archive, an oversized entry, ignored directory and unlisted entries, bounded
errors with no URL/body/injected-text echo and the supervisor executable contract.

The full acceptance uses `node vibe/tools/verify.mjs --strict` and
`node vibe/tools/docs-check.mjs --strict`.

## Next steps

Copy the installed files and `vibe/models/catalog.json` into the packaged application, sign the
manifest, add a third-party notices file covering llama.cpp's MIT text and the LLVM/OpenMP notice, add the
Microsoft VC++ 2015-2022 x64 redistributable to the radar and pin it,
supply the Microsoft VC++ runtime, wire `installSidecar` into the first-run start action and
run one live install/start smoke on a clean Windows machine. Keep the pin current from the radar, and
re-check the seven-day rule and the per-file digests whenever the nightly advances. Before the binary
is bundled into a release, add an ADR (or amend ADR-0010) covering the nightly intake policy, the
signing route, the CPU/GPU backend matrix and the Microsoft runtime pin.
