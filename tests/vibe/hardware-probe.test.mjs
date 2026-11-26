import assert from 'node:assert/strict';
import os from 'node:os';
import { types } from 'node:util';
import test from 'node:test';

import {
  GPU_LAYERS_ALL,
  GPU_LAYERS_OFF,
  GPU_RAM_REPORT_CAP,
  GPU_RESERVE_BYTES,
  HARDWARE_PROBE_VERSION,
  HardwareProbeError,
  LOW_MEMORY_BYTES,
  MAX_GPU_COUNT,
  MAX_MODELS,
  MAX_RECOMMENDED_THREADS,
  MIN_MEMORY_BYTES,
  MIN_USABLE_VRAM_BYTES,
  RAM_BUDGET_FRACTION,
  RECOMMENDED_CONTEXT_TOKENS,
  RECOMMENDED_EMBEDDING_CONTEXT_TOKENS,
  RESERVED_CPU_CORES,
  estimateModelMemoryBytes,
  parseGpuProbeOutput,
  powershellPath,
  probeHardware,
  recommendRuntime,
  defaultExec,
} from '../../src/stable/runtime/hardware-probe.mjs';
import { GPU_PROBE_SCRIPT } from '../../src/stable/runtime/hardware-probe.mjs';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const CHAT = Object.freeze({ id: 'chat-1.5b', role: 'chat', sizeBytes: 1_060_000_000, contextTokens: 32768 });
const EMBED = Object.freeze({ id: 'embed-0.6b', role: 'embedding', sizeBytes: 639_150_592, contextTokens: 32768 });
const MODELS = Object.freeze([CHAT, EMBED]);

function b64(name) {
  return Buffer.from(name, 'utf8').toString('base64');
}

function gpuLine(name, adapterRam) {
  return b64(name) + '\t' + String(adapterRam);
}

function hardware(overrides = {}) {
  return {
    platform: 'win32',
    arch: 'x64',
    cpu: { model: 'Test CPU', logicalCores: 16 },
    totalMemoryBytes: 32 * GIB,
    freeMemoryBytes: overrides.totalMemoryBytes === undefined ? 16 * GIB
      : Math.floor(overrides.totalMemoryBytes / 2),
    gpus: [],
    ...overrides,
  };
}

function gpu(name, memoryBytes) {
  return { name, memoryBytes };
}

function isCode(code) {
  return (error) => error instanceof HardwareProbeError && error.code === code;
}

