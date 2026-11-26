// M3 first-run wizard.
//
// Ties the delivered hardware probe, pinned model catalog and resumable downloader into one headless
// controller the setup panel can drive: probe the machine, project the catalog to the recommendation
// input, report which pinned weights are already on disk, download only the missing ones with
// progress, and expose the local B1 start plan. It never spawns llama-server, never opens a socket
// and never reads a secret: every effect is injected or delegated to the already-reviewed modules.

import path from 'node:path';
import { types } from 'node:util';

import { probeHardware, recommendRuntime } from './hardware-probe.mjs';
import {
  downloadModel as defaultDownloadModel,
  findCatalogModel,
  validateCatalog,
  verifyInstalledModel,
} from './model-downloader.mjs';
import { validateLlamaExecutablePath, validateRestart } from './llama-server.mjs';
import {
  discoverOllama as defaultDiscoverOllama,
  toOllamaProviderOptions,
} from './ollama.mjs';

export const FIRST_RUN_VERSION = 1;
export const WIZARD_PHASES = Object.freeze([
  'idle', 'probing', 'needs-download', 'downloading', 'ready', 'insufficient', 'failed',
]);
export const MAX_NOTICES = 24;
export const MAX_PATH_CHARS = 4096;
export const MAX_ERROR_CODE_CHARS = 64;
export const MAX_ERROR_MESSAGE_CHARS = 160;
// The conservative restart/back-off policy the wizard hands to the supervisor when the caller does
// not choose one: a bounded number of attempts, exponential delay and a stability reset. The
// supervisor remains opt-in; a caller passes a different validated policy as `restart`.
export const DEFAULT_FIRST_RUN_RESTART_POLICY = Object.freeze({
  maxRestarts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  stableMs: 60_000,
});

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const NOTICE_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPTION_KEYS = new Set([
  'catalog', 'destinationDir', 'probe', 'downloadModel', 'verifyModel', 'runtimePath', 'onChange',
  'discoverOllama', 'restart',
]);
const INSTALL_OPTION_KEYS = new Set(['signal']);
const PROBE_RESULT_KEYS = new Set(['version', 'hardware', 'notices']);

// The bounded vocabulary the panel may show for an Ollama answer. A value outside it is replaced,
// so an injected effect cannot put arbitrary text in the view.
const OLLAMA_REASONS = new Set([
  'unreachable', 'timeout', 'http-error', 'invalid-response', 'policy-denied',
  'no-chat-model', 'invalid-result', 'check-failed', 'disposed',
]);
const MAX_OLLAMA_NOTICES = 8;
const MAX_OLLAMA_MODEL_CHARS = 200;
const MAX_OLLAMA_MODELS = 256;

const PROBE_NOTICES = Object.freeze([
  'gpu-probe-failed', 'gpu-probe-invalid', 'gpu-probe-unavailable', 'gpu-probe-empty',
]);
const PLAN_NOTICES = Object.freeze([
  'no-gpu', 'integrated-gpu', 'software-gpu', 'vram-unknown', 'vram-capped',
  'model-exceeds-vram', 'unified-memory', 'low-memory', 'insufficient-memory',
  'model-too-large', 'context-capped', 'thread-cap',
]);
const NOTICE_ORDER = Object.freeze(PROBE_NOTICES.concat(PLAN_NOTICES));
const NOTICE_RANK = new Map(NOTICE_ORDER.map(function (code, index) { return [code, index]; }));

export class FirstRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FirstRunError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FirstRunError(code, message);
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (types.isProxy(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

// Reads own data descriptors once so an accessor is rejected without being invoked and a polluted
// prototype cannot contribute a value.
function readOwnData(value, label, allowed, code) {
  const failure = code || 'invalid-options';
  if (!isPlainObject(value)) fail(failure, label + ' must be a plain object');
  let names;
  try {
    names = Object.keys(value);
  } catch {
    fail(failure, label + ' cannot be enumerated');
  }
  if (names.length > allowed.size) fail(failure, label + ' has too many properties');
  const out = Object.create(null);
  for (const name of names) {
    if (RESERVED_KEYS.has(name)) fail(failure, label + ' has a reserved property');
    if (!allowed.has(name)) fail(failure, label + ' has an unknown property');
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
    } catch {
      fail(failure, label + ' has an unsafe property');
    }
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      fail(failure, label + ' must contain data properties only');
    }
    out[name] = descriptor.value;
  }
  return out;
}

