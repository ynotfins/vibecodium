# M2 B6 Compact history pruning

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-25
>
> The verbatim-preserving history pruner behind B6's Compact feature. It lives in
> [compact.mjs](../../../src/stable/context-engine/compact.mjs), and its acceptance tests live in
> [compact.test.mjs](../../../tests/vibe/compact.test.mjs).

## Scope

B6 requires that Compact output keeps every surviving line byte-identical. This slice supplies a
dependency-free pruner for the D1 chat-history shape. Given a history and a token budget, it drops
whole older messages and only the oldest whole lines of the one boundary message. It keeps every
`system` message, every explicitly pinned message and the newest contiguous tail. It never calls a
model, summarizes, re-wraps or rewrites text, and it performs no I/O, so it can run over untrusted
session content.

It does not implement Fast Apply, WarpGrep, the Router, Morph-hosted models, the approval-gated
abliterated model, Bifrost supervision, live provider calls, model-backed summarization, tool-call
pairing or the in-IDE history path.

## Contract

```js
const result = compactHistory({
   messages: history,
   maxTokens: 32_000,
   pinned: [1],
   tokenizer: undefined,
});
```

- `messages` is `[{ role, content, name?, tool_call_id? }, ...]` with `system`, `user`, `assistant`
   or `tool` roles.
- `maxTokens` is a positive safe integer at or below `MAX_BUDGET_TOKENS` (`1_000_000_000`).
- A history is bounded as it is read and split: at most `MAX_MESSAGES` (`10_000`)
   messages, `MAX_MESSAGE_CHARS` (`1_000_000`) characters per message,
   `MAX_TOTAL_MESSAGE_CHARS` (`8_000_000`) characters and `MAX_TOTAL_LINES` (`1_000_000`)
   lines in total, so oversized input fails closed instead of exhausting memory.
- `pinned` lists message indexes; duplicates, out-of-range values and holes fail closed.
- `tokenizer` defaults to the D4 `estimateTokens`, which counts UTF-8 bytes plus one per non-empty
   string. D4 additionally adds a fixed per-section overhead when it assembles context, so a
   budget measured here uses the same counter as D4 but is not necessarily the same total as a
   fully rendered D4 request; compact never claims the two totals are identical.
- A custom tokenizer must return 0 only for empty text and must never count fewer tokens than
   that byte estimate, so the same text is counted the same way here and in D4's estimator. Its
   monotonicity is probed at several suffix positions before the boundary search, so an
   under-counting tokenizer, or one that fails a probe, fails closed as `compact-tokenizer`
   instead of inflating the kept history.

Options, messages and pinned lists are read once through own data descriptors. Unknown fields,
accessors, sparse arrays, `tool_calls`, non-string content, an unknown role, ill-formed Unicode in
content, a name or a tool id, and revoked or throwing proxies used anywhere (including as the
options object or a message element) fail closed with a `CompactError` code without invoking a
getter or echoing the rejected value.

## Pruning algorithm

1. Every `system` message and every explicitly pinned index is reserved in full. Pinned content
   that alone exceeds the budget raises `compact-overflow` with `scope: 'pinned'` and integer
   `availableTokens` and `requiredTokens`; no message is returned.
2. The newest droppable messages are kept, in order, while they fit the remainder.
3. The first message that does not fit becomes the boundary. Its whole content is measured again;
   if it now fits it is kept unmarked, otherwise its longest suffix of whole lines that fits is
   kept and marked truncated, and if not even its last line fits the message is dropped.
4. Every droppable message older than the boundary is dropped, and a message that fit before the
   boundary is never skipped to keep an older one.
5. Pinned messages keep their original position, and the result keeps the input order.

Each retained message is a frozen shallow copy of its source with the same role and metadata, and
a content string that is an exact suffix of the source content at a line boundary. Joining the
retained lines therefore reproduces their original UTF-8 bytes. Empty content is one empty line,
and a trailing newline ends the last line there.

## Report

`compactHistory` returns `{ version, messages, stats }`. `stats` carries `version`, `budgetTokens`,
`usedTokens`, `pinnedMessages`, `keptMessages`, `droppedMessages`, `truncatedMessages`,
`keptLines`, `droppedLines`, `droppedIndexes` and `truncatedIndexes`. `usedTokens` is the sum of
the retained content estimates and never exceeds the budget. Indexes are sorted and frozen. The
result, its messages, its stats and both index arrays are frozen, and the input is never mutated,
aliased or retained beyond the copied strings.

Each retained suffix is charged the exact count that was compared for it, so the reported total
cannot exceed the budget even when a caller tokenizer is not deterministic. A message is marked
truncated only when the retained suffix starts after its first line, so a whole message that fits
on the later measurement is reported as kept, not truncated.

## Boundaries

- `tool_calls` histories are rejected as `compact-unsupported`: dropping a tool call without its
   result or a result without its call would corrupt the history, so tool-call pairing is left to
   the agent-harness slice that can drop whole turns.
- The module holds no client, credential, environment variable or buffer, and its errors and
   `describeCompact()` expose only contract data.
- A custom tokenizer must be monotone: a shorter suffix must never count more tokens, and it
   must never count fewer than the D4 UTF-8 byte estimate. It must return a non-negative safe
   integer at or below `MAX_BUDGET_TOKENS`; probes compare the whole message with its
   second-line-onward, middle, second-to-last and last-line suffixes, and a violation is
   `compact-tokenizer`. The binary search then finds the longest fitting suffix in O(log n)
   tokenizer calls.
- The monotonicity probes are heuristic, not exhaustive. A missed non-monotone point can only
   keep a shorter suffix than optimal; it cannot push the charged total over the budget, because
   the charged count is the compared count.

## Verification

`node --test tests/vibe/compact.test.mjs` covers pinned and newest retention, whole-line boundary
truncation, an over-budget single line, a trailing empty line, empty content, tool metadata,
determinism, frozen output and input aliasing, a caller tokenizer, a tokenizer that throws, returns
0, returns a non-zero count for empty text, under-counts the byte floor or is non-monotone, pinned
overflow, malformed options and messages, sparse input, the per-message character cap, the
aggregate character and line caps, pinned list errors, revoked proxies as options and as message
elements, a non-deterministic tokenizer that must never report `usedTokens` above the budget, a
non-deterministic tokenizer that keeps a whole message without reporting a truncation, and
accessor non-invocation. `node vibe/tools/verify.mjs --strict` and
`node vibe/tools/docs-check.mjs --strict` are the acceptance commands.
