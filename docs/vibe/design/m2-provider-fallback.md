# M2 B2 ordered provider fallback

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-25
>
> The fallback layer that composes the B1 request clients. It lives in
> [provider-fallback.mjs](../../../src/stable/gateway/provider-fallback.mjs), and its acceptance
> tests live in [provider-fallback.test.mjs](../../../tests/vibe/provider-fallback.test.mjs).

## Scope

B2 requires that a forced primary-provider failure produces an answer from the next provider in
the same turn, or fails cleanly. This slice supplies that ordered fallback layer for chat and
embeddings. It does not choose providers by task class, enforce token or daily budgets, surface a
provider UI, start Bifrost, or call a live provider. Task-class routing and budgets now live in the
B3 router; the provider UI is delivered in B5,
while live-provider calls and Bifrost supervision remain later integration work.

## Chain contract

`createProviderFallback(entries)` accepts one to eight entries in preference order:

```js
const chain = createProviderFallback([
   { id: 'omniroute', label: 'OmniRoute', client: omniRouteClient },
   { id: 'morph', label: 'Morph direct', client: morphClient, model: 'morph-chosen-model' },
]);
```

Each entry names a provider id, an existing B1 client and an optional label and model. Ids must be
unique, lowercase provider identifiers. A client must expose `chat`; `embeddings` is optional.
Labels, models, chain length, sparse arrays, reserved properties and accessor-backed values are
validated before the chain is created. The fallback layer adds no external dependency.

The caller's request model applies to the first provider only. A later provider uses its entry
`model` when present and otherwise lets its own client use the model resolved from its preset, so a
primary provider's model name is never sent to a different provider.

## Failover policy

The chain tries providers once, in order. It advances only on these transient failures:

| Failure | Classification |
|---|---|
| request timeout | retry next provider |
| network error, including a reset while reading the body or stream | retry next provider |
| HTTP 408, 429 or 500-599 | retry next provider |
| chat answer with no text and no tool call | retry next provider |

Request validation, missing or invalid credentials, HTTP 400/401/403/404 and other non-transient
statuses, endpoint-policy denial and caller cancellation are returned unchanged on the first
attempt. In particular, an endpoint-policy denial is never converted into a different provider
request, and a cancelled turn does not continue down the chain.

Streaming requests are passed through unchanged, and a successful answer keeps the provider's
streamed text, assembled tool calls, usage and finish reason; the fallback only adds `servedBy`
and `attempts`.

## Result and failure metadata

A successful answer adds two fields without changing the provider result:

- `servedBy`: `{ id, label, fallback }`, where `fallback` is true after the first provider.
- `attempts`: frozen attempt summaries, `{ id, label, outcome }`, with `outcome` equal to
   `answered`, `empty` or `failed`. A failed attempt also carries only its safe error `code` and,
   when present, integer `status`.

If every provider fails transiently, `chat` or `embeddings` rejects with
`ProviderFallbackError.code === 'fallback-exhausted'` and the same bounded attempt summaries.
Provider response bodies, prompts, message content and credentials never enter an attempt summary
or an error. `describe()` returns only the chain version, provider ids, labels and explicitly
configured models.

## Verification

`node --test tests/vibe/provider-fallback.test.mjs` uses two local mock providers and covers
timeout, 429, 5xx and empty-stream failover; streamed text and tool calls; non-retryable 400,
endpoint-policy denial and cancellation boundaries; exhausted attempts; per-provider model
selection; embeddings; malformed definitions; and secret/body non-exposure.
`node vibe/tools/verify.mjs --strict` remains the repository acceptance command; the strict docs
check passes.
