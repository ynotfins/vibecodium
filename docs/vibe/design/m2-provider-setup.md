# M2 B5 point-and-click provider setup

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-25
>
> The provider setup model and webview live in
> [provider-setup.cjs](../../../src/stable/extensions/vibecodium-ai/src/provider-setup.cjs), and
> their acceptance tests live in
> [provider-setup.test.mjs](../../../tests/vibe/provider-setup.test.mjs) and
> [provider-setup-ide.test.mjs](../../../tests/vibe/provider-setup-ide.test.mjs).

## Scope

B5 requires a point-and-click way to add and switch an AI provider without hand-editing a
settings file, and it requires that the credential never leaves OS secret storage. This slice
delivers the built-in extension's provider setup model, its webview, the extension commands that
open it, and a real extension-host acceptance. It consumes the B1 catalog as-is.

The panel is not yet connected to live gateway calls in the workbench, Bifrost has no supervisor,
and there is no live-provider smoke test. Those remain M6 and later M2 integration work. B6's
direct-provider parity and free-form base-URL entry are also out of scope.

## Setup contract

`createProviderSetupModel({ secretStorage, environmentNames, presets, document })` validates all
inputs before use. The model owns four non-secret values: the ordered provider list, each entry's
chosen model and environment-variable name, the active provider, and each entry's
transport/auth/base-URL fingerprint copied from the validated B1 catalog. Preset labels,
transports, base URLs, auth modes, capabilities and local flags come from the catalog; a user
cannot invent one, and the fingerprint can only match the catalog value approved at add time.

The non-secret document is small and JSON-safe:

```json
{
   "version": 1,
   "activeProvider": "morph",
   "providers": [
      { "id": "morph", "label": "Morph", "model": "chosen-model", "apiKeyEnv": "MORPH_API_KEY", "transport": "openai-chat", "auth": "bearer", "baseUrl": "https://api.morphllm.com/v1" }
   ]
}
```

On load, every saved entry's `transport`, `auth`, `baseUrl` and `baseUrlEnv` must equal the current
catalog entry; otherwise the document fails closed as `invalid-document`. Reloading a stored
provider against a catalog that retargets its endpoint or auth mode therefore cannot silently
redirect the credential.

`toProviderSettings()` turns that document into the B1 settings-JSON override shape, and the
existing B1 validator and client accept it. The view reports each preset, each configured provider,
the active provider, `hasSecret`, a credential source (`secret-storage`, `environment` or `none`),
and environment-variable **names** only. It never carries a credential value.

## Credentials

The extension uses `context.secrets` (VS Code `SecretStorage`) as the only write path for a
credential. The key is `vibecodium.provider.<id>.apiKey`. The model resolves the three required
methods through data descriptors on the object or its prototype, so a real class-backed
`SecretStorage` works, while an accessor-backed fake fails closed without invoking the getter.

Adding, removing or forgetting a provider and saving a key are the only credential operations.
Removal deletes the stored key. The document, the view, an error, `describe()` and the rendered
HTML never contain the secret; a secret-store failure reports a bounded
`secret-store-unavailable` code and drops the underlying error text. The extension host
acceptance scans its throwaway profile for the planted test secret and fails if any file contains
it.

## Panel

The `Vibe Providers` webview is opened by `vibecodium.providers.open`. At activation the extension
loads the B1 preset catalog directly; the only public command is `vibecodium.providers.open`. It
lists the ten B1 presets, a model input, an environment-variable picker and a password field. A
shared message path handles add, select, remove, forget-key and save-key; the same path is used by
the extension API and by the webview.
The HTML uses a per-render nonce and a deny-by-default content security policy, and escapes every
value it renders.

`createProviderSetupController` validates a replacement catalog before swapping it in, so a
malformed or provider-dropping catalog leaves the previous catalog and document intact. It also
rejects a catalog that changes a configured provider's transport, auth mode, base URL or base URL
variable, so a catalog refresh cannot retarget an existing endpoint. Message types are read only
through own data descriptors.

## Verification

`node --test tests/vibe/provider-setup.test.mjs` uses the real B1 catalog and a stand-in secret
store. It covers the preset list, add/select/remove, B1 settings round-trip, client creation with
the stored key, secret non-exposure, prototype-backed secret storage, accessor-backed rejection,
catalog failure, malformed documents and the model/secret caps.

`node --test src/stable/extensions/vibecodium-ai/src/extension-contract.test.cjs` covers the
registered commands and the shared panel path with a fake extension context.

`VIBECODIUM_APP_PATH="<Code.exe>" node --test tests/vibe/provider-setup-ide.test.mjs` loads
`vibecodium.vibecodium-ai` in a real extension host, adds and switches providers, stores a secret,
reopens the panel and confirms persistence. Where the built `Vibecodium.exe` cannot start under
this host ACL, the acceptance uses the installed VS Code extension host; a rebuilt-app smoke
remains M12.

`node vibe/tools/verify.mjs --strict` and `node vibe/tools/docs-check.mjs --strict` remain the
repository acceptance commands.
