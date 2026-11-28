# M3 live local-runtime smoke

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-28
>
> The opt-in proof that the shipped local-runtime path works on a real machine, not only against
> mocks: [local-runtime-smoke.mjs](../../../vibe/tools/local-runtime-smoke.mjs), with offline
> acceptance tests in
> [local-runtime-smoke.test.mjs](../../../tests/vibe/local-runtime-smoke.test.mjs). The modules it
> drives are documented in [m3-sidecar-binary.md](m3-sidecar-binary.md),
> [m3-model-downloader.md](m3-model-downloader.md), [m3-llama-server.md](m3-llama-server.md),
> [m3-first-run-wizard.md](m3-first-run-wizard.md) and [m3-local-provider.md](m3-local-provider.md).

## Why it exists

Every M3 acceptance test runs offline: the supervisor test spawns a Node fixture, the downloader and
sidecar tests answer from a local HTTP server, and the provider tests use the fixture. That keeps CI
fast and hermetic, and it also means the shipped artifacts were never exercised on a real machine.
The folder is exactly where a defect can hide: on 2026-11-28 the first live run failed every model
download as `insecure-redirect`, because the downloader rejected the signed query Hugging Face puts
on its CDN redirect (fixed in `assertResponseUrl`, see
[m3-model-downloader.md](m3-model-downloader.md)). The smoke run is the gate that catches that class
of drift again.

## Contract

- **Opt-in only.** It is not part of `node vibe/tools/verify.mjs`: it needs the network, about 1.8 GB
  of free disk and a few minutes. `verify` stays hermetic.
- **Steps, not a blob.** Each step prints one line, `PASS <name> <seconds> <json>` or
  `FAIL <name> <seconds> <json>`, and the last line is `SMOKE_RESULT=PASS|FAIL <seconds>`. A failing
  step marks the run FAIL and aborts the remaining steps, except the two stop steps, which run once a
  server object has been created (in `finally`) and only mark the run FAIL; a failure prints its `code`,
  and the CLI exits 1.
- **Worst step first.** The sidecar install and the chat download happen before the first server
  starts, and the chat server is stopped before the embedding model downloads, so a network problem
  never leaves a stray process behind.
- **Nothing secret in the output.** The generated model key is used for the auth, chat and embedding
  calls but never printed, and the signed CDN URL is neither stored nor logged.
- **Its own directory.** `--dir` must be missing or carry the `.vibecodium-local-smoke` marker this
  tool writes when it creates a directory; an existing unmarked directory is refused even when empty,
  and a symlink, junction or non-directory path is refused, so a mistyped path is never adopted. After
  a PASS the tool removes only its own `runtime`, `models` and marker entries, not the directory tree,
  unless `--keep` is given; a FAIL always keeps them for inspection.
- **Idempotent.** An installed sidecar and a verified model are reused, so a second run takes seconds
  instead of minutes.

## Steps

| Step | Proves |
|---|---|
| `directory` | the working directory is safe to create or reuse |
| `manifest` | `vibe/sidecars.json` parses and this platform has a target |
| `sidecar` | the pinned `b12426` archive installs (or an existing install is adopted) and the installed files match the pin |
| `chat-model` | the chat GGUF downloads from its pin and verifies by size and SHA-256 |
| `server-start` | the supervisor starts the real binary on loopback with the pinned flags |
| `health` | the supervisor's readiness probe reports `ok` and its HTTP `status` |
| `auth` | the supervisor key is enforced: `/props` is 401 without it and 200 with it |
| `chat` | the B1 `llama-cpp` client returns non-empty text |
| `chat-stream` | the streamed answer is non-empty; `sameAsPlain` reports whether its trimmed text equals the plain answer's first 32 characters |
| `tools-request` | a request carrying `tools` is accepted; the observed `toolCalls` count is reported |
| `server-stop` | the supervisor stops the child and clears the port |
| `embedding-model` | the embedding GGUF downloads and verifies |
| `embedding-start` | the `EMBEDDING_SERVER_ARGS` tuple (embedding, pooling, `-c/-b/-ub 8192`) starts |
| `embeddings` | two inputs return two vectors; the first is 1024-dimensional and unit length |
| `embedding-stop` | the embedding server stops |
| `cleanup` | artifacts are removed after a PASS |

