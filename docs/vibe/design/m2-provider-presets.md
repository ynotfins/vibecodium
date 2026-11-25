# M2 B1 provider presets and request client

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-24
>
> The dependency-free provider catalog and request client that M2 builds on. The catalog lives in
> [provider-presets.mjs](../../../src/stable/gateway/provider-presets.mjs), the client in
> [provider-client.mjs](../../../src/stable/gateway/provider-client.mjs), and the acceptance tests
> in [provider-presets.test.mjs](../../../tests/vibe/provider-presets.test.mjs) and
> [provider-client.test.mjs](../../../tests/vibe/provider-client.test.mjs).

## Scope

This slice delivers the data-driven provider layer only. It does not start Bifrost, supervise a
sidecar, choose a fallback or budget policy, call a live provider, or add the point-and-click
provider UI. Those remain B2/B3/B5/B6 and M3/M6 work.

## Catalog

`PROVIDER_PRESETS` is a frozen, ordered list with one entry per B1 provider. Each entry carries an
id, a human label, one of two transports (`openai-chat` or `openai-responses`), a base URL or a
base-URL environment-variable name, an auth mode (`bearer` or `none`), an optional API-key
environment-variable name, an `apiKeyRequired` flag, a frozen capability list and a `local` flag.

| id | transport | endpoint | credential | default model | capabilities |
|---|---|---|---|---|---|
| `omniroute` | `openai-chat` | `OMNIROUTE_BASE_URL` | `OMNIROUTE_API_KEY` (optional) | none | chat, stream, tools, embeddings |
| `morph` | `openai-chat` | `https://api.morphllm.com/v1` | `MORPH_API_KEY` | none | chat, stream, tools, embeddings |
| `kie` | `openai-responses` | `https://api.kie.ai/codex/v1` | `KIE_API_KEY` | `gpt-6-1-sol` | chat, stream, tools |
| `deepinfra` | `openai-chat` | `https://api.deepinfra.com/v1/openai` | `DEEPINFRA_API_KEY` | none | chat, stream, tools, embeddings |
| `abliteration` | `openai-chat` | `https://api.abliteration.ai/v1` | `ABLITERATION_API_KEY` | `abliterated-model-large-v2` | chat, stream, tools, embeddings |
| `openrouter` | `openai-chat` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | none | chat, stream, tools, embeddings |
| `requesty` | `openai-chat` | `https://router.requesty.ai/v1` | `REQUESTY_API_KEY` | none | chat, stream, tools, embeddings |
| `openai-compatible` | `openai-chat` | `OPENAI_COMPATIBLE_BASE_URL` | `OPENAI_COMPATIBLE_API_KEY` (optional) | none | chat, stream, tools, embeddings |
| `llama-cpp` | `openai-chat` | `http://127.0.0.1:8080/v1` | none | none | chat, stream, tools, embeddings |
| `ollama` | `openai-chat` | `http://127.0.0.1:11434/v1` | none | none | chat, stream, tools, embeddings |

Built-in presets are normalized through the same validator as custom ones, so a built-in cannot
carry an unvalidated URL, auth mode, capability, environment-variable name or model. A provider
that requires a key must name the environment variable that holds it; a local preset defaults to
no key requirement.

## Settings JSON

A provider can be added, or a built-in overridden, from a settings object alone:

```json
{
   "providers": {
      "my-lab": {
      "label": "My Lab",
      "transport": "openai-chat",
      "baseUrl": "http://127.0.0.1:9999/v1",
      "model": "lab-model",
      "auth": "none",
      "capabilities": ["chat", "stream", "tools"]
      }
   }
}
```

Settings are read once through own data descriptors. Unknown keys, reserved keys, accessors,
prototype pollution, malformed ids, transports, auth modes, capabilities, URLs, environment names,
labels and models fail closed with a `ProviderPresetError` code. A built-in override merges onto
the built-in entry; a custom entry must supply a label and a base URL or base-URL variable.

## Request client

`createProviderClient(id, options)` resolves the preset, reads the base URL and credential from the
caller's environment object (or `process.env`), validates the model and limits, and returns a
frozen client with `chat`, `embeddings`, `config` and `describe`. The credential is read once and
never appears in `config`, `describe()`, an error or a serialized client.

Both transports are implemented:

- `openai-chat` posts to `/chat/completions` and `/embeddings`.
- `openai-responses` posts to `/responses` and converts messages and function tools to the
   Responses input shape.

Non-streaming replies return assembled text, normalized tool calls and normalized usage. Streaming
replies parse SSE incrementally, assemble text deltas and tool-argument deltas by index, bound the
number of events, the event size and the total bytes, and never buffer an unbounded response.
Embeddings are refused when the transport does not expose them or the preset does not advertise
the `embeddings` capability. HTTP errors expose only the
status; the response body is never included in an error.

## Endpoint policy

Every request calls the M1 `assertAIEndpointAllowed()` before `fetch`. Loopback and other local
model servers are allowed by default. A remote preset is denied by default and can be enabled by
an exact `allowHosts` entry, an `allowEndpoints` host+path entry, or by `allowExternalProviders`.

`allowExternalProviders` is scoped by the client to the host the caller actually configured: the
client adds that host to a per-client `allowHosts` list, so the switch cannot reach an arbitrary
unknown host. Metadata and other hard-denied endpoints are still rejected before any host allow is
consulted. The M1 inventory enumerates the OpenAI and ChatGPT external hosts only, so other
third-party hosts are classified `unknown` and need an explicit host/endpoint allow or the scoped
external-provider opt-in; the `allowUnknownHosts` switch also works but is intentionally not used
by the client.

## Verification

`node --test tests/vibe/provider-presets.test.mjs tests/vibe/provider-client.test.mjs` runs a local
HTTP mock server for both transports and covers, for every preset and for a settings-only custom
provider: non-streaming chat, streaming text, streamed tool calls, non-streaming tool calls, and
embeddings where advertised. It also covers the frozen catalog, settings overrides, accessor and
prototype hardening, endpoint denial and the two opt-in paths, secret non-exposure, HTTP error
body suppression, response-size limits and malformed input.

The `docs/vibe` suite, `node vibe/tools/verify.mjs --strict` and
`node vibe/tools/docs-check.mjs --strict` are the remaining acceptance commands.
