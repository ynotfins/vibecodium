# M3 hardware probe and local runtime recommendation

> Doc class: living - Owner: vibe-overseer - Last reviewed: 2026-11-26
>
> First-run hardware detection. The module lives in
> [hardware-probe.mjs](../../../src/stable/runtime/hardware-probe.mjs) and the acceptance tests in
> [hardware-probe.test.mjs](../../../tests/vibe/hardware-probe.test.mjs). It sits beside the
> supervisor in [m3-llama-server.md](m3-llama-server.md) and the downloader in
> [m3-model-downloader.md](m3-model-downloader.md), and is intended to feed the first-run wizard.

## Scope

This is M3's third slice: deciding what the machine can run. It ships a bounded hardware probe (RAM,
CPU count and, on Windows, the display adapters) and a pure policy that maps those facts plus the
pinned model catalog to a frozen start plan for the local B1 provider: the model choice and the
context, thread and GPU-layer numbers its `llama-server` flags use. It does not spawn
`llama-server`, download weights, render the wizard, restart a failed server, detect Ollama or call a
provider. Node built-ins only.

## What is collected

`probeHardware(options)` returns `{ version, hardware, notices }` and never throws for a GPU failure.
`options` may inject `platform`, `arch`, `cpuModel`, `logicalCores`, `totalMemoryBytes`,
`freeMemoryBytes`, `timeoutMs` and `maxOutputBytes`, and may supply an `exec` runner; unknown keys,
accessors and out-of-range values fail closed with `invalid-options`. `timeoutMs` is bounded to
50-60,000 ms and `maxOutputBytes` to 1 byte-64 KiB.

| Field | Source | Bound |
|---|---|---|
| `platform` | `process.platform` or the injected value | `win32`, `linux`, `darwin` |
| `arch` | `process.arch` or the injected value | `x64`, `arm64`, `arm`, `ia32` |
| `cpu.model` | `os.cpus()[0].model` | 1 to 200 characters, no control or bidi |
| `cpu.logicalCores` | `os.cpus().length` | 1 to 1024 |
| `totalMemoryBytes` | `os.totalmem()` | 1 to 2^53-1 |
| `freeMemoryBytes` | `os.freemem()`, clamped to the total | 0 to the total |
| `gpus[]` | the fixed Windows query below | 0 to 8 cards |

