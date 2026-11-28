# M2 B6 Morph-hosted Fast Model rows

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-28
>
> The direct provider's hosted chat catalog. It lives in
> [morph-models.mjs](../../../src/stable/gateway/morph-models.mjs), and its acceptance tests live in
> [morph-models.test.mjs](../../../tests/vibe/morph-models.test.mjs).

## Scope

B6 asks for "Morph-hosted open models including the approval-gated abliterated model" as the
direct second option. The B1 `morph` preset previously named no model at all, so a provider
definition written by the B5 setup panel carried no `model`, and nothing in the product recorded
which Morph-hosted models exist, what they cost, or which of them is safe to select. The Router
adapter, Fast Apply, WarpGrep and Compact are delivered elsewhere and are not touched here.

This slice is data only. It adds one frozen table of the chat rows Morph publishes, a tier map, a
default model for the preset and a validated map builder for the B6 direct policy. It creates no
client, reads no environment variable, holds no credential and performs no network I/O. Enabling
the approval-gated rows in a product flow and pricing calls in the budget ledger remain open; live
provider smoke ships separately as the opt-in `vibe/tools/provider-smoke.mjs`.

## Source and evidence

Every row, price and context window was read on 2026-11-28 from Morph's own machine-readable
catalog, `https://www.morphllm.com/api/models/json?prices=list` (no key required), which serves the
same list as the Fast Models table in the live documentation. That feed is the reason the earlier
radar entry ("the model list needs an authenticated call") could be replaced with exact facts.

The feed's per-token prices are converted once, at authoring time, to integer nanodollars per
million tokens: a listed `0.000000141953125` USD per token becomes `141953125` nanodollars per
million tokens. Integer storage keeps the fractional DeepSeek V4 Flash price exact and lets a
caller compare or display prices without float arithmetic.

## The rows

`MORPH_HOSTED_MODELS` holds exactly the twelve chat rows, frozen, in feed order except that the two
approval-gated rows are listed last so the ungated set reads as one block. Each row has only
`id`, `label`, `contextTokens`, `inputNanoUsdPerMillionTokens`,
`outputNanoUsdPerMillionTokens`, `cachedInputNanoUsdPerMillionTokens` and `gated`, and every label is
the feed's own `name` without its `Morph: ` prefix. All twelve advertise a 1,048,576-token context.

| Id | Label | In / out / cached (USD per 1M) | Gated |
|---|---|---|---|
| `morph-glm53-744b` | GLM-5.3 | 1.68 / 5.28 / 0.312 | no |
| `morph-glm52-744b` | GLM-5.2 | 1.68 / 5.28 / 0.312 | no |
| `morph-glm53flash` | GLM-5.3-Flash | 0.18 / 0.60 / 0.036 | no |
| `morph-dsv41flash` | DeepSeek V4.1 Flash | 0.12 / 0.80 / 0.008 | no |
| `morph-dsv41flash-1017` | DeepSeek V4.1 Flash 1017 | 0.12 / 0.80 / 0.008 | no |
| `morph-dsv4flash` | DeepSeek V4 Flash 0731 | 0.141953125 / 0.399625 / 0.0359375 | no |
| `morph-dsv4flash-0731` | DeepSeek V4 Flash 0731 | 0.141953125 / 0.399625 / 0.0359375 | no |
| `morph-kimik3` | Kimi K3 | 2.50 / 14.00 / 0.29 | no |
| `morph-kimik31` | Kimi K3.1 Pro | 2.50 / 14.00 / 0.29 | no |
| `morph-kimik3-fast` | Kimi K3 Fast | 6.00 / 22.50 / 0.60 | no |
| `morph-dsv41flash-abliterated` | DeepSeek V4.1 Flash Abliterated | 0.30 / 1.20 / 0.03 | yes |
| `morph-kimik3-abliterated` | Kimi K3.1 Pro Abliterated | 5.00 / 28.00 / 0.58 | yes |

Three kinds of id are deliberately absent, because none of them is a pinnable chat model:

