# M2 B6 Fast Apply agent tool

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-25
>
> The bounded `edit_file` tool around the Morph Fast Apply model. It lives in
> [morph-fast-apply.mjs](../../../src/stable/gateway/morph-fast-apply.mjs), and its acceptance
> tests live in [morph-fast-apply.test.mjs](../../../tests/vibe/morph-fast-apply.test.mjs).

## Scope

B6 requires Fast Apply to be available as an agent tool. This slice supplies the documented
`edit_file` function definition and a tool that merges one lazy edit into one existing file inside
a caller-provided workspace. It uses the existing B1 Morph client, so the request keeps the
M1 endpoint policy, bearer-key handling, timeout, redirect refusal and response caps.

This slice does not add WarpGrep, the Router, hosted models, the approval-gated abliterated model,
live provider calls, agent-host wiring, streaming, multi-file edits, diff rendering, retries or
Bifrost supervision. The client is supplied by the caller; the tool explicitly requests
`morph-v3-fast` and never constructs a client or reads an environment variable.

## Tool contract

```js
const tool = createMorphFastApplyTool({ client, workspaceRoot });
const result = await tool.execute({
   target_file: 'src/value.mjs',
   code_edit: '// ... existing code ...\nexport const value = 2;\n// ... existing code ...',
   instructions: 'Bump the value to two.',
});
```

`definition` is a frozen OpenAI function tool named `edit_file` with the three required fields and
`additionalProperties: false`. `execute` returns a frozen object with `targetFile`, `changed`, the
UTF-8 `bytesWritten` and normalized `usage` token counts. It never returns the source, merged code,
instructions, prompt, response body, endpoint or credential.

The request is exactly one OpenAI Chat Completions turn through the supplied B1 client:

```text
<instruction>...</instruction>
<code>...</code>
<update>...</update>
```

The request names `morph-v3-fast` and does not stream. The `instructions` field is required because
the live Fast Apply guide documents it as the context that improves ambiguous merges.

## File boundary

Targets are relative paths below `workspaceRoot`. Absolute paths, drive paths, UNC paths, encoded
separators, empty or dot segments, traversal, colons, Windows reserved device names, control and
bidi characters are rejected. The resolved target must be a regular file inside the real workspace
root; a symlink target is rejected. Directories, missing files and source files above 1 MiB are
rejected before a provider call.

The source is read with `O_NOFOLLOW` where the platform supports it, checked with an lstat/realpath
containment pass and a stable device/inode identity around the read, and decoded as strict UTF-8.
On Windows, where `O_NOFOLLOW` is unavailable, the path and identity checks carry that boundary.
The merged result must be non-empty, well-formed Unicode, bounded to 2 MiB and free of NUL, other
disallowed C0 controls and DEL; C1 controls are preserved. An identical result reports `changed:
false` and does not rewrite the file.

For a changed result the tool writes a unique `0600` temporary file beside the target, re-reads and
compares the original source immediately before the atomic rename, and removes the temporary file
on failure. A change observed during the read or before that final comparison fails closed as
`file-changed`. A narrow check-to-rename race remains: a replacement made after the final comparison
is not detected.

## Input and error boundary

Options, input and the client's own `chat` property are read through own data descriptors. Unknown
fields, missing fields, reserved keys, accessors, duplicate enumerations, sparse or non-string
values and oversized edits fail closed without invoking a getter. Edits accept tabs and line
endings but reject NUL, other binary controls and ill-formed Unicode. Instructions reject control
and bidi characters.

Provider failures are reported as `provider-error` with only an integer HTTP status when the B1
client supplied one. Empty, ill-formed, binary and oversized answers use fixed `FastApplyError`
codes. No error carries the credential, source, edit, instruction, prompt or response body.

## Verification

`node --test tests/vibe/morph-fast-apply.test.mjs` covers the immutable schema, a real B1 client
against a local mock endpoint and one exact merge request, the write result, unchanged files,
provider/HTTP/empty/malformed/binary/oversized failures, absolute/drive/UNC/traversal/encoded and
missing/symlink targets, a source file replaced during the call, accessor non-invocation, options
and input validation, the binary and source-size caps, an assembled prompt above the B1 message cap,
a directory junction swapped to a second in-root directory during the call (the validated real
target is written and the alternate path is untouched), secret and content non-exposure and a
frozen result.
