# M1 A2: Native AI surfaces without Copilot

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-24

This design records how Vibecodium enables the native VS Code AI surfaces — chat, inline chat, the Agents window, sessions and checkpoints — on a clean profile with no user-installed GitHub Copilot extension and no GitHub sign-in. The stock VS Code host still bundles Copilot Chat; the built product removes that folder. It is the M1 A2 slice; model and provider wiring is M2.

## Decision

The workbench already ships the AI surfaces. What blocks them on a clean profile is the upstream product descriptor: `defaultChatAgent` points at GitHub Copilot, and Copilot appears in trusted-auth, extension and API-proposal lists. Vibecodium replaces that descriptor at package time with one owned by the built-in `vibecodium.vibecodium-ai` extension and removes Copilot from the product wiring. In the built product the surfaces then open without installing or signing in to GitHub Copilot. The stock host used for IDE acceptance still runs its own agent-host process, so runtime proof of the transformed product remains the M12 rebuilt-app smoke.

Two small workbench strings also assumed Copilot: the default agent name carried a `` ` Copilot` `` suffix, and the setup banner told the user to set up GitHub Copilot. The branding patch now removes the suffix and points at a model provider instead.

## Product transform

`src/stable/security/ai-surfaces.mjs` is a dependency-free, pure transform:

- `applyAISurfaces(product)` returns a new product object and never mutates its input.
- `defaultChatAgent` becomes `VIBECODIUM_CHAT_AGENT`: extension and provider ids point at `vibecodium.vibecodium-ai`, the default provider is `vibecodium`, and every runtime endpoint uses `https://vibecodium.invalid`. `.invalid` is reserved by RFC 2606 and can never resolve, so a stray request fails fast instead of reaching a third party.
- Every Copilot-branded entry (any publisher; string, id object or key) is removed from the owned sections: `defaultChatAgent` is replaced, and `trustedExtensionAuthAccess` (including per-provider arrays), `builtInExtensions` (object-shaped entries are matched by their `name`), `builtInExtensionsEnabledWithAutoUpdates`, `extensionsEnabledWithApiProposalVersion`, `extensionRecommendations`, `sessionsWindowAllowedExtensions` and `extensionEnabledApiProposals`, `extensionProperties`, `extensionsForceVersionByQuality`, `languageExtensionTips`, `exeBasedExtensionTips`, `remoteDefaultExtensionsIfInstalledLocally`, `chatSessionRecommendations`, `inheritAuthAccountPreference` and `extensionConfigurationPolicy` are filtered recursively; each removal applies only where that key or list exists. Only two inert stores are left alone: the gallery telemetry SKU names (`extensionsGallery.accessSKUs`) and the workspace-trust copy that mentions Copilot in a translated string. Neither loads nor authorizes an extension. The transformer skips `__proto__`, `constructor` and `prototype` keys and throws above 64 nesting levels so a hostile product file cannot pollute a prototype or exhaust the stack.
- `findCopilotReferences(product)` reports any remaining Copilot key, id or URL by path, but only inside the owned sections. That scope is deliberate: a real merged product carries two inert Copilot stores elsewhere (the gallery telemetry SKU names and the workspace-trust copy), and a global check would have failed the build for metadata that changes no behaviour. The previous unscoped version reported 27 residual references on a merged stock product; the scoped version reports zero.
- Applying the transform to its own output produces an equivalent object, so rerunning it is safe.

`vibe/tools/apply-ai-surfaces.mjs` is the build CLI:

```bash
node vibe/tools/apply-ai-surfaces.mjs --product product.json
node vibe/tools/apply-ai-surfaces.mjs --product product.json --check
```

`--check` reports `unchanged` without writing, exits 1 when the file would change, and also exits 1 when a Copilot reference remains in the owned sections.

`prepare_vscode.sh` runs the transform right after it merges the Vibecodium `product.json` overlay and before it applies the source patches. That ordering matters: the transform sees the merged product, and the patch layer still applies to a branded source tree.

## Extension defaults

`src/stable/extensions/vibecodium-ai/package.json` contributes configuration defaults that keep the native surfaces on and the sign-in prompts off:

- `chat.disableAIFeatures: false`
- `chat.titleBar.signIn.enabled: false`
- `chat.welcomePage.signIn.enabled: false`

Installed VS Code 1.135 predates `chat.welcomePage.signIn.enabled`, so the extension also registers that setting with `default: false`. Newer builds such as 1.143 know the setting natively. This keeps the default meaningful on both hosts.

