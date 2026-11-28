# M3 local provider host

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-27
>
> The host bridge from the first-run wizard's validated start plan to the B1 request client. The module
> lives in [local-provider.mjs](../../../src/stable/runtime/local-provider.mjs), its acceptance tests in
> [local-provider.test.mjs](../../../tests/vibe/local-provider.test.mjs). It consumes the supervisor in
> [m3-llama-server.md](m3-llama-server.md), the wizard in [m3-first-run-wizard.md](m3-first-run-wizard.md)
> and the `llama-cpp`/`ollama` presets in [m2-provider-presets.md](m2-provider-presets.md).

## Scope

This is the step the loopback-auth slice recorded as its next M3 task: the supervisor now starts the
runtime behind an API key that only `auth()` exposes, and the B1 `llama-cpp` preset is `auth: 'bearer'`,
so a host has to read that key and hand it to the client in the same turn. `createLocalProvider` does
exactly that and nothing else. It reads the wizard's start plan, starts the delivered supervisor for a
pinned plan (or adopts a selected Ollama daemon), reads the controller key through `auth()`, and returns a
frozen `llama-cpp` (or `ollama`) client. It never downloads, installs, signs, verifies or probes anything,
never renders a panel, and never writes provider configuration: the wizard supplies the verified runtime
and weights and the supervisor owns the process boundary. Node built-ins only, no dependency.

## Contract

`createLocalProvider({ wizard, policy? })` returns a frozen controller with `start()`, `stop()`,
`dispose()`, `status()`, `describe()` and `client()`. `status()` and `describe()` return the same frozen
snapshot.

| Option | Meaning | Default |
|---|---|---|
| `wizard` | plain object exposing own data methods `runtimeOptions()` and `startPlan()` (the delivered `createFirstRunWizard` result) | required |
| `policy` | optional M1 endpoint policy passed to `createProviderClient`; copied at construction into a frozen snapshot whose array options (`allowHosts`, `allowEndpoints`) are also copied and frozen, so the caller cannot widen it afterwards | `{}` (the loopback `local-model` category is allowed by default) |

The snapshot carries `version` (`1`), `state`, `kind` (`null`, `'llama-server'` or `'ollama'`), `id`
(the B1 preset id), `label`, `baseUrl`, `model` (the B1 model name), `port`, `pid` and `failure` (`null`
or a frozen `{ code, reason? }`). It never carries the API key.

| Method | Behaviour |
|---|---|
| `start()` | Single-flight. Reads `wizard.runtimeOptions()`: an unavailable hand-off fails `runtime-unavailable` with a bounded reason, a `kind: 'ollama'` hand-off builds an `ollama` client only when the validated base URL classifies as a loopback `local-model` endpoint, and a pinned hand-off starts the supervisor with the plan's supervisor options and builds a `llama-cpp` client from the started base URL, the plan's B1 `model` and `runtime.auth().apiKey`. Returns the running snapshot; a start while already running resolves to the same snapshot without spawning. |
| `stop()` | Idempotent and safe during a start (a requested stop wins over a failed start). Stops the supervisor child, clears the client and the running fields, and ends `stopped` with `failure: null`. The supervisor controller is retained so a later `start()` reuses the same validated runtime and key. |
| `dispose()` | Stops once, drops the controller and refuses every later `start()` as `disposed`. |
| `client()` | Returns the current B1 client (or `null`); the only way the host reaches the request client, and the key lives only in that client's closure. |

The pinned plan now carries the B1 model name: the wizard's `startPlan()` adds `model: chat.entry.id`
(see [m3-first-run-wizard.md](m3-first-run-wizard.md)), so the host no longer has to map the weights file
back to a provider model name. The supervisor still takes `modelPath`; the model name is only sent to the
client.

## Failures

Every failure is a `LocalProviderError` with a bounded `code`; a message never carries the key, a path, a
URL or an injected error body.