- the apply models `morph-v3-fast` and `morph-v3-large` (Fast Apply is its own module);
- the decision model `reflex`, whose only output modality is typed decisions;
- the floating aliases `kimi-latest` and `deepseek-flash-latest`, which silently move to the newest
   model of their family and so cannot be a pinned product default; neither alias appears in the
   public feed read on 2026-11-28 at all, so neither is even a row to refuse.

## Tier map and default

`MORPH_TIER_MODELS` maps the three B3 difficulty tiers to one exact, ungated row each:

| Tier | Row | Why |
|---|---|---|
| `cheap` | `morph-dsv41flash` | the lowest input price in the catalog with a 1M window, and the model the build loop already uses for its standard and cheap classes |
| `standard` | `morph-glm53flash` | the mid price band with vision input and 1M context |
| `powerful` | `morph-glm53-744b` | the 744B GLM flagship, the same row the build loop uses for `strong` and `review`, and 1.68 / 5.28 against Kimi K3.1 Pro's 2.50 / 14.00 at the same 1M context |

Kimi K3.1 Pro stays a documented row a caller can select through `tierModels`; it is not the default
for the most expensive class, because the tier map feeds every `plan` and `code-edit` turn.

`MORPH_DEFAULT_MODEL` is the `cheap` row and is also the `morph` preset's `defaultModel`, so a
provider definition always carries a real, pinned model. A test asserts that parity, so the two
constants cannot drift.

## The model map contract

`morphHostedModelMap({ embeddingModel, tierModels? })` returns the frozen six-class `morphModels`
map that `createMorphDirectPolicy` expects:

| Task class | Model |
|---|---|
| `plan`, `code-edit` | the `powerful` row |
| `review` | the `standard` row |
| `quick-edit`, `summarize` | the `cheap` row |
| `embed` | the caller's `embeddingModel` |

`embeddingModel` is required and fails as `missing-embedding-model` when absent, because Morph's
Fast Models list has no embedding model; the caller names one explicitly instead of the product
inventing an id. The endpoint agrees: `POST https://api.morphllm.com/v1/embeddings` answers
`404 model_not_found` and names `morph-embedding-v4` and `morph-rerank-v4` as retired (verified
live 2026-11-28), so the `morph` preset no longer advertises `embeddings`. Because
`createMorphDirectPolicy` names the `morph` provider for every class, the `embed` class now has no
working route and a non-Morph model id would still be sent to Morph; reaching another embedding
service needs a policy change (recorded follow-up). `tierModels` may re-point any tier at another
ungated hosted row.

`morphHostedModel(id)` returns the frozen row for an ungated hosted chat model and `undefined` for
anything else, including a gated row, an apply model, the decision model and a floating alias.
`describeMorphModels()` returns only the version, the source URL and read date, the tier map and the
rows.

## Refusals and security boundary

The two abliterated rows are recorded but never selected automatically: a request from an account
without privileged access returns 403 at the provider, so making one a default would turn every
turn into a failed attempt for almost every user. Only a hand-written
`providers.morph.defaultModel` override in settings JSON can name a gated row, and that request
fails with the provider's 403. `tierModels` rejects a gated row, an unknown id, a
floating alias, a non-row model and an invalid model string as `invalid-tier-model`; a gated
`embeddingModel` fails `gated-model-unavailable`; an invalid embedding model string fails
`invalid-embedding-model`.

Options are read once through own data descriptors and enumeration traps are caught, so an accessor
or Proxy is never invoked (`invalid-options`). Errors carry only a code and a fixed message and
never echo a supplied model id. No row, map, describe result or error contains a credential,
client, endpoint credential or request body, and the describe projection carries only the public
source URL and read date.

## Verification

`node --test tests/vibe/morph-models.test.mjs tests/vibe/provider-presets.test.mjs` covers the
frozen rows and their exact ids, shape, context and prices, the two gated rows, the absence of the
apply, decision and alias ids, the tier map and its parity with the preset default, the ungated
lookup of `morphHostedModel`, the six-class map fed unchanged into `createMorphDirectPolicy`, tier
overrides and their refusals, the required embedding model and its refusals, own-descriptor-only
option reads with a zero accessor count, non-echoing error messages, the describe projection and
row immutability. `node vibe/tools/verify.mjs --strict` and `node vibe/tools/docs-check.mjs
--strict` are the acceptance commands.
