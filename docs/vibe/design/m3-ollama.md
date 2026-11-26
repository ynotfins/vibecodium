# M3 local Ollama discovery

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-26
>
> The read-only discovery of an already running local Ollama daemon. The module lives in
> [ollama.mjs](../../../src/stable/runtime/ollama.mjs) and the acceptance tests in
> [ollama.test.mjs](../../../tests/vibe/ollama.test.mjs). It feeds the B1 `ollama` provider preset
> ([m2-provider-presets.md](m2-provider-presets.md)) and sits beside the llama.cpp supervisor
> ([m3-llama-server.md](m3-llama-server.md)), the model downloader
> ([m3-model-downloader.md](m3-model-downloader.md)) and the first-run wizard
> ([m3-first-run-wizard.md](m3-first-run-wizard.md)).

## Scope

This slice is M3's fifth runtime slice: find a local Ollama daemon that the user already runs, report
which models it can serve, pick a local chat model and an optional local embedding model, and hand the
caller the two exact overrides the B1 `ollama` preset takes (`baseUrl`, `model`). It never starts,
installs, stops or updates Ollama, never pulls a model, and never writes a file. Node built-ins only.

Out of scope: wiring the result into the provider setup panel (M2), the `/api/embeddings` endpoint,
the Responses transport, capability discovery beyond the name/family heuristic, starting or
supervising Ollama, the llama.cpp binary bundle, restart/back-off and any dependency change.

## Live facts (verified 2026-11-26)

Sources: <https://docs.ollama.com/api/tags> and <https://docs.ollama.com/api/openai-compatibility>.

- The local server listens on `http://localhost:11434` by default. The OpenAI-compatible base URL is
   `http://localhost:11434/v1/`.
- `GET /api/tags` returns `{ models: [ ... ] }`. No summary property is required by the schema; a
   summary may carry `name`, `model`, an optional remote_model and remote_host for a cloud model,
   `modified_at`, `size` (bytes), `digest`, and a `details` object with `format`, `family`,
   `families`, `parameter_size` and `quantization_level`. The projection therefore treats `size`,
   `details` and the metadata fields as optional.
- The OpenAI-compatible endpoints support `/v1/chat/completions` (chat, streaming, tools),
   `/v1/embeddings` (string or string array input) and `/v1/models`. `tool_choice` is not in the
   supported-field list for `/v1/chat/completions`.
- The local server ignores the API key an OpenAI client requires; a raw HTTP request needs no
   credential at all, which is why the discovery request sends none.

## The probe

`discoverOllama({ port?, timeoutMs?, maxResponseBytes?, fetch?, evaluate? })` validates its options through own
data descriptors and then makes at most one request (none when the M1 policy denies it).

| Option | Default | Bounds |
|---|---|---|
| `port` | 11434 | 1024-65535, integer |
| `timeoutMs` | 1500 | 100-10000 |
| `maxResponseBytes` | 262144 (256 KiB) | 1024-4194304 |
| `fetch` | `globalThis.fetch` | must be a function |
| `evaluate` | the M1 policy core | must be a function; trusted test/caller seam |

The request is `GET http://127.0.0.1:<port>/api/tags` with `accept: application/json`,
`redirect: 'error'`, `credentials: 'omit'`, `cache: 'no-store'` and an abort signal. The URL is built
from the fixed loopback host and the validated port, so no caller-supplied host or path can turn the
probe into a general-purpose request. The endpoint is evaluated by the M1 policy core
(`evaluateAIEndpointRequest`, the default `evaluate`) before the request; a denial, a missing
decision or a throwing evaluator returns `policy-denied` without a request. The `evaluate` option is a
trusted caller/test seam in the same class as `fetch`: the product leaves it unset.

One deadline covers the request and the body read. A fetch implementation that ignores the abort
signal cannot hang the caller: the probe races the work against its own deadline and returns
`timeout`. The body is read through a byte cap; crossing the cap cancels the stream and reports
`invalid-response`. A Response-like object without a body stream is read with `text()` and checked
against the same cap afterwards; only a caller-injected `fetch` may return one, so the product fetch
path always reads a stream.

A present `content-type` must be `application/json` or `application/json;...` (case-insensitive);
any other value is `invalid-response`, while a missing header is tolerated and the body must still
parse as JSON. A stream chunk that is not bytes fails the answer as `invalid-response`. A non-200
status or a non-JSON content type fails before the body is read.

