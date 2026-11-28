# M2 B6 Router difficulty adapter

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-28
>
> The bounded adapter around the direct provider's Router. It lives in
> [morph-router.mjs](../../../src/stable/gateway/morph-router.mjs), and its acceptance tests live in
> [morph-router.test.mjs](../../../tests/vibe/morph-router.test.mjs).

## Scope

B6 lists the Router ("prompt difficulty -> model tier") among the direct provider's features. This
slice supplies a dependency-free adapter that asks the Router to classify one prompt and returns
one of three model tiers, so B3 can choose a cheap, standard or powerful route from the prompt's
difficulty instead of from its length. It constructs no B1 client and stores no model list: a tier
is an abstract label (`cheap`, `standard`, `powerful`) and the caller maps it to a provider and
model in its own routing policy.

This slice does not add the `/v1/router/multimodel` endpoint, the legacy `/v1/router/{raw,provider}`
endpoints, model selection, the hosted model rows, the approval-gated abliterated model, Bifrost
supervision, live smoke tests, streaming, caching, retries beyond the single fallback result, or any
dependency. The direct provider's Fast Apply, WarpGrep and Compact features are already delivered
in their own modules and are unchanged.

## Live contract (read 2026-11-26)

Source: `https://docs.morphllm.com/llms.txt` (the Router section), base URL
`https://api.morphllm.com/v1`, Bearer auth with the same key as Apply, Compact and WarpGrep.

| Item | Value |
|---|---|
| Endpoint | `POST /v1/router/classify` |
| Request | `{ "input": "<prompt>", "classes": ["difficulty"] }`; `classes` is optional and also offers `ambiguity` and `domain` |
| Answer | `{ "classifications": { "difficulty": { "label": "easy"|"medium"|"hard", "confidence": 0..1, "meets_threshold": true|false } } }` |
| Timing | about 180 ms per classify; the documented price is $0.005 per request |
| Labels | `difficulty` is `easy`, `medium` or `hard`; the provider says to treat a below-threshold answer as `needs_info` |
| Other endpoints | `POST /v1/router/multimodel` returns one model from a caller policy; legacy `POST /v1/router/raw` returns a difficulty label; `POST /v1/router/{openai,anthropic,gemini}` is deprecated |

The adapter sends only `classes: ['difficulty']` because B6 asks for difficulty, and leaves the
model choice to B3.

## Contract

```js
const router = createMorphRouter({ apiKey: process.env.MORPH_API_KEY, policy: { allowExternalProviders: true } });
const decision = await router.classify('Add error handling to this function');
// { tier: 'cheap', difficulty: 'easy', confidence: 0.93, meetsThreshold: true,
//   needsInfo: false, fallback: false, code: null, status: null }
```

The direct-provider host is denied by default, so a caller opts in with `allowExternalProviders:
true` (scoped to the configured host) or an explicit `allowHosts: ['api.morphllm.com']`; the
example shows the first form. Without one of them `classify()` throws the M1 policy error and makes
no request.

Options are validated once through own data descriptors:

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://api.morphllm.com/v1` | Direct-provider API root; must be `https`, or `http` only on a loopback host, with no credentials, query or fragment |
| `apiKey` | - | Explicit Morph API key; never returned, serialized or logged |
| `apiKeyEnv` | `MORPH_API_KEY` | Environment variable read only when `apiKey` is absent; only `MORPH_API_KEY` is accepted, so pass `apiKey` for any other source |
| `env` | `process.env` | Environment object (a test seam); an explicit `null` fails closed |
| `policy` | `{}` | M1 endpoint policy options; `allowExternalProviders` is scoped to the configured host like the B1 client |
| `timeoutMs` | `8000` | One deadline covering the request and the body read |
| `maxResponseBytes` | `32768` | Response cap, 1 KiB to 1 MiB |
| `tierByDifficulty` | `{ easy: 'cheap', medium: 'standard', hard: 'powerful' }` | A full, distinct three-way mapping |
| `defaultTier` | `standard` | The conservative tier used for below-threshold answers and every fallback |
| `fetch` | `globalThis.fetch` | Transport seam for tests |

`describe()` returns only frozen non-secret configuration: version, path, classes, tiers, the tier
mapping, the default tier, the input cap, the timeout and the response cap.

### Result and failure policy

| Situation | Result |
|---|---|
| `label` in `easy`, `medium`, `hard` and `meets_threshold: true` | `fallback: false`, tier from the mapping |
| `meets_threshold: false`, a missing flag, or `label: "needs_info"` | `fallback: false`, `needsInfo: true`, `defaultTier` |
| Timeout, network error, a refused redirect, HTTP 4xx/5xx, non-JSON, malformed answer, oversized body | `fallback: true`, `defaultTier`, a fixed `code` (`timeout`, `network-error`, `http-status`, `invalid-response`, `response-too-large`) and an integer `status` for HTTP failures |
| Invalid options, invalid prompt, missing or invalid key | throws `MorphRouterError` with a fixed code; no request |
| Endpoint-policy denial | throws the M1 `AIEndpointPolicyError`; no request |
| Caller cancellation | throws `MorphRouterError` with `code: 'aborted'` |

