// M2 B5 secret storage.
//
// Secrets live only in the Windows Credential Manager or in the process environment (see
// ARCHITECTURE.md principle 4). This module owns the Credential Manager adapter: a fixed
// PowerShell script does the P/Invoke, and the secret value is written to the child's stdin. The
// value never appears in argv, the environment, a file, a log or an error message.

import { spawn } from 'node:child_process';

export const SECRET_STORE_VERSION = 1;
export const MAX_SECRET_CHARS = 4096;
export const MAX_SECRET_ID_CHARS = 64;
export const CREDENTIAL_TARGET_PREFIX = 'Vibecodium/Provider/';
export const CREDENTIAL_USER = 'vibecodium';
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const SECRET_ID = /^[a-z][a-z0-9-]{0,63}$/;

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
// Spawn the absolute system PowerShell. Never spawn by bare name: CreateProcess searches the
// current directory before PATH, so a workspace-planted powershell.exe could receive the secret
// on stdin.
export function powershellPath(env = process.env) {
  const root = typeof env?.SystemRoot === 'string' && env.SystemRoot.length > 0
    ? env.SystemRoot
    : (typeof env?.windir === 'string' && env.windir.length > 0 ? env.windir : 'C:\\Windows');
  return root.replace(/[\\/]+$/, '') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}
const POWERSHELL = powershellPath();
const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;
const ERROR_NOT_FOUND = 1168;

export class SecretStoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
    if (Number.isInteger(extra.status)) this.status = extra.status;
  }
}

function fail(code, message, extra) {
  throw new SecretStoreError(code, message, extra);
}

export function validateSecretId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_SECRET_ID_CHARS || !SECRET_ID.test(id) ||
      RESERVED_IDS.has(id)) {
    fail('invalid-secret-id', 'secret id must be a lowercase provider identifier');
  }
  return id;
}

export function validateSecretValue(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_SECRET_CHARS) {
    fail('invalid-secret', 'a secret must be a non-empty string of at most ' + MAX_SECRET_CHARS + ' characters');
  }
  if (CONTROL_CHARS.test(value)) fail('invalid-secret', 'a secret must not contain control characters');
  if (value !== value.trim()) fail('invalid-secret', 'a secret must not start or end with whitespace');
  return value;
}

export function credentialTarget(id) {
  return CREDENTIAL_TARGET_PREFIX + validateSecretId(id);
}

// The C# type is shared by all three scripts. Only the operation body differs.
const CREDENTIAL_TYPE = [
  '$sig = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class VibeCred {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
  '  public struct CREDENTIAL {',
  '    public uint Flags; public uint Type;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
  '    public uint AttributeCount; public IntPtr Attributes;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;',
  '  }',
  '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
  '  public static extern bool CredWrite(ref CREDENTIAL cred, uint flags);',
  '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
  '  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);',
  '  [DllImport("advapi32.dll", SetLastError=true)] public static extern void CredFree(IntPtr cred);',
  '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
  '  public static extern bool CredDelete(string target, uint type, uint flags);',
  '}',
  '"@',
  'Add-Type -TypeDefinition $sig -Language CSharp',
  '$ErrorActionPreference = "Stop"',
].join('\n');

function errorReporter(errorVariable) {
  return [
    'if ($' + errorVariable + ' -ne 0) {',
    '  [Console]::Error.Write("ERR " + $' + errorVariable + ')',
    '  exit 1',
    '}',
  ].join('\n');
}

export const CREDENTIAL_MANAGER_SCRIPTS = Object.freeze({
  set: [
    CREDENTIAL_TYPE,
    '$target = [Console]::In.ReadLine()',
    '$b64 = [Console]::In.ReadLine()',
    '$bytes = [Convert]::FromBase64String($b64)',
    '$blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)',
    'try {',
    '  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)',
    '  $c = New-Object VibeCred+CREDENTIAL',
    '  $c.Type = ' + CRED_TYPE_GENERIC,
    '  $c.TargetName = $target',
    '  $c.CredentialBlobSize = [uint32]$bytes.Length',
    '  $c.CredentialBlob = $blob',
    '  $c.Persist = ' + CRED_PERSIST_LOCAL_MACHINE,
    '  $c.UserName = "' + CREDENTIAL_USER + '"',
    '  $ok = [VibeCred]::CredWrite([ref]$c, 0)',
    '  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()',
    '  if (-not $ok) {',
    '    [Console]::Error.Write("ERR " + $err)',
    '    exit 1',
    '  }',
    '  [Console]::Out.Write("ok")',
    '} finally {',
    '  [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)',
    '}',
  ].join('\n'),
  get: [
    CREDENTIAL_TYPE,
    '$target = [Console]::In.ReadLine()',
    '$ptr = [IntPtr]::Zero',
    '$ok = [VibeCred]::CredRead($target, ' + CRED_TYPE_GENERIC + ', 0, [ref]$ptr)',
    '$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()',
    'if (-not $ok) {',
    '  if ($err -eq ' + ERROR_NOT_FOUND + ') {',
    '    [Console]::Out.Write("missing")',
    '    exit 0',
    '  }',
    '  [Console]::Error.Write("ERR " + $err)',
    '  exit 1',
    '}',
    'try {',
    '  $size = [Runtime.InteropServices.Marshal]::ReadInt32($ptr, 32)',
    '  $blob = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, 40)',
    '  $bytes = New-Object byte[] $size',
    '  [Runtime.InteropServices.Marshal]::Copy($blob, $bytes, 0, $size)',
    '  [Console]::Out.Write("ok " + [Convert]::ToBase64String($bytes))',
    '} finally {',
    '  [VibeCred]::CredFree($ptr) | Out-Null',
    '}',
  ].join('\n'),
  delete: [
    CREDENTIAL_TYPE,
    '$target = [Console]::In.ReadLine()',
    '$ok = [VibeCred]::CredDelete($target, ' + CRED_TYPE_GENERIC + ', 0)',
    '$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()',
    'if (-not $ok) {',
    '  if ($err -eq ' + ERROR_NOT_FOUND + ') {',
    '    [Console]::Out.Write("missing")',
    '    exit 0',
    '  }',
    '  [Console]::Error.Write("ERR " + $err)',
    '  exit 1',
    '}',
    '[Console]::Out.Write("ok")',
  ].join('\n'),
});

function encodeScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function powershellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeScript(script)];
}

function win32Status(stderr) {
  const match = /ERR (\d+)/.exec(typeof stderr === 'string' ? stderr : '');
  return match ? Number(match[1]) : undefined;
}

export function defaultExec({ script, input, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(POWERSHELL, powershellArgs(script), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new SecretStoreError('secret-store-unavailable', 'the credential store could not be started'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let total = 0;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(() => reject(new SecretStoreError('secret-store-unavailable', 'the credential store timed out')));
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      total += chunk.length;
      if (total > maxOutputBytes) {
        try { child.kill(); } catch { /* already gone */ }
        finish(() => reject(new SecretStoreError('secret-store-unavailable', 'the credential store output exceeded its cap')));
        return;
      }
      if (target === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', () => finish(() => reject(new SecretStoreError('secret-store-unavailable', 'the credential store could not be started'))));
    child.on('close', (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
    child.stdin.on('error', () => { /* the child may exit before reading stdin */ });
    child.stdin.end(input);
  });
}

function makeStore(backend, read, write, remove) {
  return Object.freeze({
    version: SECRET_STORE_VERSION,
    backend,
    async set(id, value) {
      validateSecretId(id);
      validateSecretValue(value);
      await write(id, value);
    },
    async get(id) {
      validateSecretId(id);
      return read(id);
    },
    async has(id) {
      validateSecretId(id);
      return (await read(id)) !== null;
    },
    async delete(id) {
      validateSecretId(id);
      return remove(id);
    },
    describe: () => Object.freeze({ version: SECRET_STORE_VERSION, backend, targetPrefix: CREDENTIAL_TARGET_PREFIX }),
  });
}

export function createMemorySecretStore() {
  const values = new Map();
  return makeStore(
    'memory',
    async (id) => (values.has(id) ? values.get(id) : null),
    async (id, value) => { values.set(id, value); },
    async (id) => values.delete(id),
  );
}

export function createCredentialManagerStore(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid-options', 'credential store options must be an object');
  }
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') fail('unsupported-platform', 'the Windows Credential Manager is only available on Windows');
  const exec = options.exec ?? defaultExec;
  if (typeof exec !== 'function') fail('invalid-options', 'exec must be a function');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  async function run(script, input) {
    let result;
    try {
      result = await exec({ script, input, timeoutMs, maxOutputBytes });
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      fail('secret-store-unavailable', 'the credential store is unavailable');
    }
    if (result === null || typeof result !== 'object') {
      fail('secret-store-unavailable', 'the credential store returned an invalid result');
    }
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (result.code !== 0) {
      const status = win32Status(result.stderr);
      fail('secret-store-failed', 'the credential store rejected the operation', { status });
    }
    return stdout;
  }

  return makeStore(
    'windows-credential-manager',
    async (id) => {
      const out = await run(CREDENTIAL_MANAGER_SCRIPTS.get, credentialTarget(id) + '\n');
      if (out === 'missing') return null;
      if (!out.startsWith('ok ')) fail('secret-store-failed', 'the credential store returned an invalid answer');
      let value;
      try {
        value = Buffer.from(out.slice(3), 'base64').toString('utf8');
      } catch {
        fail('secret-store-failed', 'the credential store returned an invalid answer');
      }
      return validateSecretValue(value);
    },
    async (id, value) => {
      const payload = Buffer.from(value, 'utf8').toString('base64');
      const out = await run(CREDENTIAL_MANAGER_SCRIPTS.set, credentialTarget(id) + '\n' + payload + '\n');
      if (out !== 'ok') fail('secret-store-failed', 'the credential store returned an invalid answer');
    },
    async (id) => {
      const out = await run(CREDENTIAL_MANAGER_SCRIPTS.delete, credentialTarget(id) + '\n');
      if (out === 'missing') return false;
      if (out !== 'ok') fail('secret-store-failed', 'the credential store returned an invalid answer');
      return true;
    },
  );
}