test('the GPU script is fixed and the child is the absolute system PowerShell', () => {
  assert.equal(typeof GPU_PROBE_SCRIPT, 'string');
  assert.match(GPU_PROBE_SCRIPT, /Get-CimInstance/);
  assert.match(GPU_PROBE_SCRIPT, /Win32_VideoController/);
  assert.match(GPU_PROBE_SCRIPT, /AdapterRAM/);
  assert.equal(
    powershellPath({ SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(powershellPath({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(
    powershellPath({ windir: 'D:\\Win\\' }),
    'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
});

test('the GPU parser accepts base64 names with a decimal adapter size', () => {
  const gpus = parseGpuProbeOutput([
    gpuLine('NVIDIA GeForce RTX 4080', 16 * GIB),
    gpuLine('Intel(R) UHD Graphics 770', 0),
    '',
  ].join('\r\n'));
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].name, 'NVIDIA GeForce RTX 4080');
  assert.equal(gpus[0].vendor, 'nvidia');
  assert.equal(gpus[0].kind, 'discrete');
  assert.equal(gpus[0].memoryBytes, 16 * GIB);
  assert.equal(gpus[1].vendor, 'intel');
  assert.equal(gpus[1].kind, 'integrated');
  assert.equal(gpus[1].memoryBytes, 0);
  assert.ok(Object.isFrozen(gpus));
  assert.ok(Object.isFrozen(gpus[0]));
  assert.deepEqual(parseGpuProbeOutput(''), []);
});

test('the GPU parser rejects malformed, oversized and hostile lines', () => {
  const bad = [
    b64('a card'),
    b64('a card') + '\t' + '123' + '\t' + 'extra',
    '\t123',
    b64('a card') + '\t-1',
    b64('a card') + '\t1.5',
    b64('a card') + '\tnope',
    b64('a card') + '\t1234567890123456',
    'not-base64!!\t123',
    b64('a card') + '=\t123',
    Buffer.from([0x61, 0x00, 0x62]).toString('base64') + '\t123',
    b64('evil\u202eevil') + '\t123',
    b64('x'.repeat(201)) + '\t123',
    gpuLine('before the gap', 1) + '\n\n' + gpuLine('after the gap', 1),
  ];
  for (const line of bad) {
    assert.throws(() => parseGpuProbeOutput(line), isCode('gpu-probe-invalid'), line);
  }
  assert.throws(() => parseGpuProbeOutput(null), isCode('gpu-probe-invalid'));
  assert.deepEqual(parseGpuProbeOutput(gpuLine('only card', 1)), [
    { name: 'only card', vendor: 'unknown', kind: 'discrete', memoryBytes: 1 },
  ]);
  assert.throws(
    () => parseGpuProbeOutput(Array.from({ length: MAX_GPU_COUNT + 1 }, (_, i) => gpuLine('gpu ' + i, 1)).join('\n')),
    isCode('gpu-probe-invalid'),
  );
  assert.throws(
    () => parseGpuProbeOutput(gpuLine('x'.repeat(1000), 1).repeat(100)),
    isCode('gpu-probe-invalid'),
  );
});

function fakeExec(result) {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    calls.at(-1).args = args;
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? result(args) : result;
  };
  return { exec, calls };
}

test('probeHardware reports os facts and the GPU list from one bounded query', async () => {
  const { exec, calls } = fakeExec({
    code: 0,
    stdout: gpuLine('NVIDIA GeForce RTX 4090', 24 * GIB) + '\n',
    stderr: '',
  });
  const result = await probeHardware({
    platform: 'win32',
    arch: 'x64',
    cpuModel: 'Ryzen 9',
    logicalCores: 24,
    totalMemoryBytes: 64 * GIB,
    freeMemoryBytes: 40 * GIB,
    exec,
    timeoutMs: 1234,
    maxOutputBytes: 4096,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, GPU_PROBE_SCRIPT);
  assert.equal(calls[0].timeoutMs, 1234);
  assert.equal(calls[0].maxOutputBytes, 4096);
  assert.equal(result.version, HARDWARE_PROBE_VERSION);
  assert.equal(result.hardware.platform, 'win32');
  assert.equal(result.hardware.arch, 'x64');
  assert.equal(result.hardware.cpu.model, 'Ryzen 9');
  assert.equal(result.hardware.cpu.logicalCores, 24);
  assert.equal(result.hardware.totalMemoryBytes, 64 * GIB);
  assert.equal(result.hardware.freeMemoryBytes, 40 * GIB);
  assert.equal(result.hardware.gpus.length, 1);
  assert.equal(result.hardware.gpus[0].vendor, 'nvidia');
  assert.deepEqual(result.notices, []);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.hardware));
  assert.ok(Object.isFrozen(result.notices));
});

test('a failed, timed-out, oversized or invalid GPU query degrades to no GPUs without throwing', async () => {
  const cases = [
    [new Error('spawn ENOENT with a secret C:\\keys\\provider.env'), 'gpu-probe-failed'],
    [{ code: 1, stdout: 'C:\\Users\\owner\\secret.txt', stderr: 'Access is denied C:\\secret' }, 'gpu-probe-failed'],
    [{ code: 0, stdout: 'garbage', stderr: '' }, 'gpu-probe-invalid'],
    [{ code: 0, stdout: '', stderr: '' }, 'gpu-probe-empty'],
    [{ code: 0, stdout: 'x'.repeat(1_000_000), stderr: '' }, 'gpu-probe-invalid'],
    [{ code: 0, stdout: 5, stderr: '' }, 'gpu-probe-failed'],
    [null, 'gpu-probe-failed'],
  ];
  for (const [answer, notice] of cases) {
    const { exec } = fakeExec(answer);
    const result = await probeHardware({ platform: 'win32', exec });
    assert.deepEqual(result.hardware.gpus, []);
    assert.deepEqual(result.notices, [notice]);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('Access is denied'), false);
  }
});

test('a non-Windows probe does not shell out', async () => {
  let called = false;
  const result = await probeHardware({
    platform: 'linux',
    arch: 'x64',
    exec: async () => { called = true; throw new Error('must not run'); },
  });
  assert.equal(called, false);
  assert.deepEqual(result.hardware.gpus, []);
  assert.deepEqual(result.notices, ['gpu-probe-unavailable']);
});

test('probeHardware rejects bad injected facts and accessor options without invoking a getter', async () => {
  const bad = [
    async () => probeHardware({ platform: 'plan9' }),
    async () => probeHardware({ arch: 'sparc' }),
    async () => probeHardware({ logicalCores: 0 }),
    async () => probeHardware({ logicalCores: 1.5 }),
    async () => probeHardware({ totalMemoryBytes: -1 }),
    async () => probeHardware({ totalMemoryBytes: Number.NaN }),
    async () => probeHardware({ totalMemoryBytes: 1, freeMemoryBytes: 2 }),
    async () => probeHardware({ cpuModel: 'x\u0000y' }),
    async () => probeHardware({ exec: 5 }),
    async () => probeHardware({ timeoutMs: 1 }),
    async () => probeHardware({ maxOutputBytes: 0 }),
    async () => probeHardware({ unknownKey: true }),
    async () => probeHardware(null),
  ];
  for (const run of bad) await assert.rejects(run, isCode('invalid-options'));

  let invoked = 0;
  const options = {};
  Object.defineProperty(options, 'platform', { enumerable: true, get() { invoked++; return 'win32'; } });
  await assert.rejects(probeHardware(options), isCode('invalid-options'));
  assert.equal(invoked, 0);
});

test('a discrete GPU with at least 4 GiB offloads every layer on a capable machine', () => {
  const plan = recommendRuntime(hardware({ gpus: [gpu('NVIDIA GeForce RTX 4070', 12 * GIB)] }), MODELS);
  assert.equal(plan.verdict, 'ready');
  assert.equal(plan.acceleration, 'gpu');
  assert.equal(plan.gpuLayers, GPU_LAYERS_ALL);
  assert.equal(plan.models.chat, CHAT.id);
  assert.equal(plan.models.embedding, EMBED.id);
  assert.equal(plan.contextSize, RECOMMENDED_CONTEXT_TOKENS);
  assert.equal(plan.threads, 14);
  assert.equal(plan.availableMemoryBytes, 12 * GIB - GPU_RESERVE_BYTES);
  assert.equal(
    plan.estimatedChatMemoryBytes,
    estimateModelMemoryBytes(CHAT.sizeBytes, RECOMMENDED_CONTEXT_TOKENS),
  );
  assert.deepEqual(plan.notices, ['context-capped']);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.models));
  assert.ok(Object.isFrozen(plan.notices));
});

