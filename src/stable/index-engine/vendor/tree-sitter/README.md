# Vendored tree-sitter runtime and grammars

Pinned for the standalone index engine (M4 C1, ADR-0009). These files are copied
verbatim from the npm tarballs below; do not edit them by hand. Refresh steps are in
`docs/vibe/dev/BUILD.md`.

| Package | Version | Published | License | Vendored files |
|---|---|---|---|---|
| `web-tree-sitter` | 0.27.2 | 2026-11-07 | MIT | `web-tree-sitter.js`, `web-tree-sitter.wasm` |
| `tree-sitter-javascript` | 0.25.0 | 2025-09-01 | MIT | `tree-sitter-javascript.wasm` |
| `tree-sitter-typescript` | 0.23.2 | 2024-11-11 | MIT | `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm` |

Provenance (tarball checksums and npm `dist.integrity`, verified on 2026-11-23):

- `web-tree-sitter-0.27.2.tgz`: `0b1d1b2edcc1476c7b1710a2a4589eef9ca9cf461baa50f89956d57530964362`,
  `sha512-ZRo86GKI4aOSBAqOrPmCtriExI3xIzu1sNw/V6v3b4QGxrEmO19FGwbMNdyhw3MJLAZIw0xAV0oSpqX361eAyQ==`
- `tree-sitter-javascript-0.25.0.tgz`: `6214ce23d03aba525ba8edd6ca7caf365c969f2c2dbfc353e376ca54507ffb92`,
  `sha512-1fCbmzAskZkxcZzN41sFZ2br2iqTYP3tKls1b/HKGNPQUVOpsUxpmGxdN/wMqAk3jYZnYBR1dd/y/0avMeU7dw==`
- `tree-sitter-typescript-0.23.2.tgz`: `0fdf63c35930a75885145d75ee63cb879da2d49db9bfe454bd8e60b08ba778a1`,
  `sha512-e04JUUKxTT53/x3Uq1zIL45DoYKVfHH4CZqwgZhPg5qYROl5nQjV+85ruFzFGZxu+QeFVbRTPDRnqL9UbU4VeA==`

`SHA256SUMS` lists the checksum of every vendored file. The test suite verifies it on
every run. All three packages are MIT; the license texts sit beside the files. The
local `package.json` only marks this directory as ESM so Node does not re-parse the
runtime on every load; it is not published.
