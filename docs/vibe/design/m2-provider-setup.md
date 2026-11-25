# M2 B5 provider setup panel and OS secret storage

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-25
>
> The point-and-click provider setup service and panel. The service lives in
> [provider-setup.mjs](../../../src/stable/gateway/provider-setup.mjs), the panel in
> [provider-setup.cjs](../../../src/stable/extensions/vibecodium-ai/src/provider-setup.cjs), and the
> secret store in [secret-store.mjs](../../../src/stable/gateway/secret-store.mjs). Acceptance
> tests: [provider-setup.test.mjs](../../../tests/vibe/provider-setup.test.mjs) and
> [provider-setup-panel.test.mjs](../../../tests/vibe/provider-setup-panel.test.mjs).

## Scope

B5 needs a provider to be added and switched from a panel without editing a file, an environment
variable picker for the key, and every secret in OS secret storage or the process environment
only. This slice delivers the setup service, the extension panel and the Windows Credential
Manager adapter. It does not call a live provider, validate a key against a provider, start
Bifrost, change the routing policy or deliver the B6 direct-provider features.

## Settings and secrets

The setup service owns a non-secret settings file at the `settingsPath` the caller supplies
(`SETTINGS_FILE` is the conventional `providers.json` name; the M6 wiring will pass
`<globalStorage>/providers.json`) and a secret store:

```json
{
   "version": 1,
   "activeProvider": "my-lab",
   "providers": { "my-lab": { "label": "My Lab", "transport": "openai-chat" } },
   "secretProviders": ["my-lab"]
}
```

`providers` holds B1 preset definitions only. `secretProviders` records which provider ids have a
stored key, never the key. The file is written atomically with a 0600 mode, and a provider
definition that contains `secret`, `apiKey`, `api_key`, `token` or `password` is rejected on load
and on add. Provider ids are the only secret-store metadata that reaches the file.

The secret store contract is `set(id, value)`, `get(id)`, `has(id)`, `delete(id)` and `describe()`.
`createMemorySecretStore()` is for tests. `createCredentialManagerStore()` uses the Windows
Credential Manager through a fixed PowerShell P/Invoke script:

- the target is `Vibecodium/Provider/<provider-id>` and the user name is `vibecodium`;
- the secret is base64 on the child's stdin, never in argv, the environment, a file or a log;
- the child is the absolute system `powershell.exe` under `%SystemRoot%`, never a bare name
   resolved through the current directory or PATH, so a workspace cannot shadow it;
- the script is a constant exported as `CREDENTIAL_MANAGER_SCRIPTS`, so a test can parse it;
- a missing entry is `null` (or `false` for delete), a Win32 failure raises
   `secret-store-failed` with the numeric `status`, and an unavailable host raises
   `secret-store-unavailable`.

`createClient(id, options)` reads the stored key at use time; when no key is stored it falls back
to the provider's configured environment variable, and it constructs the B1 client inside the
service, so no API returns a secret value.

## Panel contract

`createProviderSetupController({ vscode, setupProvider, extensionUri })` follows the graph and
memory panels: the extension injects the setup service and the panel renders a webview.

| Message | Effect |
|---|---|
| `selectProvider` | set the active provider |
| `addProvider` | validate and persist a provider definition |
| `setSecret` | store a key in the secret store |
| `importSecret` | read the selected environment variable and store it |
| `clearSecret` | delete the stored key |
| `removeProvider` | remove a custom provider (a built-in is refused) |
| `refresh` | re-render |

The panel lists the catalog, marks the active provider, shows whether a key is stored, and offers
environment-variable names (never values) as the key picker. Adding a provider and selecting an
import variable in the same submit adds the provider and then stores that variable's value. Errors
are bounded and never echo a secret, and a message larger than 64 KiB is refused.

The extension exposes the panel through `vibecodium.providers.open` and accepts a setup service
through `vibecodium.providers.setSetup`; the workbench does not inject one yet, so the command
reports that setup is not connected until M6 wiring lands.

## Verification

`node --test tests/vibe/provider-setup.test.mjs tests/vibe/provider-setup-panel.test.mjs` covers
add, switch, import, clear and remove; reload from disk; accessor and malformed-input rejection;
an env-only key that reaches the Authorization header without being stored; secret non-exposure in
the settings file, the view, `describe()`, the panel HTML and errors; the adapter protocol with a
fake backend; failure mapping; and a PowerShell parse of every script.

The real-OS round-trip test skips when the host returns `ERROR_NO_SUCH_LOGON_SESSION` (1312). That
is the current agent sandbox: it runs with a restricted token, so `CredWrite`/`CredRead` fail even
though `cmdkey` can add an entry. A normal desktop session has a logon session and the test runs.
The same restriction is why the built `Vibecodium.exe` cannot start from this host (M12).