test('a discrete GPU with an unknown memory size is not used for offload', () => {
  const plan = recommendRuntime(
    hardware({ totalMemoryBytes: 32 * GIB, gpus: [{ name: 'NVIDIA GeForce RTX 3060', memoryBytes: null }] }),
    MODELS,
  );
  assert.equal(plan.acceleration, 'cpu');
  assert.ok(plan.notices.includes('vram-unknown'));
  assert.equal(plan.verdict, 'tight');
});

test('the WMI 4095 MiB adapter cap counts as a large GPU', () => {
  const plan = recommendRuntime(hardware({ gpus: [gpu('AMD Radeon RX 7900 XTX', GPU_RAM_REPORT_CAP)] }), MODELS);
  assert.equal(plan.acceleration, 'gpu');
  assert.equal(plan.gpuLayers, GPU_LAYERS_ALL);
  assert.ok(plan.notices.includes('vram-capped'));
});

test('a 16 GiB GPU on a machine with enough RAM is ready', () => {
  const plan = recommendRuntime(
    hardware({ totalMemoryBytes: 16 * GIB, gpus: [gpu('NVIDIA GeForce RTX 4080', 16 * GIB)] }),
    MODELS,
  );
  assert.equal(plan.verdict, 'ready');
  assert.equal(plan.acceleration, 'gpu');
  assert.equal(plan.gpuLayers, GPU_LAYERS_ALL);
});

