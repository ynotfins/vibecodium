import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ProviderSetupError,
  createProviderSetup,
} from '../../src/stable/gateway/provider-setup.mjs';
import {
  CREDENTIAL_MANAGER_SCRIPTS,
  SecretStoreError,
  createCredentialManagerStore,
  createMemorySecretStore,
  credentialTarget,
  powershellPath,
} from '../../src/stable/gateway/secret-store.mjs';

const SECRET = 'sk-test-2f4a9c7e-do-not-leak';
const SECOND_SECRET = 'sk-test-88b1e2aa-do-not-leak';

function fixture(t, env = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-provider-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, 'vibecodium', 'providers.json');
  const secretStore = createMemorySecretStore();
  const setup = createProviderSetup({ settingsPath, secretStore, env });
  return { root, settingsPath, secretStore, setup };
}

function customProvider(overrides = {}) {
  return {
    id: 'my-lab',
    label: 'My Lab',
    transport: 'openai-chat',
    baseUrl: 'https://lab.example/v1',
    model: 'lab-model',
    auth: 'bearer',
    apiKeyEnv: 'MY_LAB_API_KEY',
    capabilities: ['chat', 'stream'],
    ...overrides,
  };
}

function filesUnder(root) {
  const out = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function assertNoSecret(root, secret) {
  for (const file of filesUnder(root)) {
    assert.equal(readFileSync(file, 'utf8').includes(secret), false, 'a secret value reached ' + file);
  }
}

test('a provider is added and switched with no file editing, and no secret reaches a file', async (t) => {
  const { root, settingsPath, secretStore, setup } = fixture(t, { MY_LAB_API_KEY: SECRET });

  setup.addProvider(customProvider());
  const view = setup.selectProvider('my-lab');
  assert.equal(view.activeProvider, 'my-lab');
  assert.equal(view.providers.find((entry) => entry.id === 'my-lab').configured, true);
  assert.equal(view.providers.find((entry) => entry.id === 'my-lab').model, 'lab-model');

  const imported = await setup.importSecretFromEnvironment({ provider: 'my-lab', envName: 'MY_LAB_API_KEY' });
  assert.equal(imported.providers.find((entry) => entry.id === 'my-lab').secretStored, true);
  assert.equal(await setup.hasSecret('my-lab'), true);
  assert.equal(await secretStore.get('my-lab'), SECRET);

  const settings = readFileSync(settingsPath, 'utf8');
  assert.equal(settings.includes(SECRET), false);
  assert.equal(JSON.parse(settings).activeProvider, 'my-lab');
  assert.equal(JSON.parse(settings).secretProviders.includes('my-lab'), true);
  assertNoSecret(root, SECRET);
  assert.equal(JSON.stringify(setup.view()).includes(SECRET), false);
  assert.equal(JSON.stringify(setup.describe()).includes(SECRET), false);
  assert.equal(JSON.stringify(setup.settingsForClient()).includes(SECRET), false);
});

test('the env-var picker exposes names only and imports the selected value', async (t) => {
  const { setup } = fixture(t, { MY_LAB_API_KEY: SECRET, SOME_TOKEN: SECOND_SECRET, PLAIN_VALUE: 'not-a-key' });
  setup.addProvider(customProvider());

  const names = setup.envNames();
  assert.equal(names.includes('MY_LAB_API_KEY'), true);
  assert.equal(names.includes('SOME_TOKEN'), true);
  assert.equal(names.includes('PLAIN_VALUE'), false);
  for (const name of names) assert.equal(typeof name, 'string');
  assert.equal(JSON.stringify(names).includes(SECRET), false);

  await setup.importSecretFromEnvironment({ provider: 'my-lab', envName: 'SOME_TOKEN' });
  assert.equal(await setup.hasSecret('my-lab'), true);
});

test('set, clear, remove and reload behave as described', async (t) => {
  const { settingsPath, secretStore, setup } = fixture(t, {});
  setup.addProvider(customProvider());
  await setup.setSecret({ provider: 'my-lab', secret: SECRET });
  assert.equal(await setup.hasSecret('my-lab'), true);

  await setup.clearSecret({ provider: 'my-lab' });
  assert.equal(await setup.hasSecret('my-lab'), false);
  assert.equal(setup.view().providers.find((entry) => entry.id === 'my-lab').secretStored, false);

  const reloaded = createProviderSetup({ settingsPath, secretStore, env: {} });
  assert.equal(reloaded.view().providers.find((entry) => entry.id === 'my-lab').configured, true);
  assert.equal(reloaded.view().activeProvider, null);

  reloaded.selectProvider('my-lab');
  const again = createProviderSetup({ settingsPath, secretStore, env: {} });
  assert.equal(again.view().activeProvider, 'my-lab');

  await again.removeProvider('my-lab');
  assert.equal(again.view().providers.find((entry) => entry.id === 'my-lab'), undefined);
  assert.equal(again.view().activeProvider, null);
  await assert.rejects(() => again.removeProvider('omniroute'), (error) => error.code === 'built-in-provider');
});

test('malformed input, accessors, secrets in definitions and unknown providers fail closed', async (t) => {
  const { setup } = fixture(t, {});
  let invoked = false;
  const accessor = customProvider();
  Object.defineProperty(accessor, 'label', { enumerable: true, get() { invoked = true; return 'x'; } });
  assert.throws(() => setup.addProvider(accessor), (error) => error.code === 'invalid-input');
  assert.equal(invoked, false);

  assert.throws(() => setup.addProvider(customProvider({ id: 'Bad Id' })), (error) => error.code === 'invalid-provider');
  assert.throws(() => setup.addProvider({ ...customProvider(), secret: SECRET }), (error) => error.code === 'secret-not-allowed');
  assert.throws(() => setup.addProvider({ ...customProvider(), apiKey: SECRET }), (error) => error.code === 'secret-not-allowed');
  assert.throws(() => setup.addProvider({ ...customProvider(), capabilities: [] }), (error) => error.code === 'invalid-capabilities');
  assert.throws(() => setup.selectProvider('missing-provider'), (error) => error.code === 'unknown-provider');
  await assert.rejects(() => setup.setSecret({ provider: 'missing-provider', secret: SECRET }), (error) => error.code === 'unknown-provider');
  await assert.rejects(() => setup.setSecret({ provider: 'omniroute', secret: 'line\nbreak' }), (error) => error.code === 'invalid-secret');
  await assert.rejects(() => setup.setSecret({ provider: 'omniroute', secret: '  padded  ' }), (error) => error.code === 'invalid-secret');
  await assert.rejects(
    () => setup.importSecretFromEnvironment({ provider: 'omniroute', envName: 'lowercase' }),
    (error) => error.code === 'invalid-env-name',
  );
  await assert.rejects(
    () => setup.importSecretFromEnvironment({ provider: 'omniroute', envName: 'MISSING_KEY' }),
    (error) => error.code === 'missing-environment-variable',
  );
});

test('a corrupt settings file and a settings file with a secret are rejected', (t) => {
  const { root, settingsPath } = fixture(t, {});
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, '{ not json');
  assert.throws(
    () => createProviderSetup({ settingsPath, secretStore: createMemorySecretStore(), env: {} }),
    (error) => error.code === 'settings-corrupt',
  );
  writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    activeProvider: null,
    providers: { 'my-lab': { ...customProvider(), secret: SECRET } },
    secretProviders: [],
  }));
  assert.throws(
    () => createProviderSetup({ settingsPath, secretStore: createMemorySecretStore(), env: {} }),
    (error) => error.code === 'secret-not-allowed',
  );
});

