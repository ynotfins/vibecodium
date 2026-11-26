// M3 local runtime hardware probe.
//
// The first-run wizard needs to know what the machine can run before it downloads weights or
// starts `llama-server`. This module collects the facts (platform, arch, CPU, RAM and, on Windows,
// the display adapters) with a fixed read-only PowerShell query and maps them, plus the pinned
// model catalog, to the flags the local B1 provider should start with. It never spawns
// `llama-server`, never downloads anything and never guesses a GPU it cannot see: an unknown or
// unusable GPU means CPU-only, which is slower but always safe.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { types } from 'node:util';

export const HARDWARE_PROBE_VERSION = 1;
export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;
export const MAX_GPU_COUNT = 8;
export const MAX_GPU_NAME_CHARS = 200;
export const MAX_CPU_MODEL_CHARS = 200;
export const MAX_MODELS = 16;
export const MIN_MODEL_BYTES = 1;
export const MAX_MODEL_BYTES = 512 * GIB;
export const MIN_CONTEXT_TOKENS = 128;
export const MAX_CONTEXT_TOKENS = 1_048_576;
export const MIN_IDLE_TIMEOUT_MS = 50;
export const MAX_PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const MIN_PROBE_OUTPUT_BYTES = 1;
export const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
export const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;

// The plan is a documented heuristic, not a measurement. A 512 MiB runtime allowance covers the
// loader and the non-cached buffers; 16 KiB per context token approximates a small-model KV cache
// in f16 without knowing the architecture.
export const RUNTIME_OVERHEAD_BYTES = 512 * MIB;
export const KV_BYTES_PER_CONTEXT_TOKEN = 16 * 1024;
// Leave a quarter of RAM to the OS and the editor.
export const RAM_BUDGET_FRACTION = 0.75;
// Offloading every layer needs headroom for the compute buffers.
export const GPU_RESERVE_BYTES = 512 * MIB;
export const MIN_USABLE_VRAM_BYTES = 512 * MIB;
// Win32_VideoController.AdapterRAM is a UInt32, so a larger card reports a capped value near
// 4 GiB. Treat that value as "at least this large" instead of as an exact size.
export const GPU_RAM_REPORT_CAP = 4095 * MIB;
export const GPU_LAYERS_ALL = 999;
export const GPU_LAYERS_OFF = 0;
export const MAX_RECOMMENDED_THREADS = 16;
export const RESERVED_CPU_CORES = 2;
export const RECOMMENDED_CONTEXT_TOKENS = 8192;
export const RECOMMENDED_EMBEDDING_CONTEXT_TOKENS = 2048;
export const MIN_MEMORY_BYTES = 8 * GIB;
export const LOW_MEMORY_BYTES = 16 * GIB;

export const GPU_VENDORS = Object.freeze([
  'nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'microsoft', 'unknown',
]);
export const GPU_KINDS = Object.freeze(['discrete', 'integrated', 'software']);
export const MODEL_ROLES = Object.freeze(['chat', 'embedding']);
export const ACCELERATION = Object.freeze(['gpu', 'unified', 'cpu']);
export const VERDICTS = Object.freeze(['ready', 'tight', 'insufficient']);

const PLATFORMS = new Set(['win32', 'linux', 'darwin']);
const ARCHES = new Set(['x64', 'arm64', 'arm', 'ia32']);
const VENDOR_SET = new Set(GPU_VENDORS);
const KIND_SET = new Set(GPU_KINDS);
const ROLE_SET = new Set(MODEL_ROLES);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const DIGITS = /^[0-9]{1,15}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SOFTWARE_NAME = /basic display|basic render|remote display|virtual|vmware|hyper-v|virtualbox|parsec|citrix|llvmpipe|swiftshader/;
const VENDOR_RULES = Object.freeze([
  ['microsoft', /microsoft|basic display|remote display|virtual|vmware|hyper-v|parsec|citrix|llvmpipe|swiftshader/],
  ['nvidia', /nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla/],
  ['amd', /amd|radeon|firepro|instinct|\bati\b/],
  ['intel', /intel|iris|uhd graphics|\barc\b/],
  ['apple', /apple/],
  ['qualcomm', /qualcomm|adreno/],
]);
const NOTICE_ORDER = Object.freeze([
  'no-gpu', 'integrated-gpu', 'software-gpu', 'vram-unknown', 'vram-capped',
  'model-exceeds-vram', 'unified-memory', 'low-memory', 'insufficient-memory',
  'model-too-large', 'context-capped', 'thread-cap',
]);

