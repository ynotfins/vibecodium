# M2 B1 live provider smoke

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-28
>
> The opt-in proof that the shipped B1 provider path works against the real endpoints, not only
> against mocks: [provider-smoke.mjs](../../../vibe/tools/provider-smoke.mjs), with offline
> acceptance tests in [provider-smoke.test.mjs](../../../tests/vibe/provider-smoke.test.mjs). The
> modules it drives are documented in [m2-provider-presets.md](m2-provider-presets.md),
> [m2-provider-fallback.md](m2-provider-fallback.md) and
> [m2-morph-hosted-models.md](m2-morph-hosted-models.md).

## Why it exists

Every B1, B2 and B6 acceptance test runs offline: the client, presets and fallback tests answer from
a local mock server, so CI stays hermetic and fast, and the shipped request path was never asked a
real provider. That gap hid two live defects until this slice's first run on 2026-11-28:

- **DeepInfra sends `tool_calls: null`.** `zai-org/GLM-5.3` returns `tool_calls: null` on a plain
  chat message and on every streamed delta. The client treated a present-but-null field as a
  malformed tool call and failed every chat and stream turn as `invalid-response`; the mocks had
  only ever used an absent field or an array. `parseChatResponse` and `parseChatStream` now treat
  `null` as absent (see
  [provider-client.mjs](../../../src/stable/gateway/provider-client.mjs)), and the live smoke
  passed on both transports after the fix.
- **Morph retired its embedding and rerank models.** `POST https://api.morphllm.com/v1/embeddings`
  answers `404 model_not_found` and names `morph-embedding-v4` and `morph-rerank-v4` as retired, so
  the `morph` preset no longer advertises `embeddings` (see
  [m2-provider-presets.md](m2-provider-presets.md)).

A third observation shaped the tool rather than the product: Morph's reasoning model spends its
whole budget in `reasoning_content` when `max_tokens` is tiny, so a trivial cap yields empty text
with `finish_reason: length`. DeepInfra's GLM-5.3 did the same at 256 tokens on 2026-11-28 (empty
answer after 29.9 s), so the cap is 1024 and an empty answer reports `finish_reason`, the output
token count and the total tokens in its own message. That separates a truncated reasoning trace
from a provider defect instead of leaving an undiagnosable `empty-chat`.

## Contract

- **Opt-in only.** The script is not part of `node vibe/tools/verify.mjs` (only its offline tests
  are): it needs the network and a provider key in the environment, and it spends a few hundred
  tokens on an account the caller already has. `verify` stays hermetic.
- **Presence, not value.** A provider whose required key environment variable is unset is reported as SKIP
  with the variable's name and never as a failure; a value is never read into the report. The
  client's own base-URL and model resolution is used unchanged.
- **A validated endpoint, never a credential channel.** The base URL is validated with the preset
  module's `validateProviderBaseUrl` before it is used or described, so a URL carrying userinfo, a
  query, a fragment or unsafe characters fails `<id>:config` as `invalid-base-url` without printing
  or storing the value. A validated URL can still carry a tenant token in its path, so the report
  and the printed line carry only the hostname. The endpoint policy is an exact `allowHosts` allow
  derived from that hostname (`smokePolicyFor`; the policy core matches hostnames, never ports),
  which is the gate the product requires for a remote provider; the smoke does not switch on the
  whole external-provider category.
- **Steps, not a blob.** Each step prints one line, `PASS <name> <seconds> <json>`,
  `FAIL <name> <seconds> <json>` or `SKIP <name> 0.0s <json>`, then
  `providers ran=N skipped=N failed=N; steps failed=N` and the last line
  `SMOKE_RESULT=PASS|FAIL|SKIP <seconds>`. The CLI exits 1 only on FAIL, so a machine with no keys
  neither passes nor fails the run.
- **Redaction.** The redactor is seeded from every resolved key of the selected presets, and every
  printed line - including a provider error message - passes through it, so a provider that echoes
  a key cannot print it. No request header, body or key is stored. An argument error names the flag
  only when it is flag-shaped and never echoes an arbitrary argument value, because a value on the
  command line can itself be a URL with a credential.