test('an integrated or software GPU stays on the CPU with zero layers', () => {
  const integrated = recommendRuntime(
    hardware({ totalMemoryBytes: 16 * GIB, gpus: [gpu('Intel(R) UHD Graphics 770', 2 * GIB)] }),
    MODELS,
  );
  assert.equal(integrated.acceleration, 'cpu');
  assert.equal(integrated.gpuLayers, GPU_LAYERS_OFF);
  assert.equal(integrated.verdict, 'tight');
  assert.ok(integrated.notices.includes('integrated-gpu'));

  const software = recommendRuntime(
    hardware({ totalMemoryBytes: 16 * GIB, gpus: [gpu('Microsoft Basic Display Adapter', 0)] }),
    MODELS,
  );
  assert.equal(software.acceleration, 'cpu');
  assert.ok(software.notices.includes('software-gpu'));

  const zeroVram = recommendRuntime(
    hardware({ totalMemoryBytes: 16 * GIB, gpus: [gpu('NVIDIA GeForce GT 710', 0)] }),
    MODELS,
  );
  assert.equal(zeroVram.acceleration, 'cpu');
  assert.ok(zeroVram.notices.includes('vram-unknown'));

  const sharedVram = recommendRuntime(
    hardware({ totalMemoryBytes: 16 * GIB, gpus: [gpu('NVIDIA GeForce GT 710', MIN_USABLE_VRAM_BYTES - 1)] }),
    MODELS,
  );
  assert.equal(sharedVram.acceleration, 'cpu');
  assert.ok(sharedVram.notices.includes('vram-unknown'));
});

test('Apple silicon on arm64 offloads fully through unified memory', () => {
  const plan = recommendRuntime(
    hardware({ platform: 'darwin', arch: 'arm64', cpu: { model: 'Apple M3 Pro', logicalCores: 12 } }),
    MODELS,
  );
  assert.equal(plan.acceleration, 'unified');
  assert.equal(plan.gpuLayers, GPU_LAYERS_ALL);
  assert.ok(plan.notices.includes('unified-memory'));
});

test('a machine with no GPU is CPU-only and tight, and low RAM is called out', () => {
  const noGpu = recommendRuntime(hardware({ totalMemoryBytes: 64 * GIB }), MODELS);
  assert.equal(noGpu.acceleration, 'cpu');
  assert.equal(noGpu.gpuLayers, GPU_LAYERS_OFF);
  assert.equal(noGpu.verdict, 'tight');
  assert.ok(noGpu.notices.includes('no-gpu'));

  const low = recommendRuntime(hardware({ totalMemoryBytes: LOW_MEMORY_BYTES - GIB }), MODELS);
  assert.equal(low.verdict, 'tight');
  assert.ok(low.notices.includes('low-memory'));

  const tiny = recommendRuntime(hardware({ totalMemoryBytes: MIN_MEMORY_BYTES - GIB }), MODELS);
  assert.equal(tiny.verdict, 'insufficient');
  assert.ok(tiny.notices.includes('insufficient-memory'));
});

test('the largest fitting chat model wins and a too-large catalog falls back to the smallest', () => {
  const small = { id: 'chat-small', role: 'chat', sizeBytes: 500 * MIB, contextTokens: 4096 };
  const big = { id: 'chat-big', role: 'chat', sizeBytes: 24 * GIB, contextTokens: 32768 };
  const middle = { id: 'chat-middle', role: 'chat', sizeBytes: 2 * GIB, contextTokens: 8192 };
  const plan = recommendRuntime(hardware({ totalMemoryBytes: 32 * GIB }), [small, middle, big, EMBED]);
  assert.equal(plan.models.chat, 'chat-middle');
  assert.equal(plan.contextSize, 8192);

  const oversized = recommendRuntime(hardware({ totalMemoryBytes: 8 * GIB }), [big, EMBED]);
  assert.equal(oversized.models.chat, big.id);
  assert.equal(oversized.verdict, 'insufficient');
  assert.ok(oversized.notices.includes('model-too-large'));
});