## The result

A frozen object with the following fields.

| Field | Meaning |
|---|---|
| `version` | Module contract version (1). |
| `available` | `true` when a daemon answered with a valid list. |
| `reason` | `null`, or `unreachable`, `timeout`, `http-error`, `invalid-response`, `policy-denied`. |
| `status` | HTTP status for a valid answer or `http-error`; otherwise `null`. |
| `port` | The probed port. |
| `baseUrl` | `http://127.0.0.1:<port>/v1` when available, otherwise `null`. |
| `models` | Frozen, name-sorted projected models (may be empty). |
| `chatModel` | The selected local chat model id, or `null`. |
| `embeddingModel` | The selected local embedding model id, or `null`. |
| `notices` | Frozen, ordered codes. |

Discovery failures are values, not exceptions: a refused connection, a non-200 answer, a non-JSON
body or content type, an oversized body, a stalled body, a malformed list and a policy denial all
return `available: false` with one bounded notice and never echo the URL, the body or an error
message. Only malformed *options* throw (`OllamaError` with `invalid-options`).

Notices: `ollama-unreachable`, `ollama-timeout`, `ollama-http-error`, `ollama-invalid-response`,
`ollama-policy-denied`, `ollama-no-models`, `ollama-no-chat-model`, `ollama-no-embedding-model`,
`ollama-remote-models`. A refused redirect surfaces as `unreachable` because `redirect: 'error'`
rejects the request before any answer arrives; it is never followed.

An empty list is still `available: true` and carries `ollama-no-models`; a daemon that has no local
chat or embedding model is reported through `ollama-no-chat-model` or `ollama-no-embedding-model`,
not as a failure.

## Model projection

Each entry in `models` is read through own data descriptors, so an accessor is refused rather than
invoked. Unknown per-entry fields (for example `modified_at`, `digest`, `details.format`) are
ignored, which keeps the projection forward-compatible with new Ollama fields; a field the projection
needs but cannot validate fails the whole answer closed. A projected model is exactly:

| Field | Rule |
|---|---|
| `id` | `name` (or `model` when `name` is absent), 1-200 characters from a strict subset of the class the provider preset accepts (`A-Z a-z 0-9 . _ : / @ + -`, with an alphanumeric first character), no control, format or bidi characters, well-formed Unicode. |
| `sizeBytes` | Optional integer 0-`Number.MAX_SAFE_INTEGER`, otherwise `null`. |
| `parameterSize` | Optional `details.parameter_size`, at most 64 characters. |
| `quantization` | Optional `details.quantization_level`, at most 64 characters. |
| `family` | Optional `details.family`, at most 64 characters. |
| `embedding` | `true` when a family or `families` entry contains `bert`, or when the id contains `embed` (case-insensitive). |
| `remote` | `true` when `remote_model` or `remote_host` is non-null, or the id ends with `:cloud` (case-insensitive). |

A null or absent `size`, `family`, `families`, `parameter_size` or `quantization_level` is treated
as absent, reported as `null` (or an empty `families` list). `families` is bounded to 16 entries of
at most 64 characters. The list is capped at 256 models; a larger answer is `invalid-response` rather
than silently truncated.

The models are sorted by id. `chatModel` is the largest non-remote, non-embedding model and
`embeddingModel` the largest non-remote embedding model; a size tie breaks by id. A cloud/remote model
is listed but never selected, so a product flow cannot silently send a prompt to a hosted model when
the user asked for local inference.

The embedding flag is a heuristic. Ollama does not expose capability flags on `/api/tags`, so a model
whose family is not `bert`-like and whose name does not contain `embed` is treated as a chat model.
The caller can always pass an explicit model to `toOllamaProviderOptions`, which is validated against
the same list.

## Provider options

`toOllamaProviderOptions(result, { model? })` validates the discovery result (including its version,
base URL shape, port and model list) and returns exactly `{ baseUrl, model }`, the two overrides
`resolveProviderConfig('ollama', ...)` accepts.

- Without `model`, the discovered `chatModel` is used; a daemon without one fails as
   `ollama-no-chat-model`.
- The result is re-validated: `version` must match, the base URL must be the loopback `/v1` URL for
   the stated port, and `chatModel`/`embeddingModel` must each appear in `models` with the matching
   `remote: false` and `embedding` flag, so a forged or stale result cannot name a cloud or
   embedding-only default.
