# M2 B3 task-class routing and token budgets

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-25
>
> The policy router and budget boundary that compose the B1 request clients and B2 fallback. It
> lives in [provider-router.mjs](../../../src/stable/gateway/provider-router.mjs), and its acceptance
> tests live in [provider-router.test.mjs](../../../tests/vibe/provider-router.test.mjs).

## Scope

B3 needs a policy table to choose the model for each task class and a hard stop before a task or
day budget can be exceeded. This slice supplies that decision layer for `plan`, `code-edit`,
`quick-edit`, `review`, `summarize` and `embed`. It does not start Bifrost, intercept workbench
requests, classify prompts automatically, store provider secrets, surface the provider UI or price
calls in currency. Those remain B5/B6 and later M2/M6 integration work.

## Policy contract

`createProviderRouter({ policy, providers, budgets, now? })` takes one to eight routes per task
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

Each route names a provider already present in `providers`, a validated model and an output cap.
Chat classes need a positive cap; `embed` needs zero. Providers are unique within a class. A route's
client must expose `chat`, and an embedding route's client must expose `embeddings`. Policy objects
are read once through own data descriptors; unknown fields, accessors, sparse arrays, malformed ids,
extra task classes and invalid caps fail closed. Request data is deep-snapshotted into frozen
JSON-safe values before estimation and dispatch, so accessor-backed arrays or objects, sparse
arrays, functions, non-finite numbers, cycles, over-deep or oversized input fail closed without
invoking a getter, and the dispatched request cannot change after it has been measured.

The router rejects a caller-supplied `model` or `maxTokens`; the policy owns both. `chat` accepts
only `taskId`, `messages`, `tools` and `stream`; `embeddings` accepts only `taskId` and `input`.
`chat('embed', ...)` and `embeddings('plan', ...)` are rejected.

## Routing and fallback

Each class becomes a B2 fallback chain. The first route supplies the model sent to the first
provider and every later route uses its own model, so a primary model name is never sent to
another provider. A successful answer reports `routedBy` with the class and first policy route,
plus the B2 `servedBy` and `attempts` metadata. The B2 rules stay in force: only timeout, network,
408/429/5xx and an empty chat answer advance the chain; policy denial, authentication, validation
and cancellation stop it.

For chat classes, when routes have different caps, the router sends the largest cap to the chain.
That keeps one conservative output bound for every attempt in the reservation while preserving the
policy order. Routing is decided independently per request; sticky cross-turn routing remains B4.

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

## Failure metadata

Policy, budget and request errors contain only codes, messages, scope and integer token counts.
They never contain a provider body, prompt, credential or client object. `describe()` returns only
the router version, task classes, provider ids, models, caps and budgets; it never returns a client
or a secret.

## Verification

`node --test tests/vibe/provider-router.test.mjs tests/vibe/provider-client.test.mjs` covers policy
selection for all six classes, chat and embeddings routing, B2 failover, the task and day hard stops,
usage reconciliation, UTC rollover, both transport cap fields, malformed policy and provider
definitions, task-id and accessor rejection, non-invocation of request and policy index getters,
JSON-heavy tool schemas, completed-task budget persistence, the fail-closed task cap, client-secret
non-exposure and the new cap validation. `node vibe/tools/verify.mjs --strict` remains the
repository acceptance command.
