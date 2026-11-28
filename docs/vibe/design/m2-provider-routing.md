# M2 B3 task-class routing and token budgets

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-28
>
> The policy router and budget boundary that compose the B1 request clients and B2 fallback. It
> lives in [provider-router.mjs](../../../src/stable/gateway/provider-router.mjs), and its acceptance
> tests live in [provider-router.test.mjs](../../../tests/vibe/provider-router.test.mjs).

## Scope

B3 needs a policy table to choose the model for each task class and a hard stop before a task or
day budget can be exceeded. This slice supplies that decision layer for `plan`, `code-edit`,
`quick-edit`, `review`, `summarize` and `embed`, and it can consume a difficulty tier and charge a
billed classification. It does not start Bifrost, intercept workbench requests, decide when to
classify a prompt, construct or own the Router adapter, store provider secrets, surface the provider
UI or price calls in currency. Those remain B5/B6 and later M2/M6 integration work.

## Policy contract

`createProviderRouter({ policy, providers, budgets, difficulty?, now? })` takes one to eight routes per task
class. Every B3 class is required, and an unknown or missing class fails closed.

```js
const router = createProviderRouter({
   policy: {
      plan: [{ provider: 'omniroute', model: 'planner-model', maxOutputTokens: 4096 }],
      'code-edit': [{ provider: 'omniroute', model: 'coder-model', maxOutputTokens: 4096 }],
      'quick-edit': [{ provider: 'omniroute', model: 'quick-model', maxOutputTokens: 512 }],
      review: [{ provider: 'morph', model: 'review-model', maxOutputTokens: 2048 }],
      summarize: [{ provider: 'morph', model: 'summary-model', maxOutputTokens: 1024 }],
      embed: [{ provider: 'omniroute', model: 'embedding-model', maxOutputTokens: 0 }],
   },
   providers: { omniroute: omniRouteClient, morph: morphClient },
   budgets: { perTaskTokens: 200_000, perDayTokens: 1_000_000 },
});

const answer = await router.chat('code-edit', { taskId: 'task-42', messages });
```

Each route names a provider already present in `providers`, a validated model, an output cap and,
optionally, the difficulty `tiers` it serves. Chat classes need a positive cap; `embed` needs zero.
Providers are unique within a class. A route's
client must expose `chat`, and an embedding route's client must expose `embeddings`. Policy objects
are read once through own data descriptors; unknown fields, accessors, sparse arrays, malformed ids,
extra task classes and invalid caps fail closed. Request data is deep-snapshotted into frozen
JSON-safe values before estimation and dispatch, so accessor-backed arrays or objects, sparse
arrays, functions, non-finite numbers, cycles, over-deep or oversized input fail closed without
invoking a getter, and the dispatched request cannot change after it has been measured.

The router rejects a caller-supplied `model` or `maxTokens`; the policy owns both. `chat` accepts
only `taskId`, `messages`, `tools`, `stream` and one difficulty `tier`; `embeddings` accepts only
`taskId` and `input`. `chat('embed', ...)` and `embeddings('plan', ...)` are rejected.

## Routing and fallback

Each class becomes a B2 fallback chain. The first route supplies the model sent to the first
provider and every later route uses its own model, so a primary model name is never sent to
another provider. A successful answer reports `routedBy` with the class, first policy route and the
`tier` hint, plus the B2 `servedBy` and `attempts` metadata. The B2 rules stay in force: only timeout, network,
408/429/5xx and an empty chat answer advance the chain; policy denial, authentication, validation
and cancellation stop it.

For chat classes, when routes have different caps, the router sends the largest cap to the chain.
That keeps one conservative output bound for every attempt in the reservation while preserving the
policy order. Routing is decided independently per request; sticky cross-turn routing remains B4.

## Difficulty tier hints

B6's Router adapter returns one abstract tier (`cheap`, `standard` or `powerful`). A route may name
the tiers it serves with an optional `tiers` list, and a chat request may carry one `tier` hint. A
hint never changes which class is used or which routes are eligible: it only reorders that class's
own policy routes. Routes tagged for the hinted tier come first, then untagged routes (which serve
every tier), then routes tagged only for other tiers, each group in policy order. When no route is
tagged for the hinted tier the policy order is used unchanged, so a hint can never make a class
unroutable. Every policy route stays reachable as a B2 fallback and no provider outside the policy
can be called. Because the set of routes and the largest output cap are unchanged, the reservation
is the same with or without a hint.

`tier` is accepted only on `chat`; `embeddings` rejects it. An unknown tier fails closed as
`invalid-request`, and a route's `tiers` must be a non-empty, duplicate-free list of known tiers
(`invalid-policy`). `routedBy` reports the class, the first route the reordered chain used and the
`tier` hint (`null` when absent). Deciding when to classify and passing that result as a hint in a
live turn remains M6 integration work; B3 only consumes the label. That wiring must keep
ARCHITECTURE §3.6 (a session sticks to one provider unless failover is needed) in force: classify
once per task or session and pin the chosen route, rather than letting a per-turn hint move a live
session between providers and break prompt-cache stability.

## Budget hard stop

Budgets are token counts. The router reserves a conservative input upper bound plus the full output
cap against both the task and the UTC day before it dispatches:

- Input uses the exact UTF-8 byte length of the JSON-serialized messages or embedding input, the
   complete tool schemas (including numeric and enum tool parameters) and fixed message and tool
   allowances. A token cannot encode less than one UTF-8 byte, so this is an upper bound without
   shipping a tokenizer.