const HARDWARE_KEYS = new Set(['platform', 'arch', 'cpu', 'totalMemoryBytes', 'freeMemoryBytes', 'gpus']);
const CPU_KEYS = new Set(['model', 'logicalCores']);
const GPU_KEYS = new Set(['name', 'vendor', 'kind', 'memoryBytes']);
const MODEL_KEYS = new Set(['id', 'role', 'sizeBytes', 'contextTokens']);
const PROBE_OPTION_KEYS = new Set([
  'platform', 'arch', 'cpuModel', 'logicalCores', 'totalMemoryBytes', 'freeMemoryBytes',
  'exec', 'timeoutMs', 'maxOutputBytes',
]);

export class HardwareProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HardwareProbeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new HardwareProbeError(code, message);
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    // A Proxy can answer `getPrototypeOf` and then run a getter when its key is read, so it is
    // rejected before any trap can run.
    if (types.isProxy(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

// Reads own data descriptors once, so an accessor is rejected without being invoked and a polluted
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

function readOwnArray(value, label, maximum) {
  let isArray;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail('invalid-options', label + ' must be an array');
  }
  if (!isArray) fail('invalid-options', label + ' must be an array');
  let length;
  try {
    length = value.length;
  } catch {
    fail('invalid-options', label + ' has no usable length');
  }
  if (!Number.isInteger(length) || length < 0 || length > maximum) {
    fail('invalid-options', label + ' has an invalid length');
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail('invalid-options', label + ' has an unsafe element');
    }
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      fail('invalid-options', label + ' must contain data elements only');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function requireText(value, label, maximum) {
  if (typeof value !== 'string') fail('invalid-options', label + ' must be a string');
  const text = value.trim();
  if (text.length < 1 || text.length > maximum) fail('invalid-options', label + ' has an invalid length');
  if (CONTROL_OR_BIDI.test(text)) fail('invalid-options', label + ' must not contain control or bidi characters');
  return text;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail('invalid-options', label + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return value;
}

// An OS-provided CPU name is trusted data but still untrusted text: strip control and bidi
// characters, collapse whitespace and bound the length before it enters a descriptor.
function sanitizeCpuModel(value) {
  if (typeof value !== 'string') return 'unknown cpu';
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CPU_MODEL_CHARS)
    .trim();
  return cleaned.length > 0 ? cleaned : 'unknown cpu';
}

function withDeadline(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HardwareProbeError('gpu-probe-failed', 'the GPU probe timed out'));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Spawn the absolute system PowerShell. Never spawn by bare name: CreateProcess searches the
// current directory before PATH, so a workspace-planted powershell.exe could run instead. A
// relative or drive-relative SystemRoot is ignored rather than trusted.
export function powershellPath(env = process.env) {
  const candidate = typeof env?.SystemRoot === 'string' && env.SystemRoot.length > 0
    ? env.SystemRoot
    : (typeof env?.windir === 'string' && env.windir.length > 0 ? env.windir : 'C:\\Windows');
  const root = path.win32.isAbsolute(candidate) ? candidate : 'C:\\Windows';
  return root.replace(/[\\/]+$/, '') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

const POWERSHELL = powershellPath();

// One read-only CIM query. Each card is emitted as base64(name), a tab and its decimal AdapterRAM,
// so a name can never inject a delimiter or a newline into the stream.
export const GPU_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$cards = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop)',
  'foreach ($card in $cards) {',
  '  $name = [string]$card.Name',
  '  if ([string]::IsNullOrWhiteSpace($name)) { continue }',
  '  $ram = 0',
  '  if ($card.AdapterRAM -ne $null) { $ram = [uint64]$card.AdapterRAM }',
  '  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($name))',
  '  [Console]::Out.WriteLine($encoded + "`t" + [string]$ram)',
  '}',
].join('\n');

export function classifyGpu(name, memoryBytes) {
  const text = typeof name === 'string' ? name.trim() : '';
  const lower = text.toLowerCase();
  let vendor = 'unknown';
  for (const [candidate, pattern] of VENDOR_RULES) {
    if (pattern.test(lower)) {
      vendor = candidate;
      break;
    }
  }
  let kind = 'discrete';
  if (vendor === 'microsoft' || SOFTWARE_NAME.test(lower)) kind = 'software';
  else if (vendor === 'intel') kind = /\barc\b/.test(lower) ? 'discrete' : 'integrated';
  else if (vendor === 'qualcomm' || vendor === 'apple') kind = 'integrated';
  else if (vendor === 'amd' && !/\brx\b|radeon pro|firepro|instinct/.test(lower)) kind = 'integrated';
  return Object.freeze({ vendor, kind });
}

function decodeGpuName(encoded) {
  if (typeof encoded !== 'string' || encoded.length < 4 || encoded.length % 4 !== 0 || !BASE64.test(encoded)) {
    fail('gpu-probe-invalid', 'the GPU probe returned a malformed name');
  }
  let bytes;
  try {
    bytes = Buffer.from(encoded, 'base64');
  } catch {
    fail('gpu-probe-invalid', 'the GPU probe returned a malformed name');
  }
  if (bytes.toString('base64') !== encoded) fail('gpu-probe-invalid', 'the GPU probe returned a malformed name');
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('gpu-probe-invalid', 'the GPU probe returned a malformed name');
  }
  const name = decoded.trim();
  if (name.length < 1 || name.length > MAX_GPU_NAME_CHARS) {
    fail('gpu-probe-invalid', 'the GPU probe returned a malformed name');
  }
  if (CONTROL_OR_BIDI.test(name)) fail('gpu-probe-invalid', 'the GPU probe returned a malformed name');
  return name;
}

