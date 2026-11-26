# M3 third-party notices

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-26

>
> Keeps the third-party notices for the pinned runtime components honest. The generator lives in
> [third-party-notices.mjs](../../../src/stable/runtime/third-party-notices.mjs), the ledger in
> [notices.json](../../../vibe/notices.json), the CLI in [notices.mjs](../../../vibe/tools/notices.mjs),
> the generated document in [THIRD-PARTY-NOTICES.md](../legal/THIRD-PARTY-NOTICES.md) and the
> acceptance test in [third-party-notices.test.mjs](../../../tests/vibe/third-party-notices.test.mjs).
> It covers the pins of [m3-sidecar-binary.md](m3-sidecar-binary.md) and
> [m3-model-downloader.md](m3-model-downloader.md).

## Scope

This is M3's licensing slice. It records which licenses the pinned runtime components carry, keeps
the verbatim upstream license texts in the repository, and generates one notice document from those
inputs. The generator fails closed when a pinned component's license has no ledger entry, when a text
no longer matches its pinned digest, or when the checked-in document differs from the generator
output, so a new pin cannot silently ship without a notice.

Out of scope: copying the installed files or the catalog into a packaged application, signing the
manifest, installing the Microsoft VC++ runtime, the installer and portable zip notices placement
(M12 packaging), any new dependency (Node built-ins only), any network access at test time, and any
change to the pin, the installer, the downloader or the supervisor.

## The ledger

`vibe/notices.json` is the pinned ledger: a version, the date the texts were last reviewed, and one
entry per license with its identifier, display name, upstream URL, the repository path of the
verbatim text and the SHA-256 of that text. Paths are relative POSIX paths that must sit directly
under `vibe/licenses/`, and URLs must be absolute HTTPS URLs without credentials. The ledger is read
through own data descriptors: an accessor is rejected without being invoked, a revoked or
trap-throwing Proxy is rejected, an unknown or reserved key fails, identifiers must be lowercase,
duplicates are refused and a digest must be lowercase hex.

## The texts

The three texts shipped on 2026-11-26 are the upstream bytes, unchanged:

| File | Bytes | SHA-256 | Upstream |
|---|---|---|---|
| `vibe/licenses/mit.txt` | 1078 | `94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d` | `ggml-org/llama.cpp` `b12426` `LICENSE` |
| `vibe/licenses/apache-2.0.txt` | 11358 | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` | `https://www.apache.org/licenses/LICENSE-2.0.txt` |
| `vibe/licenses/apache-2.0-with-llvm-exception.txt` | 19741 | `fdad1758a9e1f9d5a81e18879b3406772115edc92c24bfa36b70c654f325e8e4` | `LICENSE-LLVM-OpenMP` in the pinned archive |

The LLVM/OpenMP text was extracted from the pinned archive
`llama-b12426-bin-win-cpu-x64.zip` (25,209,516 bytes, SHA-256
`61145645c26cf8d7b3ed76435812192ae42f51c4c51e895936adc61dc1eb0410`, re-downloaded and matched on
2026-11-26) and its digest equals the pin's `LICENSE-LLVM-OpenMP` file digest, so the notice text is
the exact file the installer places on disk. All three texts are ASCII, LF-terminated, free of
trailing whitespace and tabs, and are never reformatted: the digest is computed over the
LF-normalized text, exactly like `hashFile` in the repository tools.

## What the notice covers

The components come from the two shipped pins, never from a hand-written list:
`vibe/sidecars.json` contributes each sidecar as a `binary` component with its version, source and
license identifiers, and `vibe/models/catalog.json` contributes each model as a `model` component
with its abbreviated pinned revision, repository and license. Components are sorted by name, a
duplicate name fails, and a component must carry at least one license. The current notice covers
`llama-server` (`b12426`, MIT plus Apache-2.0 WITH LLVM-exception) and the two Apache-2.0 Qwen GGUF
models.

## The document

`docs/vibe/legal/THIRD-PARTY-NOTICES.md` is generated and declares `Doc class: generated` with
`docs-keeper` as owner. It contains the component table, then every used license with its
identifier, upstream URL, repository text path, digest and the verbatim text in a fenced block.
Rendering is deterministic: order comes from the sorted components and the sorted license ids, and
the header date comes from the ledger, so the same inputs always produce byte-identical output.
`node vibe/tools/notices.mjs --write` regenerates it; `verify` runs the check mode, which fails when
the document is missing or stale.

## Verification

`node --test tests/vibe/third-party-notices.test.mjs` covers the shipped ledger and its coverage of
every pinned license, the digest cross-check against the sidecar pin, the component projection, the
rendered document and its determinism, every rejected ledger field (Proxy, accessor, unknown and
reserved key, duplicate or malformed identifier, non-HTTPS or credential-bearing URL, absolute or
traversing text path, missing and malformed digest, invalid and future review date, too many
entries), a missing and a mismatched license text, an empty or oversized body, a malformed component
list, table escaping, and the CLI in check and `--write` modes against a temporary root.

The full acceptance uses `node vibe/tools/verify.mjs --strict`, which now runs the notices check as
its own step, and `node vibe/tools/docs-check.mjs --strict`.

## Next steps

Place the generated notice beside the installed runtime and the installed application at packaging
time (M12), add the Microsoft VC++ 2015-2022 x64 redistributable row and its notice when that runtime
is pinned, and regenerate the document whenever a pin or a model changes. A later packaging slice
must also decide whether the model licenses travel with the downloaded files or only with the
document.
