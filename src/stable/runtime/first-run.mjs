// M3 first-run wizard.
//
// Ties the delivered hardware probe, pinned model catalog and resumable downloader into one headless
// controller the setup panel can drive: probe the machine, project the catalog to the recommendation
// input, report which pinned weights are already on disk, download only the missing ones with
// progress, and expose the local B1 start plan. It also reports an already running local Ollama
// daemon and can route the local runtime through it instead of the pinned weights. It never spawns
// llama-server, never opens a socket of its own and never reads a secret: every effect is injected or
// delegated to the already-reviewed modules.

import path from 'node:path';
import { types } from 'node:util';

import { probeHardware, recommendRuntime } from './hardware-probe.mjs';
import {
  downloadModel as defaultDownloadModel,
  findCatalogModel,
  validateCatalog,
  verifyInstalledModel,
} from './model-downloader.mjs';
import { validateLlamaExecutablePath } from './llama-server.mjs';
import {
  OLLAMA_MODULE_VERSION,
  discoverOllama as defaultDiscoverOllama,
  validateOllamaResult,
} from './ollama.mjs';

export const FIRST_RUN_VERSION = 2;
export const WIZARD_PHASES = Object.freeze([
  'idle', 'probing', 'needs-download', 'downloading', 'ready', 'insufficient', 'failed',
]);
export const MAX_NOTICES = 24;
export const MAX_PATH_CHARS = 4096;
export const MAX_ERROR_CODE_CHARS = 64;
export const MAX_ERROR_MESSAGE_CHARS = 160;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const NOTICE_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPTION_KEYS = new Set([
  'catalog', 'destinationDir', 'probe', 'downloadModel', 'verifyModel', 'runtimePath', 'onChange',
  'discoverOllama', 'preferOllama',
]);
const INSTALL_OPTION_KEYS = new Set(['signal']);
const PROBE_RESULT_KEYS = new Set(['version', 'hardware', 'notices']);

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

function freezeModel(model) {
  return Object.freeze({
    id: model.id,
    role: model.role,
    sizeBytes: model.sizeBytes,
    contextTokens: model.contextTokens,
  });
}

// The wizard reports two wizard-level discovery failures that the Ollama module itself never
// returns: an injected discovery function that throws, and one that returns a forged result.
function unavailableOllama(reason) {
  return Object.freeze({
    version: OLLAMA_MODULE_VERSION,
    available: false,
    reason: reason,
    status: null,
    port: null,
    baseUrl: null,
    chatModel: null,
    embeddingModel: null,
    modelCount: 0,
    notices: Object.freeze([]),
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
  const discover = own.discoverOllama === undefined ? defaultDiscoverOllama : own.discoverOllama;
  if (typeof discover !== 'function') fail('invalid-options', 'discoverOllama must be a function');
  const preferOllama = own.preferOllama === undefined ? false : own.preferOllama;
  if (typeof preferOllama !== 'boolean') fail('invalid-options', 'preferOllama must be a boolean');
  const onChange = own.onChange;
  if (onChange !== undefined && typeof onChange !== 'function') {
    fail('invalid-options', 'onChange must be a function');
  }
  let runtimePath = null;
  if (own.runtimePath !== undefined) {
    try {
      runtimePath = validateLlamaExecutablePath(own.runtimePath);
    } catch {
      fail('invalid-options', 'runtimePath must name a readable llama-server executable');
    }
  }
  // The user's local-runtime choice survives a refresh; an unavailable daemon falls back to the
  // pinned weights until it answers again.
  let selection = preferOllama ? 'ollama' : 'pinned';

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
  let revision = 0;
  let disposed = false;

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
    state.ollama = null;
    state.error = Object.freeze({
      code: safeCode(code, 'failed'),
      message: safeMessage(message, 'The first-run check failed.'),
    });
    emit();
  }

  function effectiveSource() {
    return selection === 'ollama'
      && state.ollama !== null
      && state.ollama.available === true
      && state.ollama.chatModel !== null
      ? 'ollama'
      : 'pinned';
  }

  async function discoverOnce() {
    let result;
    try {
      result = await discover();
    } catch {
      return unavailableOllama('discovery-failed');
    }
    try {
      return validateOllamaResult(result);
    } catch {
      return unavailableOllama('invalid-result');
    }
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

  function startPlan() {
    if (state.phase !== 'ready' || state.plan === null) {
      return Object.freeze({ available: false, reason: 'not-ready' });
    }
    if (effectiveSource() === 'ollama') {
      const ollama = state.ollama;
      return Object.freeze({
        available: true,
        kind: 'ollama',
        baseUrl: ollama.baseUrl,
        model: ollama.chatModel,
        embeddingModel: ollama.embeddingModel,
      });
    }
    if (runtimePath === null) {
      return Object.freeze({ available: false, reason: 'runtime-not-bundled' });
    }
    const chat = entries.find(function (item) { return item.projected.role === 'chat'; });
    const embedding = entries.find(function (item) { return item.projected.role === 'embedding'; });
    return Object.freeze({
      available: true,
      kind: 'llama-server',
      executablePath: runtimePath,
      modelPath: path.join(destinationDir, chat.entry.file),
      embeddingModelPath: path.join(destinationDir, embedding.entry.file),
      contextSize: state.plan.contextSize,
      threads: state.plan.threads,
      gpuLayers: state.plan.gpuLayers,
    });
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
      ollama: state.ollama === null ? null : Object.freeze(Object.assign({}, state.ollama)),
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
    const ollama = await discoverOnce();
    if (mine !== revision) return view();
    state.hardware = hardwareSummary(probedOwn.hardware);
    state.plan = plan;
    state.ollama = ollama;
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
    if (effectiveSource() === 'ollama') {
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

  function useOllama() {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (installing !== null) return { ok: false, reason: 'busy' };
    if (state.plan === null) return { ok: false, reason: 'not-ready' };
    if (state.ollama === null || state.ollama.available !== true || state.ollama.chatModel === null) {
      return { ok: false, reason: 'ollama-unavailable' };
    }
    selection = 'ollama';
    state.phase = 'ready';
    state.error = null;
    emit();
    return { ok: true, source: 'ollama' };
  }

  function usePinned() {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (installing !== null) return { ok: false, reason: 'busy' };
    if (state.plan === null) return { ok: false, reason: 'not-ready' };
    selection = 'pinned';
    const allInstalled = state.models.length > 0 && state.models.every(function (model) {
      return model.installed;
    });
    state.phase = state.plan.verdict === 'insufficient'
      ? 'insufficient'
      : allInstalled ? 'ready' : 'needs-download';
    state.error = null;
    emit();
    return { ok: true, source: 'pinned' };
  }

  function dispose() {
    disposed = true;
    installing = null;
  }

  return Object.freeze({
    version: FIRST_RUN_VERSION,
    refresh: refresh,
    install: install,
    startPlan: startPlan,
    useOllama: useOllama,
    usePinned: usePinned,
    view: view,
    dispose: dispose,
  });
}
