// M3 local llama-server supervisor.
//
// Starts, health-checks and stops the caller-supplied llama.cpp `llama-server` as a direct child,
// with no shell. Everything the supervisor needs is validated first: the executable and the model
// must be real, non-symlink files at absolute local paths, the bind address is fixed to loopback,
// the port and the runtime limits are bounded, and the child environment is a small allowlist
// instead of the full process environment. The module performs one health request and otherwise
// keeps no network state; chat, embeddings and infill calls go through `provider-client.mjs`.

import { spawn } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const RUNTIME_MODULE_VERSION = 1;
export const LOOPBACK_HOST = ['127', '0', '0', '1'].join('.');
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
export const MIN_CONTEXT_SIZE = 1;
export const MAX_CONTEXT_SIZE = 1_048_576;
export const MIN_THREADS = 1;
export const MAX_THREADS = 256;
export const MIN_GPU_LAYERS = 0;
export const MAX_GPU_LAYERS = 1_000;
export const MIN_STARTUP_TIMEOUT_MS = 50;
export const MAX_STARTUP_TIMEOUT_MS = 120_000;
export const MIN_HEALTH_INTERVAL_MS = 10;
export const MAX_HEALTH_INTERVAL_MS = 10_000;
export const MIN_STOP_TIMEOUT_MS = 50;
export const MAX_STOP_TIMEOUT_MS = 30_000;
export const MAX_PATH_CHARS = 4096;
export const MAX_COMMAND_ARG_CHARS = 1024;
export const MAX_COMMAND_ARGS = 16;
export const MAX_ENV_KEYS = 32;
export const MAX_ENV_VALUE_CHARS = 4096;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_HEALTH_INTERVAL_MS = 100;
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;
export const HEALTH_TIMEOUT_MS = 2_000;
export const MAX_CHILD_OUTPUT_CHARS = 16_384;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const RESERVED_SERVER_ARGS = new Set(['--host', '--port']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPTION_KEYS = new Set([
  'executablePath', 'commandArgs', 'modelPath', 'port', 'contextSize', 'threads', 'gpuLayers',
  'startupTimeoutMs', 'healthIntervalMs', 'stopTimeoutMs', 'env', 'fetch',
]);
const ARG_KEYS = new Set(['modelPath', 'port', 'contextSize', 'threads', 'gpuLayers']);
const COPIED_ENV_KEYS = Object.freeze(
  process.platform === 'win32'
    ? ['SystemRoot', 'TEMP', 'TMP']
    : ['TMPDIR', 'LANG', 'LC_ALL'],
);
// Environment names that change how a child loads code or where the system resolves libraries.
// A caller override must not be able to redirect them; the comparison is case-insensitive because
// Windows environment names are case-insensitive.
const DENIED_ENV_KEYS = new Set([
  'node_options', 'node_path', 'ld_preload', 'ld_audit', 'ld_library_path',
  'dyld_insert_libraries', 'dyld_library_path', 'dyld_framework_path',
  'dyld_fallback_library_path', 'dyld_fallback_framework_path', 'systemroot',
  'ggml_backend_path',
]);
const DENIED_ENV_PREFIXES = Object.freeze(['llama_arg_']);
const DENIED_SERVER_ARGS = new Set(['-ag']);
const DENIED_SERVER_ARG_PREFIXES = Object.freeze([
  '--reuse-port', '--agent', '--tools', '--mcp-', '--ui-agent', '--ui-mcp-proxy',
]);
const MAX_ENV_NAME_CHARS = 64;
const MAX_ENV_TOTAL_CHARS = 32_768;

export class LlamaServerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LlamaServerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LlamaServerError(code, message);
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

// Reads own data descriptors once so an accessor is rejected without being invoked and a polluted
// prototype cannot contribute a key.
function readOwnData(value, label, allowed) {
  if (!isPlainObject(value)) fail('invalid-options', label + ' must be a plain object');
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-options', label + ' cannot be enumerated');
  }
  if (keys.length > allowed.size) fail('invalid-options', label + ' has too many keys');
  const out = Object.create(null);
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) fail('invalid-options', label + ' has a reserved key');
    if (!allowed.has(key)) fail('invalid-options', label + ' has an unknown key');
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail('invalid-options', label + ' has an unsafe property');
    }
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      fail('invalid-options', label + ' must contain data properties only');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function isAbsoluteLocalPath(value) {
  if (process.platform === 'win32') {
    if (value.startsWith('\\\\') || value.startsWith('//')) return false;
    return /^[A-Za-z]:[\\/]/.test(value) && value.length > 3;
  }
  return path.isAbsolute(value) && !value.startsWith('//');
}