- The output reservation is the highest route cap for the class.
- The reservation is multiplied by the route count, because B2 can contact each route once.
- If either the task or day cannot cover the reservation, `ProviderRouterError` with code
   `budget-exhausted` and scope `task` or `day` is raised before a provider call.

A reservation remembers the UTC day record it started under. Settlement always releases the
reservation from that record and charges actual usage to the day that is current at settlement. If a
call completes after midnight, the new day never had the old reservation subtracted from it; the
actual usage may consume its remaining budget, and later calls fail closed if it is exhausted. A
clock failure during settlement falls back to the reservation's day so it cannot mask the provider
answer. A successful answer replaces the reservation with its normalized `usage.totalTokens` when
that is positive, and otherwise keeps the reservation (absent or zero usage). Failed calls release
their reservation; B1 exposes no usage for a failed attempt, so no token count is invented for it.
`status(taskId)` reports used, reserved and remaining task/day tokens. Task state is capped at
10,000 entries and the cap fails closed instead of evicting an entry; there is no caller-facing
`endTask`, so a completed task's usage cannot be reset. Budget state is in-memory and resets with
the process; persistence is later integration work. Budgets and task ids are local control data
and never enter a provider request.

The B1 `chat` method now accepts an optional `maxTokens` and sends `max_tokens` for OpenAI Chat or
`max_output_tokens` for OpenAI Responses. For chat classes the router always supplies this cap from
the policy; embedding routes use the policy's zero cap and send no output cap.

## Difficulty classification and its charge

A Router classification is a billed provider call ($0.005 per request at the recorded price), so
`classify(taskId, prompt)` charges it through the same budget ledger. The router takes an optional
`difficulty` adapter (any object exposing `classify` as an own data property) and exposes
`classify`, which reserves `CLASSIFY_FRAMING_TOKENS` (256) plus the prompt's JSON-escaped UTF-8
bytes plus `MAX_CLASSIFY_ANSWER_BYTES` (32 KiB) against the task and the UTC day before it
dispatches. The framing allowance covers the small request envelope and the byte bound covers the
adapter's default documented answer cap; a token cannot encode less than one byte, so the sum is a
conservative upper bound without a tokenizer, and the escaped length counts each JSON escape (a
non-shortcut control character as its six-byte `\u00XX` form, `\n` or `\t` as two bytes) rather
than the raw character's bytes. An adapter constructed with a larger
`maxResponseBytes` can spend above this bound; the ledger still never charges more than the
reservation, so the default cap is the stated assumption. The captured function is called with the
router's frozen wrapper as `this`, so an adapter must not rely on its own object identity for
`this`; bind or close over state instead. A prompt is a non-empty, well-formed string without NUL,
at most 32,768 characters and 128 KiB of UTF-8; an invalid prompt, a missing adapter and an
exhausted budget fail closed before the adapter runs.

Settlement follows the chat rules. A reported `usage.totalTokens` replaces the reservation when it
is a positive safe integer no larger than the reservation (read through own data descriptors, so an
accessor never runs); a missing, zero, oversized or otherwise unusable count keeps the conservative
charge, an adapter that throws releases the reservation, and a malformed answer keeps the charge
because the request was dispatched. The adapter's answer is re-validated field by field and copied
into a frozen result carrying only `tier`, `difficulty`, `confidence`, `meetsThreshold`,
`needsInfo`, `fallback`, `code` and `status`, so a prompt echo or credential cannot ride along.
`describe()` adds the tier list and whether an adapter is configured. The tier and prompt constants
are local copies of the adapter's (`DIFFICULTY_TIERS`, `MAX_CLASSIFY_PROMPT_CHARS`,
`MAX_CLASSIFY_PROMPT_BYTES`, `MAX_CLASSIFY_ANSWER_BYTES`), and the tests assert equality, so the
policy layer keeps no runtime dependency on the network adapter.

## Failure metadata

Policy, budget, request and classification errors contain only codes, messages, scope and integer
token counts. They never contain a provider body, prompt, credential or client object. `describe()`
returns only the router version, task classes, tier list, policy routes (provider ids, models, caps
and each route's `tiers`), budgets and whether a difficulty adapter is configured; it never returns a
client or a secret, and a classification never exposes its prompt.

## Verification

`node --test tests/vibe/provider-router.test.mjs tests/vibe/provider-client.test.mjs` covers policy
selection for all six classes, chat and embeddings routing, B2 failover, the task and day hard stops,
usage reconciliation, UTC rollover, both transport cap fields, malformed policy and provider
definitions, task-id and accessor rejection, non-invocation of request and policy index getters,
JSON-heavy tool schemas, completed-task budget persistence, the fail-closed task cap, client-secret
non-exposure and the new cap validation. It also covers route tier tags and the tier list in
`describe()`, each tier ordering (tagged first, then untagged, then other tiers), the unchanged
policy order when nothing matches, an absent and an invalid hint, the unchanged reservation with a
hint, a classification with no adapter configured, the prompt and budget rejection before the
adapter runs, the conservative charge and the frozen eight-field copy, settlement from reported
usage, the release on an adapter throw, the kept charge on a malformed answer, the constant parity
with `morph-router.mjs`, and an end-to-end classify-to-tier turn. It also proves that a `usage`
hint backed by an accessor is never read (the getter count stays zero), that a count above the
reservation is not trusted, and that every label the adapter can emit plus `needs_info` is accepted.
`node vibe/tools/verify.mjs --strict` remains the repository acceptance command.
