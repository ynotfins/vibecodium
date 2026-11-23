# Vendored tree-sitter WASM assets

Source: npm package `@vscode/tree-sitter-wasm@0.3.1` (Microsoft, MIT), published
2026-04-07, unpacked from the published tarball
`https://registry.npmjs.org/@vscode/tree-sitter-wasm/-/tree-sitter-wasm-0.3.1.tgz`
on 2026-11-23. Only the runtime and the JavaScript, TypeScript and TSX grammars are
vendored; the other grammars stay out until a milestone needs them.

| File | Bytes | SHA-256 |
|---|---|---|
| `LICENSE` | 1141 | `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383` |
| `tree-sitter.js` | 168729 | `874f4a37c4beddef04d8eb9a8dbd28a65b63111f2d2123a38fd3f5333ee046dd` |
| `tree-sitter.wasm` | 206218 | `3a31af706ffdf4a7116b064cdd4988df6791823298615009fc5b6bccbd42909b` |
| `tree-sitter-javascript.wasm` | 411770 | `5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240` |
| `tree-sitter-typescript.wasm` | 1413849 | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm` | 1445638 | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |

`src/stable/index-engine/tree-sitter-provider.mjs` verifies the runtime and grammar
sizes and loads the files from this folder. `tests/vibe/tree-sitter-provider.test.mjs`
checks these sizes and hashes. Update this table in the same commit as any asset change.

This directory is trusted configuration. The provider requires `tree-sitter.js`
from the directory it is given, so callers must never pass an untrusted path.