test('a GPU budget that cannot hold the smallest chat model falls back to RAM', () => {
  const plan = recommendRuntime(
    hardware({ totalMemoryBytes: 32 * GIB, gpus: [gpu('NVIDIA GeForce GTX 1650', 4 * GIB)] }),
    [{ id: 'chat-big', role: 'chat', sizeBytes: 5 * GIB, contextTokens: 8192 }, EMBED],
  );
  assert.equal(plan.acceleration, 'cpu');
  assert.equal(plan.gpuLayers, GPU_LAYERS_OFF);
  assert.ok(plan.notices.includes('model-exceeds-vram'));
  assert.equal(plan.availableMemoryBytes, Math.floor(32 * GIB * RAM_BUDGET_FRACTION));
});

test('Apple silicon keeps unified memory even when no model fits', () => {
  const plan = recommendRuntime(
    hardware({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 4 * GIB }),
    MODELS,
  );
  assert.equal(plan.acceleration, 'unified');
  assert.equal(plan.gpuLayers, GPU_LAYERS_ALL);
  assert.equal(plan.verdict, 'insufficient');
  assert.ok(plan.notices.includes('insufficient-memory'));
});

test('threads leave two cores free and are capped', () => {
  const one = recommendRuntime(hardware({ cpu: { model: 'cpu', logicalCores: 1 } }), MODELS);
  assert.equal(one.threads, 1);
  const two = recommendRuntime(hardware({ cpu: { model: 'cpu', logicalCores: 2 } }), MODELS);
  assert.equal(two.threads, 1);
  const eight = recommendRuntime(hardware({ cpu: { model: 'cpu', logicalCores: 8 } }), MODELS);
  assert.equal(eight.threads, 8 - RESERVED_CPU_CORES);
  const big = recommendRuntime(hardware({ cpu: { model: 'cpu', logicalCores: 64 } }), MODELS);
  assert.equal(big.threads, MAX_RECOMMENDED_THREADS);
  assert.ok(big.notices.includes('thread-cap'));
});

test('a context above the recommendation is capped with a notice', () => {
  const plan = recommendRuntime(hardware(), MODELS);
  assert.equal(plan.contextSize, RECOMMENDED_CONTEXT_TOKENS);
  assert.ok(plan.notices.includes('context-capped'));

  const small = recommendRuntime(hardware(), [{ id: 'chat-4k', role: 'chat', sizeBytes: 500 * MIB, contextTokens: 4096 }, EMBED]);
  assert.equal(small.contextSize, 4096);
  assert.equal(small.notices.includes('context-capped'), false);
});

test('the pinned catalog recommendation is the shipped chat and embedding models', () => {
  const plan = recommendRuntime(hardware({ totalMemoryBytes: 16 * GIB }), MODELS);
  assert.equal(plan.models.chat, 'chat-1.5b');
  assert.equal(plan.models.embedding, 'embed-0.6b');
  assert.equal(plan.estimatedEmbeddingMemoryBytes, estimateModelMemoryBytes(EMBED.sizeBytes, RECOMMENDED_EMBEDDING_CONTEXT_TOKENS));
  assert.equal(plan.notices.indexOf('low-memory'), -1);
});