function segments(value) {
  return value.split(/[\\/]+/).filter((part) => part.length > 0);
}

function validateFilePath(value, label, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATH_CHARS) {
    fail(code, label + ' must be a non-empty absolute path');
  }
  if (CONTROL_OR_BIDI.test(value)) fail(code, label + ' contains unsafe characters');
  if (!isAbsoluteLocalPath(value)) fail(code, label + ' must be an absolute local path');
  for (const part of segments(value)) {
    if (part === '.' || part === '..') fail(code, label + ' must not contain relative segments');
    if (process.platform === 'win32' && /[. ]$/.test(part)) {
      fail(code, label + ' has a Win32-invalid trailing dot or space');
    }
  }
  let info;
  try {
    info = lstatSync(value);
  } catch {
    fail(code, label + ' does not exist');
  }
  if (info.isSymbolicLink()) fail(code, label + ' must not be a symlink or junction');
  if (!info.isFile()) fail(code, label + ' must be a regular file');
  try {
    if (statSync(value).size < 1) fail(code, label + ' is empty');
  } catch {
    fail(code, label + ' cannot be read');
  }
  let real;
  try {
    real = realpathSync.native(value);
  } catch {
    fail(code, label + ' cannot be resolved');
  }
  const resolved = path.resolve(value);
  const unchanged = process.platform === 'win32'
    ? real.toLowerCase() === resolved.toLowerCase()
    : real === resolved;
  if (!unchanged) fail(code, label + ' must not traverse a symlink or junction');
  return value;
}

export function validateLlamaExecutablePath(value) {
  const checked = validateFilePath(value, 'executablePath', 'invalid-executable');
  if (process.platform === 'win32') {
    if (path.extname(checked).toLowerCase() !== '.exe') {
      fail('invalid-executable', 'executablePath must name a Windows executable');
    }
  } else {
    let mode;
    try {
      mode = statSync(checked).mode;
    } catch {
      fail('invalid-executable', 'executablePath cannot be read');
    }
    if ((mode & 0o111) === 0) fail('invalid-executable', 'executablePath must be executable');
  }
  return checked;
}

export function validateLlamaModelPath(value) {
  const checked = validateFilePath(value, 'modelPath', 'invalid-model-path');
  if (path.extname(checked).toLowerCase() !== '.gguf') {
    fail('invalid-model-path', 'modelPath must name a GGUF file');
  }
  return checked;
}

export function validateLoopbackHost(value) {
  if (value !== LOOPBACK_HOST) fail('invalid-host', 'host must be loopback ' + LOOPBACK_HOST);
  return LOOPBACK_HOST;
}

function validateInteger(value, label, minimum, maximum, code) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail(code, label + ' must be an integer from ' + minimum + ' to ' + maximum);
  }
  return value;
}

function validateCommandArgs(value) {
  if (value === undefined) return Object.freeze([]);
  let length;
  try {
    if (!Array.isArray(value)) length = -1;
    else length = value.length;
  } catch {
    fail('invalid-command-args', 'commandArgs is not a valid array');
  }
  if (!Number.isInteger(length) || length < 0 || length > MAX_COMMAND_ARGS) {
    fail('invalid-command-args', 'commandArgs must be an array of at most ' + MAX_COMMAND_ARGS + ' strings');
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail('invalid-command-args', 'commandArgs has an unsafe entry');
    }
    if (!descriptor || !('value' in descriptor)) fail('invalid-command-args', 'commandArgs must contain data only');
    const arg = descriptor.value;
    if (typeof arg !== 'string' || arg.length < 1 || arg.length > MAX_COMMAND_ARG_CHARS) {
      fail('invalid-command-args', 'commandArgs entries must be non-empty bounded strings');
    }
    if (CONTROL_OR_BIDI.test(arg)) fail('invalid-command-args', 'commandArgs entries contain unsafe characters');
    const lowered = arg.toLowerCase();
    if (RESERVED_SERVER_ARGS.has(lowered) || lowered.startsWith('--host=') || lowered.startsWith('--port=')) {
      fail('invalid-command-args', 'commandArgs must not set the bind host or port');
    }
    if (DENIED_SERVER_ARGS.has(lowered) || DENIED_SERVER_ARG_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
      fail('invalid-command-args', 'commandArgs must not enable shared ports, agent tools or MCP tools');
    }
    out.push(arg);
  }
  return Object.freeze(out);
}