| Code | When |
|---|---|
| `invalid-options` | options are not a plain object, an unknown key is present, `wizard` lacks an own data method, or `policy` is not a plain object or holds an accessor. A live Proxy is read only through prototype and descriptor operations, so a `get` trap and a getter are never invoked, and an accessor-backed option or policy is rejected without reading the accessor. |
| `invalid-handoff` | the wizard's `runtimeOptions()` is not a plain object, or a daemon plan's base URL fails the preset validator or does not resolve to a loopback `local-model` host, or its model fails the preset validator. |
| `invalid-plan` | a pinned hand-off does not pair with a `kind: 'llama-server'` available `startPlan()`, or that plan has no usable B1 model name. |
| `runtime-unavailable` | the wizard reports `available: false`; `reason` is one of `not-ready`, `runtime-not-bundled`, `runtime-install-failed`, `disposed` or `no-embedding-model`, and anything else becomes `unavailable`. |
| `handoff-failed` | a wizard method throws; its message is never echoed. |
| `missing-api-key` | `auth()` is absent, is not a plain object, or its `apiKey` is missing, shorter than 32 or longer than 128 characters, or contains a control or bidi character. |
| `disposed` | `start()` after `dispose()`. |
| supervisor code | a supervisor failure is reported with its own bounded `code` (e.g. `startup-timeout`) when it matches `^[a-z][a-z0-9-]{0,63}$`, else `start-failed`. |

A failed start stops any child it started, clears the client, the port and the pid, and ends `failed`; a
stop requested while that start was in flight ends `stopped` with `failure: null` instead.

## Security boundary

The key never leaves the supervisor and the client. `resolveRuntimeApiKey` reads the supervisor's
`auth()` result through own data descriptors, re-checks the supervisor's own 32..128 character bound and
the control/bidi rule, and returns the string only to `createProviderClient`, which keeps it in its
closure and never returns it from `describe()`. The host snapshot, the controller, every error and a
JSON serialization of `status()`/`describe()` are key-free; the acceptance test asserts the serialized
form does not contain the key. Because the endpoint is loopback, the M1 policy is passed through
unchanged and the local category is allowed by default. A caller-supplied `policy` is snapshotted at
construction - including frozen copies of `allowHosts` and `allowEndpoints` - so a later mutation cannot
widen what the client sends. A daemon hand-off is loopback-only regardless of policy: `classifyAIEndpoint`
must report the `local-model` category and the host must be `localhost`/`*.localhost`, any address in
`127.0.0.0/8` or `::1`, so a hostile plan plus `allowExternalProviders: true` cannot point the client at a
remote host. A `wizard` is a trusted caller surface in the same class as the supervisor's
`executablePath`, and it is still read defensively.

## Residual risks

- The client is started in the same process that owns the supervisor, so a debugger or an administrator
   can read the key from memory, exactly as recorded for the supervisor.
- The bridge reads `startPlan()` a second time to obtain the B1 model name; a wizard that changes its
   plan between `runtimeOptions()` and `startPlan()` fails `invalid-plan` rather than starting a client
   for a model the runtime was not told to serve. The delivered wizard returns a frozen plan, so this is
   only reachable with an injected or misbehaving wizard.
- `*.localhost` is accepted on the RFC 6761 promise that a resolver maps it to loopback; this Windows
   target does, and a non-conforming resolver would be a deployment risk rather than a code path to a
   remote host. An IPv4-mapped loopback literal (`::ffff:127.0.0.1`) is normalised by the URL parser to
   `[::ffff:7f00:1]` and is refused, which is over-strict but fails closed.
- The host wiring is unit-tested against the loopback fixture, not a real `b12426` binary; the live
   loopback smoke with the pinned weights is still open (M3).

## Verification

`node --test tests/vibe/local-provider.test.mjs` covers: a blocked wizard fails with a bounded reason and
spawns nothing; an unknown or hostile blocked reason is bounded to `unavailable`; a non-plain or accessor-
backed wizard fails `invalid-options` without invoking the accessor; a malformed hand-off or plan fails
closed before any spawn; a throwing wizard reports `handoff-failed` without its message; a pinned plan
starts the supervisor and hands a working authenticated `llama-cpp` client whose chat, streaming, tool
calls and embeddings pass through the loopback fixture and whose snapshot and serialization are key-free;
concurrent starts spawn one child and share the result; a supervisor failure is reported with its bounded
code and leaves nothing running; a stop during a start ends `stopped` with no failure and a later start
succeeds (reusing the runtime and key); `dispose()` stops the child and refuses a later start; a selected
Ollama daemon becomes an `ollama` client without spawning or reading the supervisor plan; a daemon
hand-off with a hostile base URL or model fails closed; a private-LAN or remote daemon is refused even
with a permissive caller policy and an IPv6 loopback daemon is accepted; a caller policy is snapshotted so
a later array mutation cannot widen egress; and `resolveRuntimeApiKey` validates the supervisor key
without echoing it. The full acceptance is `node vibe/tools/verify.mjs --strict`.