test('recommendRuntime rejects a malformed hardware descriptor without invoking a getter', () => {
  const base = hardware();
  const bad = [
    null,
    5,
    [],
    { ...base, platform: 'plan9' },
    { ...base, arch: 'mips' },
    { ...base, unknownKey: 1 },
    { ...base, cpu: { model: 'x' } },
    { ...base, cpu: { model: 'x', logicalCores: 0 } },
    { ...base, cpu: { model: 'x\u2028y', logicalCores: 4 } },
    { ...base, totalMemoryBytes: 0 },
    { ...base, totalMemoryBytes: 1.5 },
    { ...base, totalMemoryBytes: 2 ** 60 },
    { ...base, freeMemoryBytes: 64 * GIB },
    { ...base, gpus: null },
    { ...base, gpus: [gpu('x', -1)] },
    { ...base, gpus: [gpu('x', 2 ** 60)] },
    { ...base, gpus: [gpu('', 1)] },
    { ...base, gpus: [{ name: 'x', kind: 'acme', memoryBytes: 1 }] },
    { ...base, gpus: [{ name: 'x', vendor: 'acme', memoryBytes: 1 }] },
    { ...base, gpus: Array.from({ length: MAX_GPU_COUNT + 1 }, (_, i) => gpu('gpu ' + i, 1)) },
  ];
  for (const value of bad) assert.throws(() => recommendRuntime(value, MODELS), isCode('invalid-options'));

  const sparse = new Array(2);
  sparse[1] = gpu('x', 1);
  assert.throws(() => recommendRuntime({ ...base, gpus: sparse }, MODELS), isCode('invalid-options'));
  assert.throws(() => recommendRuntime({ ...base, cpu: new (class Cpu {})() }, MODELS), isCode('invalid-options'));
  assert.throws(
    () => recommendRuntime({ ...base, ...JSON.parse('{"__proto__":{"polluted":true}}') }, MODELS),
    isCode('invalid-options'),
  );
  assert.equal({}.polluted, undefined);

  let invoked = 0;
  const hostile = { ...base };
  Object.defineProperty(hostile, 'totalMemoryBytes', { enumerable: true, get() { invoked++; return 32 * GIB; } });
  assert.throws(() => recommendRuntime(hostile, MODELS), isCode('invalid-options'));
  assert.equal(invoked, 0);

  let gpuInvoked = 0;
  const hostileGpu = { name: 'x', memoryBytes: 1 };
  Object.defineProperty(hostileGpu, 'vendor', { enumerable: true, get() { gpuInvoked++; return 'nvidia'; } });
  assert.throws(() => recommendRuntime({ ...base, gpus: [hostileGpu] }, MODELS), isCode('invalid-options'));
  assert.equal(gpuInvoked, 0);
});

test('recommendRuntime rejects a malformed model list', () => {
  const hw = hardware();
  const bad = [
    null,
    {},
    [CHAT, CHAT],
    [CHAT, { ...EMBED, id: CHAT.id }],
    [CHAT, { id: 'x', role: 'image', sizeBytes: 1, contextTokens: 4096 }],
    [CHAT, { id: 'x', role: 'embedding', sizeBytes: 0, contextTokens: 4096 }],
    [CHAT, { id: 'x', role: 'embedding', sizeBytes: 1, contextTokens: 0 }],
    [CHAT, { id: 'x', role: 'embedding', sizeBytes: 1, contextTokens: 1_048_577 }],
    [CHAT, { id: 'x', role: 'embedding', sizeBytes: 1, contextTokens: 4096, extra: true }],
    [CHAT, { id: 'x', role: 'embedding', sizeBytes: 1024 * GIB, contextTokens: 4096 }],
    [CHAT, EMBED, ...Array.from({ length: MAX_MODELS }, (_, i) => (
      { id: 'extra-' + i, role: 'embedding', sizeBytes: 1, contextTokens: 4096 }
    ))],
    [{ id: 'UPPER', role: 'chat', sizeBytes: 1, contextTokens: 4096 }, EMBED],
  ];
  for (const models of bad) assert.throws(() => recommendRuntime(hw, models), isCode('invalid-options'));

  let invoked = 0;
  const hostile = { ...EMBED };
  Object.defineProperty(hostile, 'sizeBytes', { enumerable: true, get() { invoked++; return 1; } });
  assert.throws(() => recommendRuntime(hw, [CHAT, hostile]), isCode('invalid-options'));
  assert.equal(invoked, 0);
});

test('a missing chat or embedding role fails closed with its own code', () => {
  assert.throws(() => recommendRuntime(hardware(), []), isCode('no-chat-model'));
  assert.throws(() => recommendRuntime(hardware(), [EMBED]), isCode('no-chat-model'));
  assert.throws(() => recommendRuntime(hardware(), [CHAT]), isCode('no-embedding-model'));
});