function validateEnv(value) {
  if (value === undefined) return Object.create(null);
  if (!isPlainObject(value)) fail('invalid-env', 'env must be a plain object');
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-env', 'env cannot be enumerated');
  }
  if (keys.length > MAX_ENV_KEYS) fail('invalid-env', 'env has too many keys');
  const out = Object.create(null);
  let total = 0;
  for (const key of keys) {
    const lowered = key.toLowerCase();
    if (
      key.length > MAX_ENV_NAME_CHARS
      || RESERVED_KEYS.has(lowered)
      || !ENV_NAME.test(key)
      || DENIED_ENV_KEYS.has(lowered)
      || DENIED_ENV_PREFIXES.some((prefix) => lowered.startsWith(prefix))
    ) {
      fail('invalid-env', 'env key is not allowed');
    }
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail('invalid-env', 'env has an unsafe property');
    }
    if (!descriptor || !('value' in descriptor)) fail('invalid-env', 'env must contain data properties only');
    const entry = descriptor.value;
    if (typeof entry !== 'string' || entry.length > MAX_ENV_VALUE_CHARS) {
      fail('invalid-env', 'env values must be bounded strings');
    }
    if (entry.includes('\u0000')) fail('invalid-env', 'env values must not contain NUL');
    total += key.length + entry.length + 2;
    if (total > MAX_ENV_TOTAL_CHARS) fail('invalid-env', 'env is too large');
    out[key] = entry;
  }
  return out;
}

function childEnvironment(overrides) {
  // Windows synthesises a system/user PATH for a child whose environment block omits it, which
  // would reintroduce user-writable search directories. Pin it to empty instead; a caller that
  // needs a specific PATH passes one explicitly.
  const env = Object.create(null);
  env.PATH = '';
  for (const key of COPIED_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && !value.includes('\u0000')) env[key] = value;
  }
  for (const key of Object.keys(overrides)) {
    if (process.platform === 'win32') {
      for (const existing of Object.keys(env)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
      }
    }
    env[key] = overrides[key];
  }
  return env;
}

export function buildLlamaServerArgs(config) {
  const own = readOwnData(config, 'config', ARG_KEYS);
  const modelPath = validateLlamaModelPath(own.modelPath);
  const port = validateInteger(own.port, 'port', MIN_PORT, MAX_PORT, 'invalid-port');
  const args = ['--model', modelPath, '--host', LOOPBACK_HOST, '--port', String(port)];
  if (own.contextSize !== undefined) {
    validateInteger(own.contextSize, 'contextSize', MIN_CONTEXT_SIZE, MAX_CONTEXT_SIZE, 'invalid-context-size');
    args.push('--ctx-size', String(own.contextSize));
  }
  if (own.threads !== undefined) {
    validateInteger(own.threads, 'threads', MIN_THREADS, MAX_THREADS, 'invalid-threads');
    args.push('--threads', String(own.threads));
  }
  if (own.gpuLayers !== undefined) {
    validateInteger(own.gpuLayers, 'gpuLayers', MIN_GPU_LAYERS, MAX_GPU_LAYERS, 'invalid-gpu-layers');
    args.push('--n-gpu-layers', String(own.gpuLayers));
  }
  return Object.freeze(args);
}

export async function reserveLoopbackPort() {
  const server = net.createServer();
  let port = 0;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK_HOST, resolve);
    });
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  } catch {
    port = 0;
  } finally {
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    fail('no-port', 'a loopback port could not be reserved');
  }
  return port;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  timer.unref?.();
  return controller.signal;
}