test('createClient hands the stored key to the B1 client without exposing it', async (t) => {
  const { setup } = fixture(t, {});
  setup.addProvider(customProvider());
  await assert.rejects(
    () => setup.createClient('my-lab', { fetch: async () => ({ status: 200, ok: true }) }),
    (error) => error.code === 'missing-secret',
  );
  await setup.setSecret({ provider: 'my-lab', secret: SECRET });
  const client = await setup.createClient('my-lab', { fetch: async () => ({ status: 200, ok: true }) });
  assert.equal(typeof client.chat, 'function');
  assert.equal(JSON.stringify(client.describe()).includes(SECRET), false);
  assert.equal(JSON.stringify(client.config).includes(SECRET), false);
  assert.equal(client.config.model, 'lab-model');
});

test('createClient accepts a key from the configured environment variable', async (t) => {
  const { root, setup } = fixture(t, { MY_LAB_API_KEY: SECRET });
  setup.addProvider(customProvider());
  let authorization = null;
  const client = await setup.createClient('my-lab', {
    policy: { allowExternalProviders: true },
    fetch: async (_url, init) => {
      authorization = init.headers.authorization;
      const text = JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: (async function* () { yield Buffer.from(text, 'utf8'); })(),
      };
    },
  });
  const answer = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(answer.text, 'ok');
  assert.equal(authorization, 'Bearer ' + SECRET);
  assert.equal(JSON.stringify(client.describe()).includes(SECRET), false);
  assert.equal(JSON.stringify(client.config).includes(SECRET), false);
  assertNoSecret(root, SECRET);
});