test('neither the inputs nor the plan alias each other', () => {
  const hw = hardware({ gpus: [gpu('NVIDIA GeForce RTX 3060', 12 * GIB)] });
  const models = [{ ...CHAT }, { ...EMBED }];
  const snapshot = JSON.stringify({ hw, models });
  const plan = recommendRuntime(hw, models);
  assert.equal(JSON.stringify({ hw, models }), snapshot);
  assert.notEqual(plan.models, models);
  assert.throws(() => { plan.models.chat = 'other'; });
  assert.throws(() => { plan.notices.push('x'); });
  assert.throws(() => { plan.gpuLayers = 0; });
  assert.deepEqual(recommendRuntime(hw, models), plan);
});

test('a repeated notice is reported once', () => {
  const hugeChat = { id: 'chat-huge', role: 'chat', sizeBytes: 400 * GIB, contextTokens: 4096 };
  const hugeEmbed = { id: 'embed-huge', role: 'embedding', sizeBytes: 400 * GIB, contextTokens: 4096 };
  const plan = recommendRuntime(hardware({ totalMemoryBytes: 16 * GIB }), [hugeChat, hugeEmbed]);
  assert.equal(plan.notices.filter((notice) => notice === 'model-too-large').length, 1);
});

test('the estimate is the model plus runtime overhead plus a per-token cache', () => {
  assert.equal(estimateModelMemoryBytes(1_000_000, 4096), 1_000_000 + 512 * MIB + 4096 * 16 * 1024);
  assert.throws(() => estimateModelMemoryBytes(-1, 4096), isCode('invalid-options'));
  assert.throws(() => estimateModelMemoryBytes(1, -1), isCode('invalid-options'));
  assert.throws(() => estimateModelMemoryBytes(1.5, 4096), isCode('invalid-options'));
});

test('the default child runner is bounded by its timeout', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the PowerShell child runner is Windows-only');
    return;
  }
  await assert.rejects(
    defaultExec({ script: 'Start-Sleep -Seconds 30', timeoutMs: 100 }),
    isCode('gpu-probe-failed'),
  );
});

test('the default child runner uses the absolute system PowerShell non-interactively', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the PowerShell child runner is Windows-only');
    return;
  }
  const script = [
    '$p = [System.Diagnostics.Process]::GetCurrentProcess().Path',
    '$c = [Environment]::CommandLine',
    '[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)))',
    '[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c)))',
  ].join('\n');
  const result = await defaultExec({ script, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  assert.equal(result.code, 0);
  const [pathLine, commandLine] = result.stdout.trim().split(/\r?\n/);
  const executable = Buffer.from(pathLine, 'base64').toString('utf8');
  const command = Buffer.from(commandLine, 'base64').toString('utf8');
  assert.match(executable.toLowerCase(), /[\\/]system32[\\/]windowspowershell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.match(command, /-NoLogo/);
  assert.match(command, /-NoProfile/);
  assert.match(command, /-NonInteractive/);
  assert.match(command, /-EncodedCommand/);
});

test('the child runner does not inherit the parent environment', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the PowerShell child runner is Windows-only');
    return;
  }
  const canary = 'VIBE_PROBE_CANARY_ENV';
  process.env[canary] = 'do-not-leak';
  t.after(() => { delete process.env[canary]; });
  const script = [
    '[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$env:' + canary + ')))',
    '[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$env:PATH)))',
  ].join('\n');
  const result = await defaultExec({ script, timeoutMs: 15000 });
  assert.equal(result.code, 0);
  const lines = result.stdout.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const [canaryValue, childPath] = lines.map((line) => Buffer.from(line, 'base64').toString('utf8'));
  assert.equal(canaryValue, '');
  assert.equal(childPath, '');
});

test('a hostile proxy is rejected without running a trap', () => {
  let traps = 0;
  const target = hardware();
  const proxy = new Proxy(target, {
    getPrototypeOf() { traps++; return Object.prototype; },
    get() { traps++; return undefined; },
    getOwnPropertyDescriptor() { traps++; return undefined; },
    ownKeys() { traps++; return Reflect.ownKeys(target); },
  });
  assert.equal(types.isProxy(proxy), true);
  assert.throws(() => recommendRuntime(proxy, MODELS), isCode('invalid-options'));
  assert.equal(traps, 0);
  const gpuProxy = new Proxy({ name: 'x', memoryBytes: 1 }, {});
  assert.throws(() => recommendRuntime({ ...hardware(), gpus: [gpuProxy] }, MODELS), isCode('invalid-options'));
});