## Acceptance

`tests/vibe/ai-surfaces.test.mjs` covers the transform (replacement, Copilot removal from string and object lists, no mutation, idempotence), applying the transform to the repository's real `product.json` overlay, the reference finder, rejection of non-object input, the extension defaults, the `prepare_vscode.sh` ordering, and the CLI update-then-check round trip. `tests/vibe/ai-surfaces-branding.test.mjs` asserts that the branding patch removes the Copilot agent-name suffix and setup wording, that every runtime endpoint stays on the reserved host, and that array-shaped trusted-auth entries are cleaned.

`tests/vibe/ai-surfaces-ide.test.mjs` drives a real extension host with a throwaway profile and the extension under development. `src/stable/extensions/vibecodium-ai/src/ai-surfaces-ide-runner.test.cjs` then asserts that:

- the three chat settings resolve to the expected values;
- the throwaway profile loads no user-installed Copilot-branded extension (the test disables the stock host's built-ins by exact id, asserts an empty user-installed list and prints `AI_SURFACES_USER_COPILOT_IDS=`, `AI_SURFACES_COPILOT_IDS=`, `AI_SURFACES_PROBE_DETECTED=` and `AI_SURFACES_EXT_COUNT=` as human-readable evidence; the runner also writes a JSON report to the path in `VIBECODIUM_AI_SURFACES_REPORT`, which the test asserts on so interleaved stdout cannot drop the evidence); a stock host may still list or load its own bundled Copilot Chat, which is host wiring, not a profile install;
- chat open, inline chat, the Agents window, a new-chat/session command and checkpoint restore commands exist;
- opening chat does not create a GitHub authentication session.

The new-chat command is accepted as either `workbench.action.sessions.newChat` (1.143) or `workbench.action.newChatWindow` (1.135).

`src/stable/extensions/vibecodium-ai/src/copilot-extensions.cjs` classifies the host's extension list: a Copilot entry inside the throwaway profile's extensions directory is a user-installed finding; a host's built-in is classified separately. The IDE runner then asserts the user-installed list is empty for acceptance while allowing the host's bundled entry to be reported, and plants a synthetic `GitHub.copilot-probe` in the same assertion so the check fails on a dead classifier. `tests/vibe/ai-surfaces-copilot-classification.test.mjs` unit-tests the split, including the fail-closed case where no user extensions directory is supplied. The helper is test-only and never required by the extension at runtime. `.vscodeignore` excludes it from VSIX packaging; the built-in extension directory is copied wholesale into the app, so the file may be present there but is inert.

## Boundaries

- The built `Vibecodium.exe` cannot start on this workstation because its folder ACL lacks an `ALL APPLICATION PACKAGES` entry; the IDE acceptance therefore uses the installed VS Code host. A rebuilt-app smoke remains M12.
- The installed host runs its own `product.json`, so the IDE test proves the surfaces and the extension defaults, not the transformed product at runtime. The transform is unit-tested; proving it in a rebuilt app is M12 evidence.
- The installed VS Code host bundles a built-in GitHub Copilot extension. The IDE test disables its exact ids (`GitHub.copilot`, `GitHub.copilot-chat`, `GitHub.copilot-nightly`) and asserts only that the throwaway profile has no user-installed Copilot-branded entry; the stock host can still list or activate its bundled copy, so that host is not required to load nothing. The throwaway profile's extensions directory is created empty, so the user-installed list is empty by construction; the runner proves the classifier is wired to that directory and that the planted probe is detected, not that the owner's normal VS Code profile is clean. The shipped product's guarantee comes from the transform and the removed folder. The stock host's core agent-host process may still run because it ships inside the host; proving the transformed product at runtime remains the M12 rebuilt-app smoke. The product transform removes every Copilot-branded entry from the owned descriptor sections, and the build's upstream patches (`patches/52-ext-copilot-remove-it.json`, `patches/53-ext-copilot-remove-it.patch`) delete the bundled `extensions/copilot` folder, so the built product is expected to ship no Copilot extension; a rebuilt app proves it.
- Worktree creation is part of the host's Agents/session surface. The runner does not assert a separate worktree command because that command id is host-version-specific; real worktree operation belongs to the M6/M8 agent-harness work.
- This slice does not wire models, providers, routing, Bifrost, a local runtime, next-edit, live workspace/index binding or the installer smoke. Those are M2, M3, M6/M7 and M12 work.
- No dependency, secret, network call or release artifact is added. The transform only rewrites the prepared product file.
