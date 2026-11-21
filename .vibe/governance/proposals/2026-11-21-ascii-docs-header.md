# Governance proposal: ASCII docs header separator

## Change

Allow the Markdown documentation header to use either `·` or ASCII `-` as the separator between the
class, owner, and reviewed-date fields. This keeps existing UTF-8 documents unchanged and gives
ASCII-only files—such as the build guide—a header that `ecformat` can classify reliably.

## Reason

The current `docs/vibe/dev/BUILD.md` uses an ASCII header because the earlier UTF-8 middle-dot
header was detected as `charset latin1` by the release format check. Accepting either separator
removes that false positive without changing the meaning of the header.

## Affected must-have IDs

F0 process-level docs check. No product must-have is weakened.

## Exact text

### `docs/vibe/GOVERNANCE.md`

```diff
@@ ## 1. Document classes
-Every Markdown file under `docs/vibe/` starts with a header line: `Doc class: <class> · Owner: <agent> · Last reviewed: <YYYY-MM-DD>`.
+Every Markdown file under `docs/vibe/` starts with a header line: `Doc class: <class> · Owner: <agent> · Last reviewed: <YYYY-MM-DD>`. An ASCII `-` may replace either `·` separator when the file must remain ASCII-only.
```

### `vibe/tools/docs-check.mjs`

```diff
@@ error message
-    if (!m) { errors.push(`${rel}: missing header "> Doc class: <class> · Owner: <agent> · Last reviewed: <YYYY-MM-DD>"`); continue; }
+    if (!m) { errors.push(`${rel}: missing header "> Doc class: <class> [-·] Owner: <agent> [-·] Last reviewed: <YYYY-MM-DD>"`); continue; }
```

## Verification

`node vibe/tools/verify.mjs --strict` passes 31/31 tests on the branch, including the new
`ascii separator passes docs header` test.