The GPU list is collected by one read-only CIM query for `Win32_VideoController`. The script is
exported as `GPU_PROBE_SCRIPT` and runs through the absolute system
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` with `-NoLogo -NoProfile -NonInteractive
-EncodedCommand`, no shell, no stdin, `windowsHide`, a 5-second default timeout and a 64 KiB output
cap. A relative or drive-relative `SystemRoot` (or the `windir` fallback) is not trusted for the
executable path, and `C:\Windows` is used in its place. The child environment is built from only `SystemRoot`, `windir`, `TEMP`, `TMP`
and an empty `PATH`; Windows still exposes a small fixed set of OS identity and shell-path variables
(home, user, domain, logon server, system drive, module path and similar) to the child, but no
arbitrary parent variable such as a provider key reaches it, and the probe also enforces the same
deadline around an injected runner so a runner that never settles cannot hang it. Each card is one
line: the base64 of its UTF-8 name, a tab and its decimal `AdapterRAM`. A name can therefore never inject a delimiter or a newline into the stream.

`parseGpuProbeOutput` accepts only that shape: two tab-separated fields, canonical base64 with a valid
UTF-8 payload, the name non-empty, at most 200 characters and free of control or bidi characters, and
a decimal size of at most 15 digits. Any other line, an interior blank line, more than eight cards or
an answer above the cap is rejected. A rejected answer is never partially used: a partly understood GPU list is
worse than none, because the plan would offload to the wrong device.

A failed spawn, a timeout, a non-zero exit or a malformed answer object becomes the notice
`gpu-probe-failed` and an empty GPU list; an answer above the probe's own cap, or text the parser
rejects, becomes `gpu-probe-invalid` instead. The shipped runner rejects an over-cap answer before it
returns; a custom runner that returns one is caught by the probe's own cap check as
`gpu-probe-invalid`. The child output is never surfaced, so a path or a
driver message in `stderr` cannot leak. A non-Windows platform never shells out and reports
`gpu-probe-unavailable`. An empty GPU list from a successful query reports `gpu-probe-empty`.

GPU classification is name-based and documented in `classifyGpu`: vendor `nvidia`, `amd`, `intel`,
`apple`, `qualcomm`, `microsoft` or `unknown`; kind `discrete`, `integrated` or `software`. A software
adapter is a basic, virtual, remote or software-rendered display. Qualcomm and Apple adapters are
integrated. Intel adapters are integrated except an Arc card; an AMD adapter without `RX`,
`Radeon Pro`, `FirePro` or `Instinct` is integrated.

## The recommendation

`recommendRuntime(hardware, models)` is pure. `models` is an array of at most 16
`{ id, role, sizeBytes, contextTokens }` entries where `role` is `chat` or `embedding`, the id is a
lowercase identifier of 1 to 64 characters, `sizeBytes` is between 1 byte and 512 GiB and
`contextTokens` is between 128 and 1,048,576; the first-run wizard is expected to project the pinned
entries from `vibe/models/catalog.json` to exactly those four fields, because the validator rejects
every other catalog field (`label`, `repo`, `revision`, `file`, `url`, `sha256`, `license` and
`quantization`). A missing chat or embedding role fails closed as
`no-chat-model` or `no-embedding-model`. Every object is read through own data descriptors, so an
accessor is rejected without being invoked and an object Proxy is rejected before any trap can run.
The GPU and model arrays are read element by element through own descriptors: an accessor element, a
hole or a throwing trap fails closed, while a Proxy array that answers with data properties is accepted
as the caller supplied it. Unknown or reserved keys and duplicate model ids fail closed. A GPU entry
may carry `vendor` and `kind`, but
they must match the name-derived classification, and its `memoryBytes` is null or an integer from 0
to 2^53-1. The OS CPU name is stripped of control and bidi characters, whitespace-collapsed and
length-bounded before it enters the descriptor.

Memory is estimated as `sizeBytes + 512 MiB + contextTokens * 16 KiB`. The first term is the weights,
the second a runtime allowance for the loader and non-cached buffers, the third a coarse KV-cache
approximation for a small model in f16. It is a documented heuristic, not a measurement.

Free memory is reported for the wizard, but the policy uses total memory: it is the stable number a
user can compare against a model, while free memory moves with every other open application.

| Rule | Value | Consequence |
|---|---|---|
| RAM budget | 75% of total memory | leaves a quarter to the OS and the editor |
| GPU budget | largest discrete card's memory minus 512 MiB | the reserve covers compute buffers |
| Usable VRAM | at least 512 MiB, known | a smaller or unknown size is not used |
| WMI cap | 4095 MiB up to (but not including) 4 GiB | reported as 4095 MiB with notice `vram-capped`; offload still needs the model to fit the 3583 MiB budget left after the GPU reserve |
| Offload | every layer (`--n-gpu-layers 999`) | only when the smallest chat model fits the GPU budget |
| Apple silicon | `darwin` + `arm64` | unified memory, every layer, no GPU query needed |
| Integrated or software GPU | any | CPU only, zero layers |
| Chat pick | largest chat model that fits the chosen budget | otherwise the smallest, verdict `insufficient` (a GPU that cannot hold the smallest chat model first falls back to the RAM budget) |
| Context | at most 8192 tokens for chat, 2048 for embeddings | larger model contexts are capped |
| Threads | cores minus two, at least 1 and at most 16 | the editor keeps two cores |

The verdict is `insufficient` when total memory is below 8 GiB or the smallest chat model does not fit
the chosen budget, `tight` on a CPU-only machine or below 16 GiB, and `ready` otherwise. Notices are
codes in a fixed order and are de-duplicated: `no-gpu`, `integrated-gpu`, `software-gpu`,
`vram-unknown` (a discrete adapter with unknown or under-512-MiB memory, when no integrated or
software adapter is present), `vram-capped`,
`model-exceeds-vram` (a GPU exists but the model does not fit, so the plan falls back to the CPU),
`unified-memory`, `low-memory`, `insufficient-memory`, `model-too-large` (no chat model fits the
chosen budget, or the embedding estimate exceeds the RAM budget), `context-capped` and `thread-cap`. The first-run wizard will merge them with the probe notices.

The returned plan is frozen data: `version`, `verdict`, `acceleration` (`gpu`, `unified` or `cpu`),
`gpuLayers`, `threads`, `contextSize` (the chat context; the embedding estimate uses its own 2048
cap), `models.chat`, `models.embedding`, `estimatedChatMemoryBytes`,
`estimatedEmbeddingMemoryBytes`, `availableMemoryBytes` (the budget the
chat model was measured against: the VRAM budget when offloading, otherwise 75% of total RAM),
`totalMemoryBytes` and `notices`. The input hardware descriptor and the model list are never mutated
or aliased.

## Security boundary

The probe runs one fixed read-only query and passes no caller input to it. It never writes, never
installs anything and never touches the network. The child is the absolute system PowerShell, never a
bare name, so a workspace cannot shadow it. The optional `exec` option is a trusted caller and test
seam: a caller that supplies one runs its own child, exactly as the supervisor trusts a
caller-supplied binary, and the product wiring leaves it unset. The GPU answer is parsed under a byte
cap and every field is bounded before it reaches the plan; a hostile or corrupt answer is discarded
with a notice rather than trusted. The recommendation only decides numbers for `llama-server` flags;
the supervisor still validates every flag, the executable and the model path on its own.

Residual risks: the CIM query can take a second or more on a busy machine, so the first-run wizard
should show progress while the probe runs rather than before it. `Win32_VideoController.AdapterRAM`
is a UInt32 and caps near 4 GiB, so a large card's exact size is unknown; the plan only needs to know
that it is large. A device name is a heuristic: a mislabelled adapter could be classified as discrete
when it shares system memory, which would offload to a slow path, not corrupt anything. The probe does
not detect NVIDIA's exact VRAM through NVML, AMD's through ADL, or an eGPU, and it treats a laptop's
hybrid graphics as the listed adapters only. Software display adapters (for example a
`Meta Virtual Monitor`) are ignored as offload targets rather than contributing a GPU.

## Verification

`node --test tests/vibe/hardware-probe.test.mjs` runs the parser over valid and hostile lines, the probe
with injected facts and a fake child runner (success, throw, non-zero exit, oversized and unparseable
answers, no shell-out off Windows), the real child runner's absolute PowerShell path, non-interactive
flags, timeout and output cap, and the policy over discrete, capped, integrated, software, unified,
CPU-only, low-memory and too-large configurations. It also covers every rejected descriptor and model
field without invoking a getter, frozen outputs, no input aliasing and a real read-only probe on the
test host.

The full acceptance uses `node vibe/tools/verify.mjs --strict` and
`node vibe/tools/docs-check.mjs --strict`.

## Next steps

The first-run wizard is delivered in [m3-first-run-wizard.md](m3-first-run-wizard.md) together with its
on-demand install of the pinned `llama-server` (the pin and verified installer are in
[m3-sidecar-binary.md](m3-sidecar-binary.md)); the remaining runtime work is one live install/start
smoke and copying the installed files and `vibe/models/catalog.json` into the packaged application
(with `--embedding --pooling last -ub 8192` for the pinned embedding weights). Ollama detection and
the supervisor's opt-in restart/back-off policy have since been delivered.