function requireText(value, label, maximum, code) {
  const failure = code || 'invalid-options';
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    fail(failure, label + ' must be a bounded non-empty string');
  }
  if (CONTROL_OR_BIDI.test(value)) fail(failure, label + ' contains unsafe characters');
  return value;
}

function isAbsoluteLocalPath(value) {
  if (process.platform === 'win32') {
    if (value.startsWith('\\\\') || value.startsWith('//')) return false;
    return /^[A-Za-z]:[\\/]/.test(value) && value.length > 3;
  }
  return path.isAbsolute(value) && !value.startsWith('//');
}

function requireDestination(value) {
  requireText(value, 'destinationDir', MAX_PATH_CHARS);
  if (!isAbsoluteLocalPath(value)) fail('invalid-options', 'destinationDir must be an absolute local path');
  const parts = value.split(/[\\/]+/);
  for (const part of parts) {
    if (part === '.' || part === '..') fail('invalid-options', 'destinationDir must not contain relative segments');
  }
  if (process.platform === 'win32' && /[. ]$/.test(value)) {
    fail('invalid-options', 'destinationDir has a Win32-invalid trailing dot or space');
  }
  return value;
}

function isAbortSignal(value) {
  return Boolean(value) &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function';
}

function safeCode(value, fallback) {
  return typeof value === 'string' && value.length <= MAX_ERROR_CODE_CHARS && NOTICE_CODE.test(value)
    ? value
    : fallback;
}

function safeMessage(value, fallback) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ERROR_MESSAGE_CHARS) return fallback;
  return CONTROL_OR_BIDI.test(value) ? fallback : value;
}

// Reads one own data property without running an accessor, so a hostile discovery answer cannot
// execute code or hide behind a getter.
function readDataField(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { ok: true, value: undefined };
    if ('get' in descriptor || 'set' in descriptor) return { ok: false, value: undefined };
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false, value: undefined };
  }
}

function boundedCodeList(value, maximum) {
  if (types.isProxy(value) || !Array.isArray(value)) return Object.freeze([]);
  let length;
  try {
    length = value.length;
  } catch {
    return Object.freeze([]);
  }
  if (!Number.isInteger(length) || length < 0) return Object.freeze([]);
  const out = [];
  // The cap bounds the work even when a hostile list declares a huge length and no valid code.
  const limit = Math.min(length, maximum * 4);
  for (let index = 0; index < limit && out.length < maximum; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      continue;
    }
    if (!descriptor || !('value' in descriptor)) continue;
    const code = descriptor.value;
    if (typeof code !== 'string' || !NOTICE_CODE.test(code) || out.includes(code)) continue;
    out.push(code);
  }
  return Object.freeze(out);
}

function freezeOllamaSummary(summary) {
  return Object.freeze({
    checked: summary.checked,
    available: summary.available,
    reason: summary.reason,
    baseUrl: summary.baseUrl,
    chatModel: summary.chatModel,
    embeddingModel: summary.embeddingModel,
    modelCount: summary.modelCount,
    notices: summary.notices,
    providerOptions: summary.providerOptions,
  });
}

function failedOllamaSummary(reason, notice) {
  return freezeOllamaSummary({
    checked: true,
    available: false,
    reason,
    baseUrl: null,
    chatModel: null,
    embeddingModel: null,
    modelCount: 0,
    notices: Object.freeze([notice]),
    providerOptions: null,
  });
}