`tools-request` reports rather than asserts model quality: the pinned 1.5B model describes the call in
prose (`toolCalls: 0`) while the request shape is accepted. Tool-call quality is a model property, not
a plumbing one, and the offline supervisor test still asserts the parsed `toolCalls` path with the
fixture.

`--chat-only` stops after `server-stop` for a quick chat-level check. `--threads` (1 to 64) and
`--context-size` (128 to 1048576) are bounded by the smoke and validated again by the supervisor,
whose own bounds are wider (1 to 256 threads, 1 to 1048576 context tokens).

## Evidence (2026-11-28, Windows 11 x64, 8 threads, CPU build)

A fresh run against an empty directory, so every artifact came off the network (absolute paths
redacted to `<smoke-dir>`):

```
PASS directory 0.0s {"dir":"<smoke-dir>"}
PASS manifest 0.0s {"sidecarId":"llama-server","version":"b12426","platform":"win32-x64","executable":"llama-server.exe"}
PASS sidecar 1.4s {"verified":true,"installed":true,"version":"b12426","sizeBytes":47796509}
PASS chat-model 121.5s {"verified":true,"downloaded":true,"path":"<smoke-dir>\\models\\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf","sizeBytes":1117320768}
PASS server-start 1.6s {"state":"running","port":56222,"baseUrl":"http://127.0.0.1:56222/v1"}
PASS health 0.0s {"ok":true,"status":200}
PASS auth 0.0s {"withoutKey":401,"withKey":200}
PASS chat 0.1s {"textChars":4,"sample":"pong"}
PASS chat-stream 0.1s {"textChars":4,"sameAsPlain":true}
PASS tools-request 1.0s {"toolCalls":0,"textChars":69}
PASS server-stop 0.1s {"stopped":true,"state":"stopped"}
PASS embedding-model 69.4s {"verified":true,"downloaded":true,"path":"<smoke-dir>\\models\\Qwen3-Embedding-0.6B-Q8_0.gguf","sizeBytes":639150592}
PASS embedding-start 0.8s {"state":"running","port":59306,"baseUrl":"http://127.0.0.1:59306/v1"}
PASS embeddings 0.0s {"vectors":2,"dims":1024,"norm":1}
PASS embedding-stop 0.1s {"stopped":true}
PASS cleanup 0.1s {"removed":true}
SMOKE_RESULT=PASS 196.3s
```

The embedding model produces 1024-dimensional unit vectors, matching the catalog's declared
`Qwen3-Embedding-0.6B-Q8_0` file. Both supervisor instances stopped cleanly and the working directory
was removed.

After the directory and cleanup hardening, a second run in a directory that already held the installed
sidecar and both verified models (`installed:false`, `downloaded:false` on all three) passed in 11.5 s
with no network request, and `cleanup` removed only `runtime`, `models` and the marker file, leaving the
rest of that directory untouched. The transcript above predates that hardening; its step lines and
`SMOKE_RESULT=PASS` are unchanged, and the cleanup line is still `{"removed":true}`.

## Bounds and known limits

- The pinned artifact is the CPU build (`llama-b12426-bin-win-cpu-x64.zip`), so the smoke starts every
  server with `gpuLayers: 0`. A GPU build is M3/M12 packaging work.
- It needs the Microsoft VC++ runtime that `llama-server` links against. That dependency is present on
  this machine but bundling it for a clean machine is parked with the owner (see `docs/vibe/STATUS.md`).
- It is a manual pre-release check, not a CI job: a hosted runner has neither the disk nor the time
  budget, and the pinned downloads are large.
- One model pair is covered. Adding a catalog entry means running the smoke with `--chat-model` or
  `--embedding-model` before the pin is trusted. The `embeddings` step asserts the pinned embedding
  model's 1024 dimensions, so a substitute `--embedding-model` with another width needs that
  assertion updated with the pin.

## Next steps

Run the smoke after any change to the sidecar pin, the catalog, the downloader, the supervisor or the
B1 `llama-cpp` client, and before a milestone exit. Wire its recorded result into the release checklist
when M12 packaging starts.