A Router failure therefore never fails a chat turn: routing is a hint and the caller keeps the
option of a fixed tier for the class. Apart from the tier, the result carries only the difficulty
label, its confidence, the `meetsThreshold`/`needsInfo`/`fallback` flags and the fallback `code` and
`status`; the prompt, answer body and credential never enter a result, an error or `describe()`. The
only endpoint text that can appear anywhere is the redacted `endpoint` property on the shared M1
`AIEndpointPolicyError`, which carries no credential, query or fragment because the base URL forbids
them.

## Security boundary

- The key is read once from an explicit value or the configured environment variable and only
   becomes the `Authorization` header; it is not stored on the router object (`Object.keys` is
   `classify,describe`), not in `describe()`, not in an error and not in a serialized result.
- Every request is gated by `assertAIEndpointAllowed()` before `fetch`. `https://api.morphllm.com`
   is denied by default; `allowExternalProviders: true` is scoped to that exact host, and an
   explicit `allowHosts` works without the switch. A Copilot, telemetry, GitHub or metadata host
   keeps its own category switch or hard deny, and the hard-deny set is never bypassed.
- Redirects are refused (`redirect: 'error'`), the deadline also covers the body read, and the body
   is read as an async iterable under the cap; there is no unbounded `response.text()` fallback and
   no unbounded JSON parse.
- The prompt is a non-empty, well-formed string without NUL, at most 32,768 characters and 128 KiB
   of UTF-8; a rejected prompt never echoes its text. The options and call-options bags are read
   through own data descriptors, so a revoked or throwing Proxy, an accessor-backed option or policy,
   and an unknown or reserved key fail closed; a live Proxy is read only through descriptors, so a
   get trap never runs. The `env` seam reads only the named variable once, which by design may invoke
   an accessor on a Proxy environment. An injected transport's hostile response getters and a hostile
   HTTP status map to bounded codes.
- The answer is validated through own data descriptors and exact ranges: an unknown label, a
   non-finite or out-of-range confidence, a non-boolean threshold flag or a malformed shape degrades
   to the default tier rather than being trusted.

## Verification

`node --test tests/vibe/morph-router.test.mjs` covers the public surface and frozen `describe`, the
pinned request init (POST, `redirect: 'error'`, a live abort signal), the exact request (path, body,
bearer header), the three-label mapping, the below-threshold and `needs_info` paths, a missing
threshold flag, malformed answers, a hostile response object, HTTP failures and a non-JSON body, a
timeout whose deadline also covers the body read, a network error, a refused redirect, declared and
streamed oversized bodies, caller cancellation (including an already-aborted signal), the
endpoint-policy denial, the scoped `allowExternalProviders` allow, the explicit `allowHosts` allow
and the refusal to widen the policy to a hard-denied host, the environment-key path (read once) and
its missing-key error, a result free of the key, prompt, host and response body, `describe()` free
of the key, prompt and host, and an error free of the key and prompt, invalid options (including
accessors, a revoked Proxy, a live Proxy read only through descriptors, a Proxy whose key or
descriptor trap throws, a tier-map accessor and each numeric range), a base URL with credentials,
invalid prompts, a prompt at the cap, deterministic frozen results and a hostile status. It also
covers a polluted `Object.prototype` attempting to enable the external-provider opt-in, an empty
key, an arbitrary key variable, null option values, and an oversized, invalid or shadowed byte
length on a body chunk. The suite uses a local mock HTTP server or an injected `fetch` and makes no
live provider call.

## Follow-ups

- B3 wiring: delivered 2026-11-28 in `provider-router.mjs`. A policy route may tag the tiers it
   serves and a chat request may carry one `tier` hint; the hint only reorders the class's own
   routes (tagged-for-the-tier first, then untagged, then routes tagged for other tiers, each group
   in policy order, and the policy order when nothing matches), so every route stays reachable as a
   fallback and the Router can never override a class's fixed route or reach a model outside the
   validated policy. `router.classify(taskId, prompt)` charges the billed call against the same task
   and UTC-day ledger with a conservative bound before dispatch, settles with reported usage,
   releases on an adapter throw and keeps the charge on a malformed answer. Deciding when to
   classify and passing the result as a hint in a live turn remains M6 integration work.
- `/v1/router/multimodel` (a candidate model from a caller policy) arrives when a caller needs it.
- The direct provider's chat, stream and tool path now has a live smoke: the opt-in
   [`vibe/tools/provider-smoke.mjs`](../../../vibe/tools/provider-smoke.mjs) asks one chat turn,
   the same turn streamed and one tool definition on the `morph` preset (see
   [m2-provider-smoke.md](m2-provider-smoke.md)). A live `POST /v1/router/classify` call remains
   M2 work.
- The provider's `ambiguity` and `domain` classes may later refine B3 classes beyond difficulty.