// Turns an untrusted discovery answer into a frozen, display-safe summary. The provider overrides are
// produced only by the reviewed `toOllamaProviderOptions`, which re-validates the whole answer, so a
// forged, stale, remote or wrong-base answer can never point the B1 preset anywhere.
function summarizeOllamaResult(raw) {
  if (types.isProxy(raw) || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return failedOllamaSummary('invalid-result', 'ollama-invalid-response');
  }
  const availableField = readDataField(raw, 'available');
  const chatField = readDataField(raw, 'chatModel');
  const embeddingField = readDataField(raw, 'embeddingModel');
  if (!availableField.ok || !chatField.ok || !embeddingField.ok) {
    return failedOllamaSummary('invalid-result', 'ollama-invalid-response');
  }
  const available = availableField.value === true;
  let providerOptions = null;
  if (available) {
    try {
      providerOptions = toOllamaProviderOptions(raw);
    } catch {
      providerOptions = null;
    }
  }
  const modelsField = readDataField(raw, 'models');
  let modelCount = 0;
  if (modelsField.ok && !types.isProxy(modelsField.value) && Array.isArray(modelsField.value)) {
    try {
      const length = modelsField.value.length;
      modelCount = Number.isInteger(length) && length > 0 ? Math.min(length, MAX_OLLAMA_MODELS) : 0;
    } catch {
      modelCount = 0;
    }
  }
  const noticesField = readDataField(raw, 'notices');
  let notices = noticesField.ok ? boundedCodeList(noticesField.value, MAX_OLLAMA_NOTICES) : Object.freeze([]);
  let reason = null;
  if (available) {
    if (providerOptions === null) {
      reason = chatField.value === null || chatField.value === undefined ? 'no-chat-model' : 'invalid-result';
    }
  } else {
    const reasonField = readDataField(raw, 'reason');
    reason = reasonField.ok && typeof reasonField.value === 'string' && OLLAMA_REASONS.has(reasonField.value)
      ? reasonField.value
      : 'invalid-result';
  }
  if (!available && notices.length === 0) {
    notices = Object.freeze([reason === 'invalid-result' ? 'ollama-invalid-response' : 'ollama-unreachable']);
  }
  const embedded = typeof embeddingField.value === 'string' &&
    embeddingField.value.length >= 1 &&
    embeddingField.value.length <= MAX_OLLAMA_MODEL_CHARS &&
    !CONTROL_OR_BIDI.test(embeddingField.value)
    ? embeddingField.value
    : null;
  return freezeOllamaSummary({
    checked: true,
    available,
    reason,
    baseUrl: providerOptions === null ? null : providerOptions.baseUrl,
    chatModel: providerOptions === null ? null : providerOptions.model,
    embeddingModel: available && reason !== 'invalid-result' ? embedded : null,
    modelCount,
    notices,
    providerOptions,
  });
}

function disposedOllamaSummary() {
  return freezeOllamaSummary({
    checked: false,
    available: false,
    reason: 'disposed',
    baseUrl: null,
    chatModel: null,
    embeddingModel: null,
    modelCount: 0,
    notices: Object.freeze([]),
    providerOptions: null,
  });
}

function freezeModel(model) {
  return Object.freeze({
    id: model.id,
    role: model.role,
    sizeBytes: model.sizeBytes,
    contextTokens: model.contextTokens,
  });
}

// The pinned catalog carries twelve fields; recommendRuntime accepts exactly four and rejects the
// others, so the wizard is the one place that projects between them.
export function projectCatalogModels(catalog) {
  let valid;
  try {
    valid = validateCatalog(catalog);
  } catch {
    fail('invalid-catalog', 'the pinned model catalog is invalid');
  }
  const models = [];
  for (const entry of valid.models) {
    if (entry.role === 'chat' || entry.role === 'embedding') models.push(freezeModel(entry));
  }
  const hasChat = models.some(function (model) { return model.role === 'chat'; });
  const hasEmbedding = models.some(function (model) { return model.role === 'embedding'; });
  if (!hasChat) fail('no-chat-model', 'the pinned catalog has no chat model');
  if (!hasEmbedding) fail('no-embedding-model', 'the pinned catalog has no embedding model');
  return Object.freeze(models);
}

function mergeNotices(probeNotices, planNotices, extraNotices) {
  const seen = new Set();
  const out = [];
  const lists = [probeNotices, planNotices, extraNotices];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const code of list) {
      if (typeof code !== 'string' || !NOTICE_CODE.test(code) || seen.has(code)) continue;
      seen.add(code);
      out.push(code);
      if (out.length >= MAX_NOTICES) break;
    }
  }
  out.sort(function (left, right) {
    const leftRank = NOTICE_RANK.has(left) ? NOTICE_RANK.get(left) : NOTICE_ORDER.length;
    const rightRank = NOTICE_RANK.has(right) ? NOTICE_RANK.get(right) : NOTICE_ORDER.length;
    return leftRank - rightRank;
  });
  return Object.freeze(out);
}

function readProbeNotices(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) fail('probe-failed', 'the hardware probe returned invalid notices');
  let length;
  try {
    length = value.length;
  } catch {
    fail('probe-failed', 'the hardware probe returned invalid notices');
  }
  if (length > MAX_NOTICES) fail('probe-failed', 'the hardware probe returned too many notices');
  const notices = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail('probe-failed', 'the hardware probe returned invalid notices');
    }
    if (!descriptor || !('value' in descriptor)) {
      fail('probe-failed', 'the hardware probe returned invalid notices');
    }
    if (typeof descriptor.value !== 'string' || !NOTICE_CODE.test(descriptor.value)) {
      fail('probe-failed', 'the hardware probe returned invalid notices');
    }
    notices.push(descriptor.value);
  }
  return Object.freeze(notices);
}

