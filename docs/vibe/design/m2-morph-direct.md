# M2 B6 direct second option (first acceptance)

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-25
>
> The B3 policy constructor for the direct second option. It lives in
> [morph-direct.mjs](../../../src/stable/gateway/morph-direct.mjs), with its acceptance tests in
> [morph-direct.test.mjs](../../../tests/vibe/morph-direct.test.mjs).

## Scope

B6's first acceptance is that, with OmniRoute stopped, an agent task still completes on the direct
provider in the same turn. This slice supplies a validated policy constructor that places
`omniroute` first and `morph` second in every B3 task class, then proves the same-turn chat and
embeddings paths through real B1 clients, B2 failover and the B3 router against a local mock.

The helper is data-only. It creates no client, reads no environment variable, holds no credential
and performs no network I/O. It does not implement Fast Apply, WarpGrep, Compact, the Router,
Morph-hosted models, the approval-gated abliterated model, Bifrost or live provider calls; those
remain B6 work after this first acceptance.

## Policy contract

```js
const policy = createMorphDirectPolicy({
   omnirouteModels: {
      plan: 'omni-plan', 'code-edit': 'omni-coder', 'quick-edit': 'omni-quick',
      review: 'omni-review', summarize: 'omni-summary', embed: 'omni-embed',
   },
   morphModels: {
      plan: 'direct-plan', 'code-edit': 'direct-coder', 'quick-edit': 'direct-quick',
      review: 'direct-review', summarize: 'direct-summary', embed: 'direct-embed',
   },
   outputCaps: {
      plan: 4096, 'code-edit': 4096, 'quick-edit': 512,
      review: 2048, summarize: 1024, embed: 0,
   },
});
```

Every class is required; there are no default models or caps. Each class receives exactly two
routes, in the order `omniroute`, then `morph`, and both routes use the caller's explicit model and
output cap for that class. Chat classes need a positive cap and `embed` needs zero, matching the B3
contract. Model names are validated with the B1 model grammar and the B1 length cap.

The helper returns a deeply frozen policy and exports only `MORPH_DIRECT_VERSION`,
`MORPH_DIRECT_PROVIDER_ORDER`, `MorphDirectError`, `createMorphDirectPolicy` and
`describeMorphDirect`. The describe result contains the version, provider order and task classes;
no returned structure contains a client, credential or configuration object.

Options, model maps and cap maps must be plain objects read once through own data descriptors.
Missing and extra classes, missing and unknown options, reserved keys, class-backed maps,
accessor-backed options or entries, duplicate keys reported by an enumeration trap, non-integer or
out-of-range caps, an embedding cap other than zero and invalid model strings all fail closed with
a `MorphDirectError` code. Validation errors name the class or option, never echo the supplied
model or cap value, and never invoke an accessor.

## Same-turn fallback

The caller creates the B1 clients and passes them to the B3 router under the ids the policy names:

```js
const router = createProviderRouter({
   policy: createMorphDirectPolicy(maps),
   providers: { omniroute: omniClient, morph: morphClient },
   budgets: { perTaskTokens: 200_000, perDayTokens: 1_000_000 },
});
```

B3 composes a B2 chain per class. When OmniRoute is stopped, the connection fails with a network
error, B2 advances to the second route and returns that answer in the same call. The answer's
`servedBy.id` is `morph` with `fallback: true`; `routedBy` still names the class and first policy
route, so it records the intended primary without claiming it served the request. `attempts`
contains only id, label, outcome, an allowlisted error code and an integer HTTP status when one
exists. Chat follows the same path as embeddings; the mock receives the class model for the second
route and the policy's `max_tokens` for a chat class.

B2's retry boundary is unchanged: timeout, network error, HTTP 408/429/5xx and an empty chat answer
advance the chain, while endpoint-policy denial, authentication, malformed request or response,
unsupported transport and caller cancellation stop it without contacting the second route.

## Security boundary

Provider bodies, prompts, keys and client objects never enter the policy, `describeMorphDirect` or
the route or attempt metadata. A token or port from the stopped endpoint is absent from the answer
and from an exhausted-chain error. The helper cannot leak a credential because it never receives a
client or options field that could carry one: unknown options, including a `providers` injection,
are rejected before any client is constructed.

## Verification

`node --test tests/vibe/morph-direct.test.mjs` covers the six-class policy, exact route order,
explicit models and caps, a stopped OmniRoute endpoint falling through to chat and embeddings in
the same call, `servedBy` and `routedBy`, bounded attempt metadata, secret and endpoint
non-exposure, malformed and missing options, missing and extra classes, reserved keys, accessor and
proxy trap failure or duplicate-key rejection without invoking a getter, class-backed maps, invalid models
and caps, and non-exposure of clients or secrets from the helper. `node vibe/tools/verify.mjs
--strict` and `node vibe/tools/docs-check.mjs --strict` are the acceptance commands.
