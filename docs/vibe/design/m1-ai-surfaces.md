# M1 A2: Native AI surfaces without Copilot

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-24

This design records how Vibecodium enables the native VS Code AI surfaces — chat, inline chat, the Agents window, sessions and checkpoints — on a clean profile with no user-installed GitHub Copilot extension and no GitHub sign-in. It is the M1 A2 slice; model and provider wiring is M2.

## Decision

The workbench already ships the AI surfaces. What blocks them on a clean profile is the upstream product descriptor: `defaultChatAgent` points at GitHub Copilot, and Copilot appears in trusted-auth and built-in/proposal lists. Vibecodium replaces that descriptor at package time with one owned by the built-in `vibecodium.vibecodium-ai` extension and removes Copilot from the product wiring. The AI surfaces then open without installing, signing in to, or contacting GitHub Copilot.

Two small workbench strings also assumed Copilot: the default agent name carried a `` ` Copilot` `` suffix, and the setup banner told the user to set up GitHub Copilot. The branding patch now removes the suffix and points at a model provider instead.

## Product transform

`src/stable/security/ai-surfaces.mjs` is a dependency-free, pure transform:

- `applyAISurfaces(product)` returns a new product object and never mutates its input.
- `defaultChatAgent` becomes `VIBECODIUM_CHAT_AGENT`: extension and provider ids point at `vibecodium.vibecodium-ai`, the default provider is `vibecodium`, and every runtime endpoint uses `https://vibecodium.invalid`. `.invalid` is reserved by RFC 2606 and can never resolve, so a stray request fails fast instead of reaching a third party.
- `GitHub.copilot*` entries are removed from `trustedExtensionAuthAccess` (including per-provider arrays), `builtInExtensionsEnabledWithAutoUpdates`, `extensionsEnabledWithApiProposalVersion` and from the keys of `extensionEnabledApiProposals`; each removal applies only where that key or list exists.
- `findCopilotReferences(product)` reports any remaining GitHub Copilot key, extension id or URL by path. Third-party extensions whose ids merely contain "copilot" are out of scope; this slice removes the Copilot product wiring, not unrelated marketplace entries.
- Applying the transform to its own output produces an equivalent object, so rerunning it is safe.

`vibe/tools/apply-ai-surfaces.mjs` is the build CLI:

```bash
node vibe/tools/apply-ai-surfaces.mjs --product product.json
node vibe/tools/apply-ai-surfaces.mjs --product product.json --check
```

`--check` reports `unchanged` without writing, exits 1 when the file would change, and also exits 1 when a Copilot reference remains.

`prepare_vscode.sh` runs the transform right after it merges the Vibecodium `product.json` overlay and before it applies the source patches. That ordering matters: the transform sees the merged product, and the patch layer still applies to a branded source tree.

## Extension defaults

`src/stable/extensions/vibecodium-ai/package.json` contributes configuration defaults that keep the native surfaces on and the sign-in prompts off:

- `chat.disableAIFeatures: false`
- `chat.titleBar.signIn.enabled: false`
- `chat.welcomePage.signIn.enabled: false`

Installed VS Code 1.135 predates `chat.welcomePage.signIn.enabled`, so the extension also registers that setting with `default: false`. Newer builds such as 1.143 know the setting natively. This keeps the default meaningful on both hosts.

## Acceptance

`tests/vibe/ai-surfaces.test.mjs` covers the transform (replacement, Copilot removal, no mutation, idempotence), the reference finder, rejection of non-object input, the extension defaults, the `prepare_vscode.sh` ordering, and the CLI update-then-check round trip. `tests/vibe/ai-surfaces-branding.test.mjs` asserts that the branding patch removes the Copilot agent-name suffix and setup wording, that every runtime endpoint stays on the reserved host, and that array-shaped trusted-auth entries are cleaned.

`tests/vibe/ai-surfaces-ide.test.mjs` drives a real extension host with a throwaway profile and the extension under development. `src/stable/extensions/vibecodium-ai/src/ai-surfaces-ide-runner.test.cjs` then asserts that:

- the three chat settings resolve to the expected values;
- no user-installed `GitHub.copilot*` extension is loaded (a stock host's built-in is reported, even if active, and is not treated as product wiring);
- chat open, inline chat, the Agents window, a new-chat/session command and checkpoint restore commands exist;
- opening chat does not create a GitHub authentication session.

The new-chat command is accepted as either `workbench.action.sessions.newChat` (1.143) or `workbench.action.newChatWindow` (1.135).

`src/stable/extensions/vibecodium-ai/src/copilot-extensions.cjs` classifies the host's extension list: a Copilot entry inside the throwaway profile's extensions directory is a finding; a host's built-in is not, even when active. `tests/vibe/ai-surfaces-copilot-classification.test.mjs` unit-tests that split, including the fail-closed case where no user extensions directory is supplied. The helper is test-only and never required by the extension at runtime. `.vscodeignore` excludes it from VSIX packaging; the built-in extension directory is copied wholesale into the app, so the file may be present there but is inert.

## Boundaries

- The built `Vibecodium.exe` cannot start on this workstation because its folder ACL lacks an `ALL APPLICATION PACKAGES` entry; the IDE acceptance therefore uses the installed VS Code host. A rebuilt-app smoke remains M12.
- The installed host runs its own `product.json`, so the IDE test proves the surfaces and the extension defaults, not the transformed product at runtime. The transform is unit-tested; proving it in a rebuilt app is M12 evidence.
- The installed VS Code host bundles a built-in GitHub Copilot extension. The IDE test disables it with `--disable-extension`, the runner reports its id and active state, and the classifier asserts it is not user-installed. The stock host may still activate it; that is host wiring, not product wiring. The product transform still removes GitHub Copilot from the built product.
- Worktree creation is part of the host's Agents/session surface. The runner does not assert a separate worktree command because that command id is host-version-specific; real worktree operation belongs to the M6/M8 agent-harness work.
- This slice does not wire models, providers, routing, Bifrost, a local runtime, next-edit, live workspace/index binding or the installer smoke. Those are M2, M3, M6/M7 and M12 work.
- No dependency, secret, network call or release artifact is added. The transform only rewrites the prepared product file.