test('the credential store spawns the absolute system PowerShell, not a bare name', () => {
  const fromSystemRoot = powershellPath({ SystemRoot: 'C:\\Windows' });
  assert.equal(fromSystemRoot, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(path.win32.isAbsolute(fromSystemRoot), true);
  assert.equal(
    powershellPath({ windir: 'D:\\Win\\' }),
    'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(powershellPath({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('the credential manager adapter speaks the fixed protocol and keeps the secret on stdin', async (t) => {
  const calls = [];
  let stored = null;
  const exec = async ({ script, input }) => {
    calls.push({ script, input });
    if (script === CREDENTIAL_MANAGER_SCRIPTS.set) {
      const lines = input.split('\n');
      assert.equal(lines[0], credentialTarget('my-lab'));
      stored = Buffer.from(lines[1], 'base64').toString('utf8');
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    if (script === CREDENTIAL_MANAGER_SCRIPTS.get) {
      assert.equal(input.trim(), credentialTarget('my-lab'));
      return stored === null
        ? { code: 0, stdout: 'missing', stderr: '' }
        : { code: 0, stdout: 'ok ' + Buffer.from(stored, 'utf8').toString('base64'), stderr: '' };
    }
    if (script === CREDENTIAL_MANAGER_SCRIPTS.delete) {
      const existed = stored !== null;
      stored = null;
      return { code: 0, stdout: existed ? 'ok' : 'missing', stderr: '' };
    }
    throw new Error('unexpected script');
  };

  const store = createCredentialManagerStore({ exec, platform: 'win32' });
  assert.equal(store.backend, 'windows-credential-manager');
  assert.equal(await store.get('my-lab'), null);
  await store.set('my-lab', SECRET);
  assert.equal(await store.get('my-lab'), SECRET);
  assert.equal(await store.has('my-lab'), true);
  assert.equal(await store.delete('my-lab'), true);
  assert.equal(await store.delete('my-lab'), false);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.script.includes(SECRET), false, 'the secret must not be in the script');
  }
  assert.equal(JSON.stringify(store.describe()).includes(SECRET), false);
});

test('the credential manager adapter maps OS failures without leaking the secret', async (t) => {
  const failing = createCredentialManagerStore({
    platform: 'win32',
    exec: async () => ({ code: 1, stdout: '', stderr: 'ERR 1312' }),
  });
  await assert.rejects(() => failing.set('my-lab', SECRET), (error) => {
    assert.equal(error.code, 'secret-store-failed');
    assert.equal(error.status, 1312);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  const unavailable = createCredentialManagerStore({
    platform: 'win32',
    exec: async () => { throw new Error('spawn failed'); },
  });
  await assert.rejects(() => unavailable.get('my-lab'), (error) => error.code === 'secret-store-unavailable');
  assert.throws(
    () => createCredentialManagerStore({ platform: 'linux' }),
    (error) => error.code === 'unsupported-platform',
  );
  await assert.rejects(() => failing.set('Bad Id', SECRET), (error) => error.code === 'invalid-secret-id');
  await assert.rejects(() => failing.set('my-lab', 'a'.repeat(5000)), (error) => error.code === 'invalid-secret');
});

test('the PowerShell credential scripts parse', (t) => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' });
  if (pwsh.status !== 0) {
    t.skip('pwsh is not available');
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-cred-scripts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, script] of Object.entries(CREDENTIAL_MANAGER_SCRIPTS)) {
    const file = path.join(root, name + '.ps1');
    writeFileSync(file, script);
    const command = "$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('" +
      file.replace(/'/g, "''") + "',[ref]$null,[ref]$e); $e.Count";
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    assert.equal(result.stdout.trim(), '0', name + ': ' + result.stdout + result.stderr);
  }
});

test('the real Windows credential store round-trips when the host has a logon session', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows only');
    return;
  }
  const store = createCredentialManagerStore();
  try {
    await store.set('vibe-probe', SECRET);
  } catch (error) {
    if (error instanceof SecretStoreError && (error.status === 1312 || error.code === 'secret-store-unavailable')) {
      t.skip('the sandbox has no logon session for the Credential Manager (ERROR_NO_SUCH_LOGON_SESSION)');
      return;
    }
    throw error;
  }
  t.after(async () => {
    try { await store.delete('vibe-probe'); } catch { /* best effort */ }
  });
  assert.equal(await store.get('vibe-probe'), SECRET);
  assert.equal(await store.delete('vibe-probe'), true);
});