test('the probe enforces its own deadline on a runner that never settles', async () => {
  const started = Date.now();
  const result = await probeHardware({
    platform: 'win32',
    timeoutMs: 100,
    exec: () => new Promise(() => {}),
  });
  assert.deepEqual(result.notices, ['gpu-probe-failed']);
  assert.ok(Date.now() - started < 5000);
});

test('the default CPU name is sanitized and the PowerShell root must be absolute', async () => {
  const result = await probeHardware({ platform: 'linux', arch: 'x64' });
  assert.ok(result.hardware.cpu.model.length > 0 && result.hardware.cpu.model.length <= 200);
  assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(result.hardware.cpu.model), false);
  assert.equal(
    powershellPath({ SystemRoot: 'Windows' }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(
    powershellPath({ SystemRoot: '..\\Windows' }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
});

test('the default child runner rejects an answer above its output cap', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the PowerShell child runner is Windows-only');
    return;
  }
  await assert.rejects(
    defaultExec({
      script: '[Console]::Out.WriteLine(("x" * 4096))',
      timeoutMs: 15000,
      maxOutputBytes: 1024,
    }),
    isCode('gpu-probe-failed'),
  );
});

test('vendor families map to the right adapter kind', () => {
  const plan = (name, memoryBytes) => recommendRuntime(
    hardware({ totalMemoryBytes: 32 * GIB, gpus: [gpu(name, memoryBytes)] }),
    MODELS,
  );
  const qualcomm = plan('Qualcomm Adreno 740', 2 * GIB);
  assert.equal(qualcomm.acceleration, 'cpu');
  assert.ok(qualcomm.notices.includes('integrated-gpu'));

  const amdApu = plan('AMD Radeon(TM) Graphics', 2 * GIB);
  assert.equal(amdApu.acceleration, 'cpu');
  assert.ok(amdApu.notices.includes('integrated-gpu'));

  const amdCard = plan('AMD Radeon RX 7800 XT', 16 * GIB);
  assert.equal(amdCard.acceleration, 'gpu');
  assert.equal(amdCard.gpuLayers, GPU_LAYERS_ALL);

  const intelArc = plan('Intel(R) Arc(TM) A770 Graphics', 16 * GIB);
  assert.equal(intelArc.acceleration, 'gpu');

  const remote = plan('Parsec Virtual Display Adapter', 0);
  assert.equal(remote.acceleration, 'cpu');
  assert.ok(remote.notices.includes('software-gpu'));
});

test('an injected total memory clamps the default free memory', async () => {
  const result = await probeHardware({ platform: 'linux', totalMemoryBytes: 512 * MIB });
  assert.equal(result.hardware.totalMemoryBytes, 512 * MIB);
  assert.ok(result.hardware.freeMemoryBytes <= 512 * MIB);
  assert.ok(result.hardware.freeMemoryBytes >= 0);
});

test('a real probe on this host reports bounded facts and never throws', async (t) => {
  let result;
  try {
    result = await probeHardware();
  } catch (error) {
    t.skip('the host cannot run the local probe: ' + (error && error.code));
    return;
  }
  const total = os.totalmem();
  assert.ok(Number.isInteger(result.hardware.totalMemoryBytes) && result.hardware.totalMemoryBytes > MIB);
  assert.equal(result.hardware.platform, process.platform);
  assert.ok(result.hardware.cpu.logicalCores >= 1);
  assert.ok(result.hardware.totalMemoryBytes <= total * 1.5);
  assert.ok(Array.isArray(result.hardware.gpus));
  for (const card of result.hardware.gpus) {
    assert.ok(card.name.length > 0);
    assert.ok(Number.isInteger(card.memoryBytes) && card.memoryBytes >= 0);
  }
  const plan = recommendRuntime(result.hardware, MODELS);
  assert.ok(['ready', 'tight', 'insufficient'].includes(plan.verdict));
  assert.equal(plan.models.chat, CHAT.id);
});