function validateOptions(options) {
  const own = readOwnData(options, 'options', OPTION_KEYS);
  const executablePath = validateLlamaExecutablePath(own.executablePath);
  const modelPath = validateLlamaModelPath(own.modelPath);
  const commandArgs = validateCommandArgs(own.commandArgs);
  const port = own.port === undefined
    ? undefined
    : validateInteger(own.port, 'port', MIN_PORT, MAX_PORT, 'invalid-port');
  const contextSize = own.contextSize === undefined
    ? undefined
    : validateInteger(own.contextSize, 'contextSize', MIN_CONTEXT_SIZE, MAX_CONTEXT_SIZE, 'invalid-context-size');
  const threads = own.threads === undefined
    ? undefined
    : validateInteger(own.threads, 'threads', MIN_THREADS, MAX_THREADS, 'invalid-threads');
  const gpuLayers = own.gpuLayers === undefined
    ? undefined
    : validateInteger(own.gpuLayers, 'gpuLayers', MIN_GPU_LAYERS, MAX_GPU_LAYERS, 'invalid-gpu-layers');
  const startupTimeoutMs = own.startupTimeoutMs === undefined
    ? DEFAULT_STARTUP_TIMEOUT_MS
    : validateInteger(own.startupTimeoutMs, 'startupTimeoutMs', MIN_STARTUP_TIMEOUT_MS, MAX_STARTUP_TIMEOUT_MS, 'invalid-timeout');
  const healthIntervalMs = own.healthIntervalMs === undefined
    ? DEFAULT_HEALTH_INTERVAL_MS
    : validateInteger(own.healthIntervalMs, 'healthIntervalMs', MIN_HEALTH_INTERVAL_MS, MAX_HEALTH_INTERVAL_MS, 'invalid-timeout');
  const stopTimeoutMs = own.stopTimeoutMs === undefined
    ? DEFAULT_STOP_TIMEOUT_MS
    : validateInteger(own.stopTimeoutMs, 'stopTimeoutMs', MIN_STOP_TIMEOUT_MS, MAX_STOP_TIMEOUT_MS, 'invalid-timeout');
  if (own.fetch !== undefined && typeof own.fetch !== 'function') fail('invalid-options', 'fetch must be a function');
  const fetchImpl = own.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('runtime-unavailable', 'this runtime has no fetch implementation');
  return Object.freeze({
    executablePath,
    modelPath,
    commandArgs,
    port,
    contextSize,
    threads,
    gpuLayers,
    startupTimeoutMs,
    healthIntervalMs,
    stopTimeoutMs,
    env: childEnvironment(validateEnv(own.env)),
    fetch: fetchImpl,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLlamaServer(options) {
  const config = validateOptions(options);
  const state = {
    state: 'stopped',
    port: null,
    pid: null,
    exitCode: null,
    signal: null,
    startedAt: null,
    stdout: '',
    stderr: '',
  };
  let child = null;
  let exitPromise = null;
  let resolveExit = null;
  let startPromise = null;
  let stopPromise = null;
  let stopRequested = false;

  function snapshot() {
    return Object.freeze({
      state: state.state,
      port: state.port,
      baseUrl: state.port === null ? null : 'http://' + LOOPBACK_HOST + ':' + state.port + '/v1',
      pid: state.pid,
      exitCode: state.exitCode,
      signal: state.signal,
      startedAt: state.startedAt,
    });
  }

  function appendOutput(kind, chunk) {
    const text = String(chunk);
    state[kind] = (state[kind] + text).slice(-MAX_CHILD_OUTPUT_CHARS);
  }

  async function probe(port) {
    try {
      const response = await config.fetch('http://' + LOOPBACK_HOST + ':' + port + '/health', {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: timeoutSignal(HEALTH_TIMEOUT_MS),
      });
      try {
        if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
      } catch {
        /* a cancelled body is not a health failure */
      }
      return { ok: response.status === 200, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  async function start() {
    // A start issued while a stop is still tearing the old child down waits for it, so a restart
    // can never be clobbered by the stop that was already in flight.
    if (stopPromise) await stopPromise;
    if (state.state === 'running') return snapshot();
    if (startPromise) return startPromise;
    if (state.state === 'starting') fail('already-starting', 'the server is already starting');
    stopRequested = false;
    state.state = 'starting';
    state.exitCode = null;
    state.signal = null;
    state.startedAt = null;
    state.stdout = '';
    state.stderr = '';
    startPromise = (async () => {
      let port;
      try {
        port = config.port ?? await reserveLoopbackPort();
      } catch {
        state.state = 'stopped';
        state.port = null;
        fail('no-port', 'a loopback port could not be reserved');
      }
      if (stopRequested) {
        state.state = 'stopped';
        state.port = null;
        fail('start-aborted', 'the start was stopped before the process spawned');
      }
      state.port = port;
      // Re-check both paths at the point of use: they were validated at creation, and a file
      // replaced by a symlink or a different file since then must not be executed or loaded.
      try {
        validateLlamaExecutablePath(config.executablePath);
        validateLlamaModelPath(config.modelPath);
      } catch (error) {
        state.state = 'stopped';
        state.port = null;
        throw error;
      }
      const args = [...config.commandArgs, ...buildLlamaServerArgs({
        modelPath: config.modelPath,
        port,
        contextSize: config.contextSize,
        threads: config.threads,
        gpuLayers: config.gpuLayers,
      })];
      let spawned;
      try {
        spawned = spawn(config.executablePath, args, {
          shell: false,
          windowsHide: true,
          detached: false,
          cwd: path.dirname(config.executablePath),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: config.env,
        });
      } catch {
        state.state = 'stopped';
        state.port = null;
        fail('spawn-failed', 'the server process could not be started');
      }
      child = spawned;
      state.pid = spawned.pid ?? null;
      state.startedAt = new Date().toISOString();
      exitPromise = new Promise((resolve) => {
        resolveExit = resolve;
      });
      spawned.stdout?.on('data', (chunk) => appendOutput('stdout', chunk));
      spawned.stderr?.on('data', (chunk) => appendOutput('stderr', chunk));
      spawned.once('error', () => {
        if (state.state === 'running' || state.state === 'starting') state.state = 'exited';
        state.pid = null;
        resolveExit();
      });
      spawned.once('exit', (code, signal) => {
        state.exitCode = typeof code === 'number' ? code : null;
        state.signal = signal ?? null;
        state.pid = null;
        if (state.state === 'running' || state.state === 'starting') state.state = 'exited';
        resolveExit();
      });
      const deadline = Date.now() + config.startupTimeoutMs;
      for (;;) {
        if (stopRequested) {
          await shutdownChild();
          state.state = 'stopped';
          state.port = null;
          fail('start-aborted', 'the start was stopped while the server was starting');
        }
        if (state.state === 'exited') {
          await shutdownChild();
          state.state = 'stopped';
          state.port = null;
          fail('server-exited', 'the server exited before it became ready');
        }
        const health = await probe(port);
        if (health.ok) {
          if (stopRequested) {
            await shutdownChild();
            state.state = 'stopped';
            state.port = null;
            fail('start-aborted', 'the start was stopped while the server was starting');
          }
          state.state = 'running';
          return snapshot();
        }
        if (Date.now() >= deadline) {
          await shutdownChild();
          state.state = 'stopped';
          state.port = null;
          fail('startup-timeout', 'the server did not become ready in time');
        }
        await delay(config.healthIntervalMs);
      }
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function waitForExit(ms) {
    if (!exitPromise) return true;
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    });
    const exited = exitPromise.then(() => true);
    const result = await Promise.race([exited, timedOut]);
    clearTimeout(timer);
    return result;
  }

  async function shutdownChild() {
    if (!child) return;
    const current = child;
    child = null;
    try {
      current.kill('SIGTERM');
    } catch {
      /* the child may already be gone */
    }
    const exited = await waitForExit(config.stopTimeoutMs);
    if (!exited) {
      try {
        current.kill('SIGKILL');
      } catch {
        /* the child may already be gone */
      }
      await waitForExit(1_000);
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    const pending = (async () => {
      stopRequested = true;
      const pendingStart = startPromise;
      await shutdownChild();
      if (pendingStart) await pendingStart.catch(() => {});
      child = null;
      state.pid = null;
      state.port = null;
      state.state = 'stopped';
      return Object.freeze({ stopped: true });
    })();
    stopPromise = pending.finally(() => { stopPromise = null; });
    return stopPromise;
  }

  async function health() {
    if (state.state !== 'running' || state.port === null) return Object.freeze({ ok: false, status: 0 });
    const result = await probe(state.port);
    return Object.freeze({ ok: result.ok, status: result.status });
  }

  return Object.freeze({
    version: RUNTIME_MODULE_VERSION,
    start,
    stop,
    health,
    status: snapshot,
    describe: snapshot,
    config: Object.freeze({
      executablePath: config.executablePath,
      modelPath: config.modelPath,
      host: LOOPBACK_HOST,
    }),
  });
}
