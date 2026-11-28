# ADR-0011: Nightly llama.cpp intake for the bundled local runtime

> Doc class: living - Owner: docs-keeper - Last reviewed: 2026-11-27

- Status: accepted
- Date: 2026-11-26

## Context

ADR-0010 makes `llama.cpp` `llama-server` the local runtime the B1 preset talks to, and M3 pins the
upstream build in `vibe/sidecars.json` so the installer can verify it byte for byte
([m3-sidecar-binary.md](../design/m3-sidecar-binary.md)). Stable `v1.x` tags ship release notes and a
`nightly-tag.txt` pointer only; the prebuilt Windows archives this product installs are attached to
the nightly builds (`b<number>`), and the same scheme applies to any other platform added later. A stable "latest release" therefore cannot be pinned as a binary, and the
product still needs a rule for which nightly it accepts.

The delivered pin is nightly `b12426`, published 2026-11-15, 11 days public when it was reviewed, and
its archive is verified by SHA-256 digest and exact byte size. The `v1.0.0` notes point at `b12359` and the `v1.1.0` notes at
`b12774`; the pin follows neither pointer, because `b12359` is older than the delivered build and
`b12774` was published on the review day and is younger than seven days, so the wait and the radar
review decide the pin instead.

## Decision

1. Pin a nightly, never a floating reference. The accepted tag is a `b<digits>` build tag (for
   example `b12426`); a floating reference such as `latest`, a branch name or a short form is
   refused. `vibe/sidecars.json` records the tag, the publication
   date, the licenses, the source and one archive per platform and architecture with its release URL,
   SHA-256 digest, exact byte size and the executable name inside the archive. The review date and the
   seven-day evidence live in the `TECH_RADAR.md` row, not in the manifest. The loader bounds the tag to
   64 characters and format-checks the publication date; the review must refuse the floating forms,
   because the loader does not.
2. Choose a nightly whose publication is at least seven days old at review (the supply-chain rule in
   `ARCHITECTURE.md` principle 9), preferring the build a recent stable release names when one is
   eligible. The seven-day gap is a review-time process control recorded in the radar row and the
   review note; it is not enforced when the manifest loads (the loader only checks the date format), so
   a re-pin without a review would not be caught by the product.
3. Ship CPU builds first (`win32-x64` today), because a CPU build runs
   on every machine the hardware probe can recommend and carries no GPU runtime of its own. A later
   target (for example `win32-arm64`) joins only with its own pin, size and license review, and a GPU
   backend (CUDA, Vulkan, ROCm, SYCL, OpenVINO) likewise needs its own pin and review before it joins
   the manifest.
4. Install only the allowlisted runtime files and their notice. The archive's benchmark tools, extra
   executables and RPC helper are not installed. The Windows CPU archive carries `libomp.dll` and
   `LICENSE-LLVM-OpenMP` (Apache-2.0 with LLVM exception) and no llama.cpp `LICENSE` file, so the
   packaging slice must ship the llama.cpp MIT text from the source tree plus that OpenMP notice.
5. Record the Microsoft Visual C++ 2015-2022 x64 runtime as a separate dependency (the CPU package
   needs `MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`). It is not part of the llama.cpp
   pin, and it is proprietary Microsoft software, not a permissive open-source license: it does not
   satisfy `ARCHITECTURE.md` principle 8 and must not be treated as if it does. Shipping it needs an
   explicit owner decision under `GOVERNANCE.md` section 5, a proposal amending principle 8 under
   `GOVERNANCE.md` section 3 (an owner note alone cannot change a locked doc), a `TECH_RADAR.md` row and
   its own pin in M12; the license review records that decision.
6. Re-pin only at a review, never automatically: a new nightly means a new tag, new digests, a fresh
   seven-day wait and a `TECH_RADAR.md` row update. No in-product self-update of the binary.
7. The gates in `../design/m3-sidecar-binary.md` remain in force before the installer is enabled by
   default or the binary is bundled: an authenticated manifest, or a `source`-to-URL binding plus an
   enforced seven-day rule; an installer-owned directory under the application-data root, never a
   webview-supplied path; and, for multi-process or POSIX use, a cross-process lock and a
   descriptor-bound part-file read. This decision relaxes and defers none of them. The loader-side
   seven-day enforcement and the chosen manifest-authentication route (an authenticated manifest, or the
   binding plus its enforced check) are hardening that must land before either the installer is enabled by
   default or the binary is bundled; the signing route stays owner-parked and the notices file ships. The
   owned-directory capability is now delivered as code (`../design/m3-sidecar-binary.md`,
   `src/stable/runtime/app-data.mjs`): the installer derives and proves `<root>/runtime/<platformKey>/<id>-<version>`
   from an `ownedRoot` and the wizard accepts `sidecar.appDataRoot`; the gate stays open until the wired
   product path supplies that root instead of the legacy `<destinationDir>/runtime` default (M6/M12), and
   the Windows location needs the M12 `ARCHITECTURE.md` section 4 reconciliation.

## Alternatives considered

- **Wait for stable `v1.x` binaries.** Upstream states the point releases intentionally carry no
   binaries, so this is open-ended; the product would have no local runtime until upstream changes the
   policy.
- **Build llama.cpp from source during the product build.** Moves trust from a digest to our build
   farm, adds a CMake/MSVC toolchain to every build, and produces an unsigned artefact with no upstream
   provenance. Rejected for the first bundle; a later reproducible-build slice could revisit it.
- **Rely on an installed Ollama daemon only.** Already supported as an optional endpoint and kept, but
   it cannot be the product-controlled runtime: the product cannot choose the port, verify the model or
   own the lifecycle.
- **Pin a current nightly without the wait.** Refused: it would break the seven-day rule and the
   digest has no review window.

## Consequences

- The product can verify and install a local runtime today without a bundler, and the intake rule is
   data plus a documented review, not a build-time guess.
- Residual risks accepted: the tag is an upstream prerelease build with no upstream code signature
   (the review-time digest and the reviewed manifest are the current trust anchor, and the manifest is
   not authenticated until the authenticated-manifest gate lands), and the extracted
   directory must be product-owned because a local writer could replace the binary after adoption.
- The ADR does not approve a binary version; `vibe/sidecars.json` and `TECH_RADAR.md` do. The next
   review is 2026-12-03, when the `v1.1.0` build (`b12774`) becomes eligible if its digests verify; the
   review must also confirm that the radar row still carries the seven-day evidence, because the loader
   does not check it.
- The signing route, the manifest-authentication route, the Microsoft runtime pin, the host wiring that
   supplies the installer-owned application-data root and the cross-process lock with its
   descriptor-bound part-file read remain open M3/M12 work, with the signing route parked for the owner.
   The notices file ships.