// Parses the exact line format the fixed script emits. Any deviation is rejected: a partially
// understood GPU list is worse than none, because the plan would offload to the wrong card.
export function parseGpuProbeOutput(text) {
  if (typeof text !== 'string') fail('gpu-probe-invalid', 'the GPU probe returned a non-text answer');
  if (Buffer.byteLength(text, 'utf8') > MAX_PROBE_OUTPUT_BYTES) {
    fail('gpu-probe-invalid', 'the GPU probe answer exceeded its cap');
  }
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length > MAX_GPU_COUNT) fail('gpu-probe-invalid', 'the GPU probe returned too many adapters');
  const gpus = [];
  for (const line of lines) {
    if (line.length === 0) fail('gpu-probe-invalid', 'the GPU probe answer had an empty line');
    const fields = line.split('\t');
    if (fields.length !== 2) fail('gpu-probe-invalid', 'the GPU probe answer had an unknown shape');
    const name = decodeGpuName(fields[0]);
    if (!DIGITS.test(fields[1])) fail('gpu-probe-invalid', 'the GPU probe returned an invalid adapter size');
    const memoryBytes = Number(fields[1]);
    if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 0 || memoryBytes > MAX_SAFE_BYTES) {
      fail('gpu-probe-invalid', 'the GPU probe returned an invalid adapter size');
    }
    const { vendor, kind } = classifyGpu(name, memoryBytes);
    gpus.push(Object.freeze({ name, vendor, kind, memoryBytes }));
  }
  return Object.freeze(gpus);
}

function encodeScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// The GPU query needs no caller input and no broad environment: keep only what PowerShell needs to
// load and write its own temporary files, and pin PATH empty so nothing can be resolved from it.
function childEnv() {
  const env = { PATH: '' };
  for (const name of ['SystemRoot', 'windir', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  return env;
}

// Runs the fixed GPU query with no shell, no stdin and no inherited environment, bounded by a
// timeout and an output cap.
export function defaultExec({ script, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, maxOutputBytes = MAX_PROBE_OUTPUT_BYTES }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeScript(script)], {
        windowsHide: true,
        shell: false,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(new HardwareProbeError('gpu-probe-failed', 'the GPU probe could not be started'));
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
      finish(() => reject(new HardwareProbeError('gpu-probe-failed', 'the GPU probe timed out')));
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      total += chunk.length;
      if (total > maxOutputBytes) {
        try { child.kill(); } catch { /* already gone */ }
        finish(() => reject(new HardwareProbeError('gpu-probe-failed', 'the GPU probe output exceeded its cap')));
        return;
      }
      if (target === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', () => finish(() => reject(new HardwareProbeError('gpu-probe-failed', 'the GPU probe could not be started'))));
    child.on('close', (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
  });
}

function validateHardware(value) {
  const own = readOwnData(value, 'hardware', HARDWARE_KEYS);
  if (typeof own.platform !== 'string' || !PLATFORMS.has(own.platform)) {
    fail('invalid-options', 'hardware platform must be win32, linux or darwin');
  }
  if (typeof own.arch !== 'string' || !ARCHES.has(own.arch)) {
    fail('invalid-options', 'hardware arch is not supported');
  }
  const cpu = readOwnData(own.cpu, 'hardware cpu', CPU_KEYS);
  const model = requireText(cpu.model, 'hardware cpu model', MAX_CPU_MODEL_CHARS);
  const logicalCores = requireInteger(cpu.logicalCores, 'hardware logical cores', 1, 1024);
  const totalMemoryBytes = requireInteger(own.totalMemoryBytes, 'hardware total memory', 1, MAX_SAFE_BYTES);
  const freeMemoryBytes = own.freeMemoryBytes === undefined
    ? null
    : requireInteger(own.freeMemoryBytes, 'hardware free memory', 0, totalMemoryBytes);
  const rawGpus = readOwnArray(own.gpus, 'hardware gpus', MAX_GPU_COUNT);
  const gpus = rawGpus.map((entry) => {
    const card = readOwnData(entry, 'hardware gpu', GPU_KEYS);
    const name = requireText(card.name, 'hardware gpu name', MAX_GPU_NAME_CHARS);
    const memoryBytes = card.memoryBytes === undefined || card.memoryBytes === null
      ? null
      : requireInteger(card.memoryBytes, 'hardware gpu memory', 0, MAX_SAFE_BYTES);
    const derived = classifyGpu(name, memoryBytes);
    if (card.vendor !== undefined) {
      if (typeof card.vendor !== 'string' || !VENDOR_SET.has(card.vendor) || card.vendor !== derived.vendor) {
        fail('invalid-options', 'hardware gpu vendor does not match its name');
      }
    }
    if (card.kind !== undefined) {
      if (typeof card.kind !== 'string' || !KIND_SET.has(card.kind) || card.kind !== derived.kind) {
        fail('invalid-options', 'hardware gpu kind does not match its name');
      }
    }
    return Object.freeze({ name, vendor: derived.vendor, kind: derived.kind, memoryBytes });
  });
  return Object.freeze({
    platform: own.platform,
    arch: own.arch,
    cpu: Object.freeze({ model, logicalCores }),
    totalMemoryBytes,
    freeMemoryBytes,
    gpus: Object.freeze(gpus),
  });
}

function validateModels(value) {
  const entries = readOwnArray(value, 'models', MAX_MODELS);
  const seen = new Set();
  const models = entries.map((entry) => {
    const own = readOwnData(entry, 'model', MODEL_KEYS);
    if (typeof own.id !== 'string' || !MODEL_ID.test(own.id) || RESERVED_KEYS.has(own.id)) {
      fail('invalid-options', 'a model id must be a lowercase identifier');
    }
    if (seen.has(own.id)) fail('invalid-options', 'model ids must be unique');
    seen.add(own.id);
    if (typeof own.role !== 'string' || !ROLE_SET.has(own.role)) {
      fail('invalid-options', 'a model role must be chat or embedding');
    }
    const sizeBytes = requireInteger(own.sizeBytes, 'model size', MIN_MODEL_BYTES, MAX_MODEL_BYTES);
    const contextTokens = requireInteger(own.contextTokens, 'model context', MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS);
    return Object.freeze({ id: own.id, role: own.role, sizeBytes, contextTokens });
  });
  return Object.freeze(models);
}

export function estimateModelMemoryBytes(sizeBytes, contextTokens) {
  requireInteger(sizeBytes, 'sizeBytes', 0, MAX_SAFE_BYTES);
  requireInteger(contextTokens, 'contextTokens', 0, MAX_CONTEXT_TOKENS);
  return sizeBytes + RUNTIME_OVERHEAD_BYTES + contextTokens * KV_BYTES_PER_CONTEXT_TOKEN;
}

function chatContext(model) {
  return Math.min(model.contextTokens, RECOMMENDED_CONTEXT_TOKENS);
}

function embeddingContext(model) {
  return Math.min(model.contextTokens, RECOMMENDED_EMBEDDING_CONTEXT_TOKENS);
}

function bySizeDescending(left, right) {
  if (left.sizeBytes !== right.sizeBytes) return right.sizeBytes - left.sizeBytes;
  return left.id < right.id ? -1 : 1;
}

function largestFitting(models, budget, contextOf) {
  for (const model of models) {
    if (estimateModelMemoryBytes(model.sizeBytes, contextOf(model)) <= budget) return model;
  }
  return null;
}

function usableVram(gpu) {
  if (gpu.kind !== 'discrete' || gpu.memoryBytes === null) return null;
  return gpu.memoryBytes >= MIN_USABLE_VRAM_BYTES ? gpu.memoryBytes : null;
}

function sortNotices(notices) {
  const unique = Array.from(new Set(notices));
  return Object.freeze(unique.sort((left, right) => NOTICE_ORDER.indexOf(left) - NOTICE_ORDER.indexOf(right)));
}

// Pure mapping from validated facts plus the pinned catalog to a start plan for the local
// provider. The plan is data only: the wizard decides what to download and the supervisor decides
// what to spawn.
export function recommendRuntime(hardware, models) {
  const hw = validateHardware(hardware);
  const catalog = validateModels(models);
  const chatModels = catalog.filter((model) => model.role === 'chat').sort(bySizeDescending);
  const embeddingModels = catalog.filter((model) => model.role === 'embedding').sort(bySizeDescending);
  if (chatModels.length === 0) fail('no-chat-model', 'the catalog must contain a chat model');
  if (embeddingModels.length === 0) fail('no-embedding-model', 'the catalog must contain an embedding model');

  const notices = [];
  const ramBudget = Math.floor(hw.totalMemoryBytes * RAM_BUDGET_FRACTION);
  const unified = hw.platform === 'darwin' && hw.arch === 'arm64';
  let acceleration = unified ? 'unified' : 'cpu';
  let gpuLayers = unified ? GPU_LAYERS_ALL : GPU_LAYERS_OFF;
  let budget = ramBudget;
  let chat = null;

  if (unified) {
    notices.push('unified-memory');
    chat = largestFitting(chatModels, ramBudget, chatContext);
  } else {
    const discrete = hw.gpus
      .filter((card) => usableVram(card) !== null)
      .sort((left, right) => right.memoryBytes - left.memoryBytes)[0];
    if (discrete) {
      if (discrete.memoryBytes >= GPU_RAM_REPORT_CAP && discrete.memoryBytes < 4 * GIB) notices.push('vram-capped');
      const vramBudget = discrete.memoryBytes - GPU_RESERVE_BYTES;
      chat = largestFitting(chatModels, vramBudget, chatContext);
      if (chat) {
        acceleration = 'gpu';
        gpuLayers = GPU_LAYERS_ALL;
        budget = vramBudget;
      } else {
        notices.push('model-exceeds-vram');
      }
    } else {
      const integrated = hw.gpus.filter((card) => card.kind === 'integrated').length;
      const software = hw.gpus.filter((card) => card.kind === 'software').length;
      const discreteUnknown = hw.gpus.filter((card) => card.kind === 'discrete').length;
      if (integrated > 0) notices.push('integrated-gpu');
      if (software > 0) notices.push('software-gpu');
      if (integrated === 0 && software === 0 && discreteUnknown > 0) notices.push('vram-unknown');
      if (hw.gpus.length === 0) notices.push('no-gpu');
    }
    if (!chat) {
      chat = largestFitting(chatModels, ramBudget, chatContext);
      budget = ramBudget;
    }
  }

  const chatFits = chat !== null;
  if (!chatFits) chat = chatModels[chatModels.length - 1];
  const contextSize = chatContext(chat);
  if (chat.contextTokens > RECOMMENDED_CONTEXT_TOKENS) notices.push('context-capped');
  const estimatedChatMemoryBytes = estimateModelMemoryBytes(chat.sizeBytes, contextSize);
  if (!chatFits) notices.push('model-too-large');

  const embedding = largestFitting(embeddingModels, ramBudget, embeddingContext) ?? embeddingModels[0];
  const estimatedEmbeddingMemoryBytes = estimateModelMemoryBytes(embedding.sizeBytes, embeddingContext(embedding));
  if (estimatedEmbeddingMemoryBytes > ramBudget) notices.push('model-too-large');

  const threads = Math.min(Math.max(1, hw.cpu.logicalCores - RESERVED_CPU_CORES), MAX_RECOMMENDED_THREADS);
  if (hw.cpu.logicalCores - RESERVED_CPU_CORES > MAX_RECOMMENDED_THREADS) notices.push('thread-cap');

  if (hw.totalMemoryBytes < MIN_MEMORY_BYTES) notices.push('insufficient-memory');
  else if (hw.totalMemoryBytes < LOW_MEMORY_BYTES) notices.push('low-memory');

  let verdict = 'ready';
  if (!chatFits || hw.totalMemoryBytes < MIN_MEMORY_BYTES) verdict = 'insufficient';
  else if (acceleration !== 'gpu' && acceleration !== 'unified') verdict = 'tight';
  else if (hw.totalMemoryBytes < LOW_MEMORY_BYTES) verdict = 'tight';

  return Object.freeze({
    version: HARDWARE_PROBE_VERSION,
    verdict,
    acceleration,
    gpuLayers,
    threads,
    contextSize,
    models: Object.freeze({ chat: chat.id, embedding: embedding.id }),
    estimatedChatMemoryBytes,
    estimatedEmbeddingMemoryBytes,
    availableMemoryBytes: budget,
    totalMemoryBytes: hw.totalMemoryBytes,
    notices: sortNotices(notices),
  });
}

function probeFacts(options) {
  const own = readOwnData(options, 'probe options', PROBE_OPTION_KEYS);
  const platform = own.platform === undefined ? process.platform : own.platform;
  if (typeof platform !== 'string' || !PLATFORMS.has(platform)) {
    fail('invalid-options', 'probe platform must be win32, linux or darwin');
  }
  const arch = own.arch === undefined ? process.arch : own.arch;
  if (typeof arch !== 'string' || !ARCHES.has(arch)) fail('invalid-options', 'probe arch is not supported');
  const cpuModel = own.cpuModel === undefined
    ? sanitizeCpuModel(os.cpus()[0]?.model)
    : requireText(own.cpuModel, 'probe cpu model', MAX_CPU_MODEL_CHARS);
  const logicalCores = own.logicalCores === undefined
    ? (os.cpus().length || 1)
    : requireInteger(own.logicalCores, 'probe logical cores', 1, 1024);
  const totalMemoryBytes = own.totalMemoryBytes === undefined
    ? os.totalmem()
    : requireInteger(own.totalMemoryBytes, 'probe total memory', 1, MAX_SAFE_BYTES);
  const freeMemoryBytes = own.freeMemoryBytes === undefined
    ? Math.min(os.freemem(), totalMemoryBytes)
    : requireInteger(own.freeMemoryBytes, 'probe free memory', 0, totalMemoryBytes);
  const exec = own.exec === undefined ? defaultExec : own.exec;
  if (typeof exec !== 'function') fail('invalid-options', 'probe exec must be a function');
  const timeoutMs = own.timeoutMs === undefined
    ? DEFAULT_PROBE_TIMEOUT_MS
    : requireInteger(own.timeoutMs, 'probe timeout', MIN_IDLE_TIMEOUT_MS, MAX_PROBE_TIMEOUT_MS);
  const maxOutputBytes = own.maxOutputBytes === undefined
    ? MAX_PROBE_OUTPUT_BYTES
    : requireInteger(own.maxOutputBytes, 'probe output cap', MIN_PROBE_OUTPUT_BYTES, MAX_PROBE_OUTPUT_BYTES);
  return { platform, arch, cpuModel, logicalCores, totalMemoryBytes, freeMemoryBytes, exec, timeoutMs, maxOutputBytes };
}

// Collects the facts the plan needs. A GPU query that fails, times out or returns something this
// module does not understand becomes a bounded notice and an empty GPU list; the caller can still
// run CPU-only, and no child output is ever surfaced.
export async function probeHardware(options = {}) {
  const facts = probeFacts(options === undefined ? {} : options);
  const notices = [];
  let gpus = Object.freeze([]);
  if (facts.platform !== 'win32') {
    notices.push('gpu-probe-unavailable');
  } else {
    let answer;
    try {
      answer = await withDeadline(facts.exec({
        script: GPU_PROBE_SCRIPT,
        timeoutMs: facts.timeoutMs,
        maxOutputBytes: facts.maxOutputBytes,
      }), facts.timeoutMs);
    } catch {
      answer = undefined;
    }
    if (answer === undefined) {
      notices.push('gpu-probe-failed');
    } else if (!answer || typeof answer !== 'object' || typeof answer.stdout !== 'string') {
      notices.push('gpu-probe-failed');
    } else if (answer.code !== 0) {
      notices.push('gpu-probe-failed');
    } else if (Buffer.byteLength(answer.stdout, 'utf8') > facts.maxOutputBytes) {
      notices.push('gpu-probe-invalid');
    } else {
      try {
        gpus = parseGpuProbeOutput(answer.stdout);
        if (gpus.length === 0) notices.push('gpu-probe-empty');
      } catch {
        gpus = Object.freeze([]);
        notices.push('gpu-probe-invalid');
      }
    }
  }
  const hardware = Object.freeze({
    platform: facts.platform,
    arch: facts.arch,
    cpu: Object.freeze({ model: facts.cpuModel, logicalCores: facts.logicalCores }),
    totalMemoryBytes: facts.totalMemoryBytes,
    freeMemoryBytes: facts.freeMemoryBytes,
    gpus,
  });
  return Object.freeze({
    version: HARDWARE_PROBE_VERSION,
    hardware,
    notices: Object.freeze(notices),
  });
}