- An explicit `model` must be an installed, non-remote, non-embedding model of the result, otherwise
   `unknown-model`.
- An unavailable result fails as `ollama-unavailable`; a malformed result fails as `invalid-result`.
- Options and result are read through own data descriptors; a hostile or revoked Proxy, an accessor, an unknown key or a
   non-boolean `available` fails closed.

The B1 `ollama` preset is unchanged: `openai-chat` transport, `http://127.0.0.1:11434/v1` default,
`auth: 'none'`, no required key and all four capabilities. The acceptance test drives that preset
through the discovered base URL against the same loopback mock server for plain chat, SSE streaming,
tool calls (plain and streamed) and embeddings, and asserts that no request carries an authorization
header.

## Security boundary

- The probe is loopback-only and read-only; the host cannot be overridden and the path is fixed.
- No credential is read, sent or stored. The daemon is never started, so no process
   environment, port reservation or binary trust is involved.
- The response is untrusted input: bounded read, a JSON body (a present `content-type` must be
   `application/json` or `application/json;...`), own-descriptor reads, a strict model-name
   class, bounded metadata, control/bidi rejection, a model cap and no echo of the body or the URL.
- The M1 endpoint policy is consulted before the request, so a future policy that denies local model
   servers fails the probe closed instead of bypassing the decision core.
- The bounded metadata (`family`, `families`, `parameterSize`, `quantization`) is untrusted display
   text. A UI must render it as text or tag it as untrusted before it reaches HTML or an agent
   prompt; this slice never interpolates it into markup.

Residual risks, accepted and documented:

1. Any loopback service that answers `/api/tags` with a valid shape is treated as Ollama. The effect
   is limited to the names and base URL the caller then offers to the same loopback endpoint; no
   secret is sent and no file is written.
2. The embedding flag is a heuristic (see above) and can misclassify an unlabelled model.
3. A hostile daemon can advertise a model name that fails later at call time; the
   provider client then reports a bounded provider error.
4. Ollama's compatibility table does not list `tool_choice`, while the B1 client sends
   `tool_choice: 'auto'` when tools are present. The mock proves the client/preset contract, not
   Ollama's tolerance; a live smoke on a machine with Ollama is the follow-up that settles it.
5. The daemon can change between discovery and use (a model removed, the port changed). The caller
   should re-run discovery on failure; the module keeps no cache.
6. Cloud models are listed with `remote: true` so a UI can label them, but a UI that ignores the flag
   could offer a hosted model; selection never picks one.

## Acceptance

`node --test tests/vibe/ollama.test.mjs` covers the successful projection and selection, the size
tie-break, empty, chat-less and embedding-only daemons, null optional metadata, a `model`-only entry
with unknown fields ignored, a refused connection, a non-200 answer, a non-JSON body, a non-JSON
content type, a control/bidi/out-of-class name, malformed lists and entries, the 256-model cap, the
byte cap at its boundary and over it, a body-less injected response read through `text()` and its
cap, a non-bytes body chunk, a stalled body, a fetch that ignores the abort signal, redirects not
followed, malformed options (including a host or URL override and a non-function `evaluate`) with a
never-invoked accessor, the M1 policy seam (a denial, a missing decision and a throwing evaluator
return `policy-denied` with no request, and an allowed decision proceeds), the provider-option
helper (default, explicit, unavailable, unknown, remote, embedding, accessor and forged-default
cases), the display summary (`validateOllamaResult`) for available, unavailable, forged,
absent-default-model, unknown-notice, non-loopback and accessor/Proxy results, determinism and the
absence of retained daemon fields, and the real B1 `ollama` preset
serving chat, streaming, tool calls and embeddings from the discovered base URL without an
authorization header.

## Follow-ups

- The first-run wizard now calls `discoverOllama` once per refresh and can select the daemon as the
   local runtime; it consumes `validateOllamaResult`, which normalizes an available or unavailable
   result into a frozen summary (port, loopback base URL, chat and embedding model, model count,
   notices) for display. Offering the daemon in the M2 provider setup panel remains M2 work.
- Live smoke on a machine with Ollama, including the `tool_choice` question and one embedding model.
- Use `POST /api/show` (one request per model, a `capabilities` array that includes `embedding` and
   `tools`, `omitempty` so absence means unknown) to replace the embedding heuristic once a live
   smoke confirms it and its larger answer can be bounded.
- The llama.cpp binary pin may later reuse the same discovery/report shape for its own local server.