- **Bounded.** Per-request timeout defaults to 90 s and is validated to 1-120 s (an out-of-range
  value is `invalid-argument`); `maxTokens` is
  `SMOKE_MAX_TOKENS = 1024`, because a reasoning row can spend a tighter cap before answering; the
  printed sample is one short trimmed line with control, C1, format, line/paragraph-separator and
  bidi characters stripped, and `finish_reason` is stripped the same way and capped at 32
  characters before it reaches a message or the report.
- **Local presets excluded.** `SMOKE_PROVIDERS` is the B1 presets minus `local: true`; the two
  local presets are covered by `vibe/tools/local-runtime-smoke.mjs` and the first-run wizard tests.

## Steps

| Step | Proves |
|---|---|
| `<id>:config` | the preset resolves its key, base URL and model; a base URL that fails validation fails the step as `invalid-base-url` without being printed, and the report carries only the model and the hostname |
| `<id>:chat` | a plain chat turn returns non-empty text through the `openai-chat` or `openai-responses` transport |
| `<id>:stream` | the same turn streamed returns non-empty text; `sameAsPlain` reports whether the sample matches the plain answer's |
| `<id>:tools` | a request carrying one tool definition returns either a parsed tool call or text, and reports the call count and `finishReason` |
| `<id>:client` | appears only on failure: a client that cannot be constructed fails the provider and counts as a failed step |
| `<id>:embeddings` | runs when `--embedding-model <provider>=<id>` is given, and fails `unsupported-embeddings` when the preset does not advertise the capability; asserts one vector per input, a positive integer dimension and finite values, and reports the dimension and the first vector's norm (reported, not asserted) |
| `fallback` | runs when the Morph provider passed: an ordered chain with a stopped OmniRoute endpoint (`http://127.0.0.1:1/v1`) first and live Morph second answers in the same turn from `servedBy.id === 'morph'` with `fallback: true` and the stopped primary recorded as the failed first attempt |

A failed `chat` skips `stream` and `tools` for that provider, because both reuse the same client.
`embeddings` is independent: it still runs when only the chat turn failed.

## Flags

| Flag | Meaning |
|---|---|
| `--provider <id>[,<id>]` | the B1 external providers to smoke (default: all of them); a repeated id is refused |
| `--model <provider>=<id>` | the model to use for that provider, overriding the preset's default |
| `--embedding-model <provider>=<id>` | names the embedding model; the step runs only for a named provider |
| `--timeout-ms <n>` | per-request timeout, 1000-120000 (default: 90000) |
| `--no-embeddings` | skips every embeddings step even when a model is named |
| `--help` | prints the usage and makes no request |

## Recorded live run

`node vibe/tools/provider-smoke.mjs --provider morph,deepinfra --model deepinfra=zai-org/GLM-5.3 --embedding-model deepinfra=BAAI/bge-m3`
passed on Windows x64 on 2026-11-28 in 11.7 s: `morph` chat/stream/tools on `morph-dsv41flash`
(52 and 57 total tokens plus a tool-call turn), `deepinfra` chat/stream/tools on `zai-org/GLM-5.3` and embeddings on
`BAAI/bge-m3` (2 vectors, 1024 dimensions, unit norm), and the fallback step answering on Morph
with `network-error` on the stopped OmniRoute attempt. That re-run followed the cap change: the
per-provider `chat` detail now also reports `finishReason`, and the earlier empty DeepInfra answer
did not recur. The run spends a few hundred tokens; the
keys, the endpoint values and the request bodies appear nowhere in the output: the config lines
carry `api.morphllm.com` and `api.deepinfra.com` and nothing else from the endpoint.

## Boundaries

- The smoke proves the request path and the provider contract on the machine it runs on; it does
  not prove model quality. `tools` accepts a text answer, because a provider may decline a tool.
- It does not start Bifrost, choose providers by task class, exercise budgets or the provider UI,
  and it does not run the Morph direct policy's `embed` class. Morph no longer offers an embedding
  model at all, and the policy still names the `morph` provider for every class, so reaching an
  embedding service needs a policy change (recorded follow-up, not part of this slice).
- No required key means SKIP; a green run therefore requires a machine with at least one configured key.