function hardwareSummary(hardware) {
  return Object.freeze({
    platform: hardware.platform,
    arch: hardware.arch,
    cpuModel: hardware.cpu.model,
    logicalCores: hardware.cpu.logicalCores,
    totalMemoryBytes: hardware.totalMemoryBytes,
    freeMemoryBytes: hardware.freeMemoryBytes,
    gpuCount: hardware.gpus.length,
  });
}

export function createFirstRunWizard(options) {
  const own = readOwnData(options === undefined ? {} : options, 'first-run options', OPTION_KEYS);
  const destinationDir = requireDestination(own.destinationDir);
  const probe = own.probe === undefined ? probeHardware : own.probe;
  if (typeof probe !== 'function') fail('invalid-options', 'probe must be a function');
  const downloadModel = own.downloadModel === undefined ? defaultDownloadModel : own.downloadModel;
  if (typeof downloadModel !== 'function') fail('invalid-options', 'downloadModel must be a function');
  const verifyModel = own.verifyModel === undefined ? verifyInstalledModel : own.verifyModel;
  if (typeof verifyModel !== 'function') fail('invalid-options', 'verifyModel must be a function');
  const onChange = own.onChange;
  if (onChange !== undefined && typeof onChange !== 'function') {
    fail('invalid-options', 'onChange must be a function');
  }
  const discoverOllama = own.discoverOllama === undefined ? defaultDiscoverOllama : own.discoverOllama;
  if (typeof discoverOllama !== 'function') fail('invalid-options', 'discoverOllama must be a function');
  let runtimePath = null;
  if (own.runtimePath !== undefined) {
    try {
      runtimePath = validateLlamaExecutablePath(own.runtimePath);
    } catch {
      fail('invalid-options', 'runtimePath must name a readable llama-server executable');
    }
  }
  let restartPolicy;
  if (own.restart === undefined) {
    restartPolicy = DEFAULT_FIRST_RUN_RESTART_POLICY;
  } else {
    try {
      restartPolicy = validateRestart(own.restart);
    } catch {
      fail('invalid-options', 'restart must be a valid restart policy');
    }
  }

  let catalog;
  try {
    catalog = validateCatalog(own.catalog);
  } catch {
    fail('invalid-catalog', 'the pinned model catalog is invalid');
  }
  const projected = projectCatalogModels(catalog);
  const entries = Object.freeze(projected.map(function (model) {
    return Object.freeze({ entry: findCatalogModel(catalog, model.id), projected: model });
  }));
  const recommendationInput = Object.freeze(projected.map(freezeModel));

  const state = {
    phase: 'idle',
    hardware: null,
    plan: null,
    notices: Object.freeze([]),
    models: [],
    progress: null,
    error: null,
    ollama: null,
  };
  let installing = null;
  let ollamaCheck = null;
  let revision = 0;
  let disposed = false;
  // The local-runtime choice survives a refresh; the daemon is only used while its summary still
  // carries validated provider overrides.
  let source = 'pinned';

  function emit() {
    if (onChange === undefined) return;
    try {
      onChange(view());
    } catch {
      /* a display callback must not break provisioning */
    }
  }

  function setFailure(code, message) {
    state.phase = 'failed';
    state.hardware = null;
    state.plan = null;
    state.notices = Object.freeze([]);
    state.models = [];
    state.progress = null;
    state.error = Object.freeze({
      code: safeCode(code, 'failed'),
      message: safeMessage(message, 'The first-run check failed.'),
    });
    emit();
  }

  async function verifyAll() {
    const rows = [];
    let verifyFailed = false;
    for (const item of entries) {
      let installed = false;
      try {
        const result = await verifyModel(item.entry, { destinationDir: destinationDir });
        installed = Boolean(result && result.verified === true);
      } catch {
        installed = false;
        verifyFailed = true;
      }
      rows.push({
        id: item.projected.id,
        role: item.projected.role,
        sizeBytes: item.projected.sizeBytes,
        installed: installed,
        path: path.join(destinationDir, item.entry.file),
      });
    }
    return { rows: rows, verifyFailed: verifyFailed };
  }

  function startBlocker() {
    if (state.phase !== 'ready' || state.plan === null) {
      return Object.freeze({ available: false, reason: 'not-ready' });
    }
    if (effectiveSource() === 'ollama') {
      const options = state.ollama.providerOptions;
      return Object.freeze({
        available: true,
        kind: 'ollama',
        baseUrl: options.baseUrl,
        model: options.model,
        embeddingModel: state.ollama.embeddingModel,
      });
    }
    if (runtimePath === null) {
      return Object.freeze({ available: false, reason: 'runtime-not-bundled' });
    }
    return null;
  }

  function findRole(role) {
    return entries.find(function (item) { return item.projected.role === role; });
  }

  function startPlan() {
    const blocked = startBlocker();
    if (blocked !== null) return blocked;
    const chat = findRole('chat');
    const embedding = findRole('embedding');
    return Object.freeze({
      available: true,
      kind: 'llama-server',
      executablePath: runtimePath,
      modelPath: path.join(destinationDir, chat.entry.file),
      embeddingModelPath: path.join(destinationDir, embedding.entry.file),
      contextSize: state.plan.contextSize,
      threads: state.plan.threads,
      gpuLayers: state.plan.gpuLayers,
      restart: restartPolicy,
    });
  }

  // The hand-off to the supervisor: exactly the options `createLlamaServer` accepts, with the same
  // validated flags and restart policy the start plan reports. It never spawns; the caller owns the
  // process boundary and the supervisor re-validates every field.
  function runtimeOptions() {
    const blocked = startBlocker();
    if (blocked !== null) return blocked;
    const chat = findRole('chat');
    return Object.freeze({
      available: true,
      options: Object.freeze({
        executablePath: runtimePath,
        modelPath: path.join(destinationDir, chat.entry.file),
        contextSize: state.plan.contextSize,
        threads: state.plan.threads,
        gpuLayers: state.plan.gpuLayers,
        restart: restartPolicy,
      }),
    });
  }

  function ollamaUsable() {
    return state.ollama !== null
      && state.ollama.available === true
      && state.ollama.providerOptions !== null;
  }

  function effectiveSource() {
    return source === 'ollama' && ollamaUsable() ? 'ollama' : 'pinned';
  }

  function pinnedPhase() {
    if (state.plan === null) return 'idle';
    const allInstalled = state.models.length > 0 && state.models.every(function (model) {
      return model.installed;
    });
    if (state.plan.verdict === 'insufficient') return 'insufficient';
    return allInstalled ? 'ready' : 'needs-download';
  }

  // `checkOllama` is a read-only detection: it never changes the pinned plan, never downloads and
  // never adopts the daemon. The effect is the delivered discovery by default; a call in flight is
  // shared so a double click cannot make two loopback requests.
  async function runOllamaCheck() {
    let summary;
    try {
      summary = summarizeOllamaResult(await discoverOllama());
    } catch {
      summary = failedOllamaSummary('check-failed', 'ollama-check-failed');
    }
    if (!disposed) {
      state.ollama = summary;
      if (source === 'ollama' && !ollamaUsable()) {
        source = 'pinned';
        state.phase = pinnedPhase();
      }
      emit();
    }
    return summary;
  }

  function checkOllama() {
    if (disposed) return Promise.resolve(disposedOllamaSummary());
    if (ollamaCheck !== null) return ollamaCheck;
    ollamaCheck = Promise.resolve().then(runOllamaCheck).finally(function () {
      ollamaCheck = null;
    });
    return ollamaCheck;
  }

  function buildSteps() {
    const modelsDone = state.models.length > 0 && state.models.every(function (model) {
      return model.installed;
    });
    const start = startPlan();
    const check = state.plan !== null ? 'done' : state.phase === 'failed' ? 'failed' : 'pending';
    const models = modelsDone
      ? 'done'
      : state.phase === 'downloading' || state.phase === 'needs-download' ? 'active' : 'pending';
    const download = modelsDone
      ? 'done'
      : state.plan !== null && state.plan.verdict === 'insufficient'
        ? 'blocked'
        : state.phase === 'needs-download' ? 'active' : 'pending';
    const runtime = start.available
      ? 'ready'
      : start.reason === 'runtime-not-bundled' ? 'blocked' : 'pending';
    return Object.freeze([
      Object.freeze({ id: 'check', status: check }),
      Object.freeze({ id: 'models', status: models }),
      Object.freeze({ id: 'download', status: download }),
      Object.freeze({ id: 'runtime', status: runtime }),
    ]);
  }

  function view() {
    const plan = state.plan;
    const missing = state.models.filter(function (model) { return !model.installed; });
    const downloadBytes = missing.reduce(function (total, model) {
      return total + model.sizeBytes;
    }, 0);
    return Object.freeze({
      version: FIRST_RUN_VERSION,
      phase: state.phase,
      source: effectiveSource(),
      verdict: plan === null ? null : plan.verdict,
      acceleration: plan === null ? null : plan.acceleration,
      notices: state.notices,
      hardware: state.hardware === null ? null : Object.freeze(Object.assign({}, state.hardware)),
      models: Object.freeze(state.models.map(function (model) {
        return Object.freeze({
          id: model.id,
          role: model.role,
          sizeBytes: model.sizeBytes,
          installed: model.installed,
          path: model.path,
        });
      })),
      downloadBytes: downloadBytes,
      plan: plan === null ? null : Object.freeze({
        contextSize: plan.contextSize,
        threads: plan.threads,
        gpuLayers: plan.gpuLayers,
        estimatedChatMemoryBytes: plan.estimatedChatMemoryBytes,
        estimatedEmbeddingMemoryBytes: plan.estimatedEmbeddingMemoryBytes,
        availableMemoryBytes: plan.availableMemoryBytes,
        totalMemoryBytes: plan.totalMemoryBytes,
      }),
      progress: state.progress === null ? null : Object.freeze(Object.assign({}, state.progress)),
      error: state.error === null ? null : Object.freeze(Object.assign({}, state.error)),
      start: startPlan(),
      steps: buildSteps(),
      ollama: state.ollama,
      disposed: disposed,
    });
  }

  async function refresh() {
    if (disposed) return view();
    if (installing !== null) return view();
    const mine = ++revision;
    state.phase = 'probing';
    state.error = null;
    emit();
    let probed;
    try {
      probed = await probe();
    } catch {
      if (mine === revision) setFailure('probe-failed', 'The hardware check could not be completed.');
      return view();
    }
    if (mine !== revision) return view();
    let probedOwn;
    try {
      probedOwn = readOwnData(probed, 'probe result', PROBE_RESULT_KEYS, 'probe-failed');
    } catch {
      if (mine === revision) setFailure('probe-failed', 'The hardware check returned an invalid result.');
      return view();
    }
    if (probedOwn.hardware === undefined) {
      setFailure('probe-failed', 'The hardware check returned no machine facts.');
      return view();
    }
    let probeNotices;
    try {
      probeNotices = readProbeNotices(probedOwn.notices);
    } catch {
      if (mine === revision) setFailure('probe-failed', 'The hardware check returned invalid notices.');
      return view();
    }
    let plan;
    try {
      plan = recommendRuntime(probedOwn.hardware, recommendationInput);
    } catch {
      if (mine === revision) {
        setFailure('unsupported-hardware', 'The machine facts could not be mapped to a local runtime plan.');
      }
      return view();
    }
    const verified = await verifyAll();
    if (mine !== revision) return view();
    state.hardware = hardwareSummary(probedOwn.hardware);
    state.plan = plan;
    state.notices = verified.verifyFailed
      ? mergeNotices(probeNotices, plan.notices, Object.freeze(['verify-failed']))
      : mergeNotices(probeNotices, plan.notices, null);
    state.models = verified.rows;
    state.progress = null;
    state.error = null;
    const allInstalled = verified.rows.every(function (row) { return row.installed; });
    state.phase = effectiveSource() === 'ollama'
      ? 'ready'
      : plan.verdict === 'insufficient'
        ? 'insufficient'
        : allInstalled ? 'ready' : 'needs-download';
    emit();
    return view();
  }

  async function runInstall(signal) {
    let installed = 0;
    try {
      const missing = state.models.filter(function (model) { return !model.installed; });
      for (const target of missing) {
        if (signal !== undefined && signal.aborted) {
          state.phase = 'needs-download';
          state.progress = null;
          emit();
          return { ok: false, code: 'aborted' };
        }
        const item = entries.find(function (candidate) {
          return candidate.projected.id === target.id;
        });
        if (item === undefined) {
          throw new FirstRunError('unknown-model', 'the missing model is not in the pinned catalog');
        }
        const result = await downloadModel(item.entry, {
          destinationDir: destinationDir,
          signal: signal,
          onProgress: function (progress) {
            const total = progress && Number.isSafeInteger(progress.total) ? progress.total : target.sizeBytes;
            const received = progress && Number.isSafeInteger(progress.received) ? progress.received : 0;
            const bounded = Math.max(0, Math.min(total, received));
            state.progress = Object.freeze({
              modelId: target.id,
              role: target.role,
              received: bounded,
              total: total,
              fraction: total > 0 ? bounded / total : 0,
            });
            emit();
          },
        });
        if (!result || result.verified !== true) {
          throw new FirstRunError('install-not-verified', 'the downloaded model did not verify');
        }
        const checked = await verifyModel(item.entry, { destinationDir: destinationDir });
        if (!checked || checked.verified !== true) {
          throw new FirstRunError('install-not-verified', 'the installed model did not verify');
        }
        const row = state.models.find(function (model) { return model.id === target.id; });
        if (row !== undefined) row.installed = true;
        installed += 1;
      }
      state.progress = null;
      state.error = null;
      const allInstalled = state.models.every(function (model) { return model.installed; });
      state.phase = allInstalled ? 'ready' : 'needs-download';
      emit();
      return { ok: true, installed: installed };
    } catch (error) {
      state.progress = null;
      const aborted = signal !== undefined && signal.aborted;
      state.phase = aborted ? 'needs-download' : 'failed';
      state.error = aborted ? null : Object.freeze({
        code: safeCode(error && error.code, 'install-failed'),
        message: 'The model download did not complete.',
      });
      emit();
      return { ok: false, code: state.error === null ? 'aborted' : state.error.code };
    } finally {
      installing = null;
    }
  }

  async function install(installOptions) {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (installing !== null) return { ok: false, reason: 'busy' };
    const ownInstall = readOwnData(installOptions === undefined ? {} : installOptions,
      'install options', INSTALL_OPTION_KEYS);
    const signal = ownInstall.signal;
    if (signal !== undefined && !isAbortSignal(signal)) {
      fail('invalid-options', 'signal must be an AbortSignal');
    }
    if (state.phase === 'idle') await refresh();
    if (disposed) return { ok: false, reason: 'disposed' };
    if (effectiveSource() === 'ollama' && state.plan !== null) {
      state.phase = 'ready';
      state.error = null;
      emit();
      return { ok: true, installed: 0, reason: 'ollama-selected' };
    }
    if (state.phase === 'insufficient') return { ok: false, reason: 'insufficient' };
    if (state.plan === null) return { ok: false, reason: 'no-plan' };
    const allInstalled = state.models.every(function (model) { return model.installed; });
    if (state.phase === 'ready' || allInstalled) {
      state.phase = 'ready';
      emit();
      return { ok: true, installed: 0, reason: 'already-installed' };
    }
    revision += 1;
    state.phase = 'downloading';
    state.error = null;
    // Start on a microtask so an injected effect that throws synchronously cannot clear `installing`
    // before the assignment and leave the wizard permanently busy.
    installing = Promise.resolve().then(function () { return runInstall(signal); });
    emit();
    return installing;
  }

  function dispose() {
    disposed = true;
    installing = null;
  }

  // Selecting a discovered daemon is an explicit action; `checkOllama` itself stays read-only.
  function useOllama() {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (installing !== null) return { ok: false, reason: 'busy' };
    if (state.plan === null) return { ok: false, reason: 'not-ready' };
    if (!ollamaUsable()) {
      return { ok: false, reason: state.ollama === null ? 'not-checked' : 'ollama-unavailable' };
    }
    source = 'ollama';
    state.phase = 'ready';
    state.error = null;
    emit();
    return { ok: true, source: 'ollama' };
  }

  function usePinned() {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (installing !== null) return { ok: false, reason: 'busy' };
    if (state.plan === null) return { ok: false, reason: 'not-ready' };
    source = 'pinned';
    state.phase = pinnedPhase();
    state.error = null;
    emit();
    return { ok: true, source: 'pinned' };
  }

  return Object.freeze({
    version: FIRST_RUN_VERSION,
    refresh: refresh,
    install: install,
    startPlan: startPlan,
    runtimeOptions: runtimeOptions,
    checkOllama: checkOllama,
    useOllama: useOllama,
    usePinned: usePinned,
    view: view,
    dispose: dispose,
  });
}
