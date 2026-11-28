#!/usr/bin/env node
// M2 B1 live provider smoke.
//
// Opt-in, not part of `verify.mjs`: it needs the network and a provider key in the environment, and
// it spends a few hundred tokens on an account the caller already has. It proves the shipped
// provider path against the live endpoints on the machine it runs on:
//
//   1. every selected B1 external preset whose key, base URL and model exist is asked a short
//      chat turn, the same turn streamed, and one tool definition through `provider-client.mjs`;
//   2. embeddings are exercised only when the caller names an embedding model for that provider
//      and the preset advertises the capability;
//   3. when Morph is configured, an ordered fallback with a stopped OmniRoute endpoint in front of
//      the live direct provider must answer on Morph in the same turn (`provider-fallback.mjs`),
//      which is the B2/B6 acceptance path with a real second provider.
//
//   node vibe/tools/provider-smoke.mjs [--provider morph,deepinfra] [--model deepinfra=zai-org/GLM-5.3]
//
// A provider whose environment variable is absent is reported as SKIP, never as a failure: the
// variable name may appear in the report, a value never does. Every printed line passes through a
// redactor seeded with the resolved keys, and no request header or key is stored or echoed.

import { pathToFileURL } from 'node:url';

import { createProviderClient } from '../../src/stable/gateway/provider-client.mjs';
import { createProviderFallback } from '../../src/stable/gateway/provider-fallback.mjs';
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  validateProviderBaseUrl,
  validateProviderModel,
} from '../../src/stable/gateway/provider-presets.mjs';

export const PROVIDER_SMOKE_VERSION = 1;
// The product requires an exact host allow for a remote provider, so the smoke derives one per run
// from the URL it is about to use instead of switching the whole external-provider category on.
export function smokePolicyFor(baseUrl) {
  // The policy core compares `allowHosts` entries against the URL's hostname, without a port.
  return Object.freeze({ allowHosts: Object.freeze([new URL(baseUrl).hostname]) });
}
// The B1 presets that reach a hosted service. The two `local` presets are covered by
// `vibe/tools/local-runtime-smoke.mjs` and by the first-run wizard tests.
export const SMOKE_PROVIDERS = Object.freeze(
  PROVIDER_PRESETS.filter((preset) => preset.local !== true).map((preset) => preset.id),
);
export const DEFAULT_TIMEOUT_MS = 90_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
// A reasoning row spends part of the budget on `reasoning_content`, which is not answer text. On
// 2026-11-28 DeepInfra's GLM-5.3 returned an empty answer with `finish_reason: 'length'` at 256
// tokens after 29.9 s, while 1024 answered in seconds, so the cap leaves real headroom while a
// one-word turn still costs well under a cent.
export const SMOKE_MAX_TOKENS = 1024;
export const MAX_STEP_DETAIL_CHARS = 240;
export const MAX_SAMPLE_CHARS = 24;
export const MAX_FINISH_REASON_CHARS = 32;
// Control, del, C1, format, line- and paragraph-separator characters would break the one-line-per-
// step report or let a provider reorder it (bidi overrides), so they are stripped from any text the
// provider supplies.
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu;
export const STOPPED_PRIMARY_BASE_URL = 'http://127.0.0.1:1/v1';
export const STOPPED_PRIMARY_MODEL = 'stopped-omniroute';
export const STOPPED_PRIMARY_TIMEOUT_MS = 5_000;
export const CHAT_MESSAGES = Object.freeze([
  Object.freeze({ role: 'user', content: 'Reply with the single word: pong' }),
]);
export const TOOL_MESSAGES = Object.freeze([
  Object.freeze({ role: 'user', content: 'Use the lookup tool to find x.' }),
]);
export const TOOL_DEFINITIONS = Object.freeze([Object.freeze({
  type: 'function',
  function: Object.freeze({
    name: 'lookup',
    description: 'Look up a fact',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({ q: Object.freeze({ type: 'string' }) }),
      required: Object.freeze(['q']),
    }),
  }),
})]);
export const EMBEDDING_INPUTS = Object.freeze(['hello world', 'second text']);

class SmokeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SmokeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SmokeError(code, message);
}

function expect(condition, code, message) {
  if (!condition) fail(code, message);
}

function integerOption(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('invalid-argument', `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

// Control characters would break the one-line-per-step report, and a provider's answer is
// untrusted text, so a sample is flattened and capped.
function sample(value) {
  const text = String(value).replace(UNSAFE_TEXT, ' ').trim();
  return text.slice(0, MAX_SAMPLE_CHARS);
}

// `finish_reason` is provider text as well: it is bounded and stripped of control and bidi
// characters before it reaches a diagnostic message or the report.
function boundedFinishReason(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(UNSAFE_TEXT, '').trim().slice(0, MAX_FINISH_REASON_CHARS);
  return text.length > 0 ? text : null;
}

// Argument text is caller-supplied and could itself carry a credential or a control character, so a
// refusal names the flag and never echoes the value.
function requireSmokeProvider(value) {
  if (!SMOKE_PROVIDERS.includes(value)) {
    if (PROVIDER_PRESETS.some((preset) => preset.id === value)) {
      fail('unsupported-provider', 'that provider is a local preset; use vibe/tools/local-runtime-smoke.mjs');
    }
    fail('unsupported-provider', 'that provider is not a B1 external provider');
  }
  return value;
}

function assignment(value, label, seen) {
  const index = value.indexOf('=');
  if (index <= 0 || index === value.length - 1) {
    fail('invalid-argument', `${label} must be <provider>=<model>`);
  }
  const provider = requireSmokeProvider(value.slice(0, index));
  if (Object.prototype.hasOwnProperty.call(seen, provider)) {
    fail('invalid-argument', `${label} names ${provider} twice`);
  }
  let model;
  try {
    model = validateProviderModel(value.slice(index + 1));
  } catch {
    fail('invalid-argument', `${label} has an invalid model for ${provider}`);
  }
  seen[provider] = model;
  return provider;
}

export function parseArgs(argv = []) {
  const providers = [];
  const models = Object.create(null);
  const embeddingModels = Object.create(null);
  const options = { help: false, noEmbeddings: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  const withValue = new Set(['--provider', '--model', '--embedding-model', '--timeout-ms']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (flag === '--no-embeddings') { options.noEmbeddings = true; continue; }
    if (!withValue.has(flag)) {
      const safe = /^--?[A-Za-z0-9][A-Za-z0-9-]{0,40}$/.test(flag) ? `: ${flag}` : '';
      fail('invalid-argument', `unknown argument${safe}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('invalid-argument', `${flag} needs a value`);
    index += 1;
    if (flag === '--provider') {
      for (const id of value.split(',')) {
        if (id.length === 0) fail('invalid-argument', '--provider has an empty entry');
        const provider = requireSmokeProvider(id);
        if (providers.includes(provider)) fail('invalid-argument', `--provider names ${provider} twice`);
        providers.push(provider);
      }
    }
    if (flag === '--model') assignment(value, '--model', models);
    if (flag === '--embedding-model') assignment(value, '--embedding-model', embeddingModels);
    if (flag === '--timeout-ms') options.timeoutMs = integerOption(value, 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  }
  return Object.freeze({
    help: options.help,
    noEmbeddings: options.noEmbeddings,
    timeoutMs: options.timeoutMs,
    providers: Object.freeze(providers),
    models: Object.freeze({ ...models }),
    embeddingModels: Object.freeze({ ...embeddingModels }),
  });
}

// A provider runs only when a request could actually be made. A missing key, endpoint or model is a
// skip with a reason, not a failure: the smoke reports what this host can prove.
function planProvider(id, options, env, baseUrls) {
  const preset = getProviderPreset(id);
  const keyEnv = preset.apiKeyEnv;
  const key = keyEnv === undefined ? undefined : env[keyEnv];
  const keyPresent = typeof key === 'string' && key.length > 0;
  if (preset.apiKeyRequired === true && !keyPresent) return { skip: 'no-key', envVar: keyEnv };
  const rawBaseUrl = baseUrls[id] ?? preset.baseUrl ?? (preset.baseUrlEnv === undefined ? undefined : env[preset.baseUrlEnv]);
  if (typeof rawBaseUrl !== 'string' || rawBaseUrl.length === 0) {
    return { skip: 'no-base-url', envVar: preset.baseUrlEnv };
  }
  // Validate before anything else touches the value: an unvalidated URL can carry a credential in
  // its userinfo, so neither the raw string nor a validation error that quotes it may be printed.
  let baseUrl;
  try {
    baseUrl = validateProviderBaseUrl(rawBaseUrl);
  } catch (error) {
    return { invalid: true, message: error && typeof error.message === 'string' ? error.message : 'baseUrl is invalid' };
  }
  const model = options.models[id] ?? preset.defaultModel;
  if (typeof model !== 'string' || model.length === 0) return { skip: 'no-model' };
  return { preset, baseUrl, model };
}

function summarize(error, redact) {
  const code = error && typeof error.code === 'string' ? error.code : 'failed';
  const message = String(error && error.message ? error.message : error);
  return { code, message: redact(message).slice(0, MAX_STEP_DETAIL_CHARS) };
}

// The answer shape a failure diagnostic can report without the body: how much text came back and
// why the provider stopped. `finish_reason: 'length'` separates a truncated reasoning trace from a
// provider defect.
function answerFacts(answer) {
  const text = answer.text.trim();
  const outputTokens = answer.usage && Number.isInteger(answer.usage.outputTokens)
    ? answer.usage.outputTokens
    : null;
  const totalTokens = answer.usage && Number.isInteger(answer.usage.totalTokens)
    ? answer.usage.totalTokens
    : null;
  return { text, finishReason: boundedFinishReason(answer.finishReason), outputTokens, totalTokens };
}

function emptyAnswerMessage(label, facts) {
  return `${label} (finish_reason=${String(facts.finishReason)}, output_tokens=${String(facts.outputTokens)}, total_tokens=${String(facts.totalTokens)})`;
}

function defaultDependencies() {
  return {
    env: process.env,
    baseUrls: Object.create(null),
    createClient: createProviderClient,
    createFallback: createProviderFallback,
    print: (line) => console.log(line),
  };
}

export async function runSmoke(options = {}, overrides = {}) {
  options = Object.freeze({ ...parseArgs([]), ...options });
  const deps = { ...defaultDependencies(), ...overrides };

  const selected = options.providers.length > 0 ? options.providers : SMOKE_PROVIDERS;
  // Seed the redactor from every key this run could read, whichever provider ends up skipped.
  const secrets = [];
  for (const id of selected) {
    const preset = getProviderPreset(id);
    const value = preset.apiKeyEnv === undefined ? undefined : deps.env[preset.apiKeyEnv];
    if (typeof value === 'string' && value.length > 0) secrets.push(value);
  }
  const redact = (value) => {
    let text = String(value);
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return text;
  };

  const startedAt = Date.now();
  const steps = [];
  const providers = [];
  const clients = Object.create(null);
  let failed = false;
  let failedSteps = 0;

  const emit = (line) => deps.print(redact(line));
  const record = (name, entry) => {
    const step = Object.freeze({ name, ...entry });
    steps.push(step);
    const detail = entry.skipped === true
      ? { reason: entry.reason, ...(entry.envVar === undefined ? {} : { envVar: entry.envVar }) }
      : entry.detail;
    emit(`${entry.skipped === true ? 'SKIP' : entry.ok === true ? 'PASS' : 'FAIL'} ${name} ${entry.seconds}s ${JSON.stringify(detail)}`);
    return step;
  };
  const skip = (name, reason, envVar) => record(name, {
    ok: true, skipped: true, reason, envVar, seconds: '0.0',
  });
  const runStep = async (name, fn) => {
    const begin = Date.now();
    try {
      const detail = (await fn()) ?? {};
      return record(name, { ok: true, detail: Object.freeze(detail), seconds: ((Date.now() - begin) / 1000).toFixed(1) });
    } catch (error) {
      failedSteps += 1;
      return record(name, { ok: false, detail: Object.freeze(summarize(error, redact)), seconds: ((Date.now() - begin) / 1000).toFixed(1) });
    }
  };

  for (const id of selected) {
    const plan = planProvider(id, options, deps.env, deps.baseUrls);
    if (plan.invalid === true) {
      failedSteps += 1;
      failed = true;
      record(`${id}:config`, {
        ok: false, detail: Object.freeze({ code: 'invalid-base-url', message: plan.message }), seconds: '0.0',
      });
      providers.push(Object.freeze({ id, status: 'failed', reason: 'config' }));
      continue;
    }
    if (plan.skip !== undefined) {
      const step = skip(`${id}:config`, plan.skip, plan.envVar);
      providers.push(Object.freeze({ id, status: 'skipped', reason: plan.skip, envVar: plan.envVar }));
      continue;
    }
    let status = 'passed';
    const failedProvider = () => {
      status = 'failed';
      failed = true;
    };
    // Only the host is reported: a validated URL can still carry a tenant token in its path.
    await runStep(`${id}:config`, async () => ({ model: plan.model, host: new URL(plan.baseUrl).hostname }));
    let client;
    try {
      client = deps.createClient(id, {
        baseUrl: plan.baseUrl,
        model: plan.model,
        policy: smokePolicyFor(plan.baseUrl),
        env: deps.env,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      failedSteps += 1;
      record(`${id}:client`, { ok: false, detail: Object.freeze(summarize(error, redact)), seconds: '0.0' });
      failedProvider();
      providers.push(Object.freeze({ id, status, reason: 'client' }));
      continue;
    }

    const chatStep = await runStep(`${id}:chat`, async () => {
      const answer = await client.chat({ messages: CHAT_MESSAGES, maxTokens: SMOKE_MAX_TOKENS });
      const facts = answerFacts(answer);
      expect(facts.text.length > 0, 'empty-chat', emptyAnswerMessage('the provider returned no text', facts));
      return { textChars: facts.text.length, sample: redact(sample(facts.text)), totalTokens: facts.totalTokens, finishReason: facts.finishReason };
    });
    const streamStep = chatStep.ok === true
      ? await runStep(`${id}:stream`, async () => {
        const answer = await client.chat({ messages: CHAT_MESSAGES, maxTokens: SMOKE_MAX_TOKENS, stream: true });
        const facts = answerFacts(answer);
        expect(facts.text.length > 0, 'empty-stream', emptyAnswerMessage('the streamed answer was empty', facts));
        const plain = chatStep.detail.sample.toLowerCase();
        return {
          textChars: facts.text.length,
          sameAsPlain: plain.length > 0 && sample(facts.text).toLowerCase() === plain,
          totalTokens: facts.totalTokens,
          finishReason: facts.finishReason,
        };
      })
      : undefined;
    const toolsStep = chatStep.ok === true
      ? await runStep(`${id}:tools`, async () => {
        const answer = await client.chat({ messages: TOOL_MESSAGES, tools: TOOL_DEFINITIONS, maxTokens: SMOKE_MAX_TOKENS });
        const facts = answerFacts(answer);
        expect(answer.toolCalls.length > 0 || facts.text.length > 0, 'empty-tools', emptyAnswerMessage('the tool request returned nothing', facts));
        return { toolCalls: answer.toolCalls.length, textChars: facts.text.length, finishReason: facts.finishReason };
      })
      : undefined;
    let embeddingsStep;
    if (options.noEmbeddings !== true && options.embeddingModels[id] !== undefined) {
      embeddingsStep = await runStep(`${id}:embeddings`, async () => {
        expect(client.config.capabilities.includes('embeddings'), 'unsupported-embeddings', `${id} does not advertise embeddings`);
        const answer = await client.embeddings({ input: EMBEDDING_INPUTS, model: options.embeddingModels[id] });
        expect(answer.vectors.length === EMBEDDING_INPUTS.length, 'embedding-count', 'expected one vector per input');
        const dims = answer.vectors[0].length;
        expect(Number.isInteger(dims) && dims > 0, 'embedding-dims', 'the vectors have no dimension');
        const norm = Math.hypot(...answer.vectors[0]);
        expect(Number.isFinite(norm) && norm > 0, 'embedding-values', 'the vectors are not finite numbers');
        return { vectors: answer.vectors.length, dims, norm: Number(norm.toFixed(4)) };
      });
    }
    for (const step of [chatStep, streamStep, toolsStep, embeddingsStep]) {
      if (step !== undefined && step.ok !== true) { failedProvider(); break; }
    }
    if (status === 'passed') clients[id] = client;
    providers.push(Object.freeze({ id, status }));
  }

  // B2/B6 live: a stopped OmniRoute in front of the direct provider must not stop the turn.
  if (clients.morph !== undefined) {
    await runStep('fallback', async () => {
      const primary = deps.createClient('omniroute', {
        baseUrl: STOPPED_PRIMARY_BASE_URL,
        model: STOPPED_PRIMARY_MODEL,
        policy: smokePolicyFor(STOPPED_PRIMARY_BASE_URL),
        env: Object.create(null),
        timeoutMs: Math.min(options.timeoutMs, STOPPED_PRIMARY_TIMEOUT_MS),
      });
      const chain = deps.createFallback([
        Object.freeze({ id: 'omniroute', label: 'OmniRoute (stopped)', client: primary }),
        Object.freeze({ id: 'morph', label: 'Morph', client: clients.morph }),
      ]);
      const answer = await chain.chat({ messages: CHAT_MESSAGES, maxTokens: SMOKE_MAX_TOKENS });
      expect(answer.servedBy.id === 'morph' && answer.servedBy.fallback === true, 'fallback-not-served-by-morph', 'the answer did not come from the fallback provider');
      expect(answer.attempts.length === 2 && answer.attempts[0].outcome === 'failed', 'fallback-attempts', 'the stopped primary was not attempted first');
      const text = answer.text.trim();
      expect(text.length > 0, 'empty-fallback-answer', 'the fallback answer was empty');
      return {
        servedBy: answer.servedBy.id,
        attempts: answer.attempts.map((attempt) => ({ id: attempt.id, outcome: attempt.outcome, ...(attempt.code === undefined ? {} : { code: attempt.code }) })),
        textChars: text.length,
      };
    }).then((step) => {
      if (step.ok !== true) failed = true;
    });
  }

  const ran = providers.filter((provider) => provider.status !== 'skipped').length;
  const skipped = providers.length - ran;
  const failedProviders = providers.filter((provider) => provider.status === 'failed').length;
  const elapsedMs = Date.now() - startedAt;
  emit(`providers ran=${ran} skipped=${skipped} failed=${failedProviders}; steps failed=${failedSteps}`);
  const result = failed === true ? 'FAIL' : ran === 0 ? 'SKIP' : 'PASS';
  emit(`SMOKE_RESULT=${result} ${(elapsedMs / 1000).toFixed(1)}s`);
  return Object.freeze({
    ok: failed !== true,
    result,
    skippedAll: ran === 0,
    elapsedMs,
    failedSteps,
    providers: Object.freeze(providers),
    steps: Object.freeze(steps),
  });
}

const USAGE = [
  'usage: node vibe/tools/provider-smoke.mjs [options]',
  '',
  '  --provider <id>[,<id>]    B1 external provider(s) to smoke (default: all of them)',
  '  --model <provider>=<id>   model for that provider, overriding the preset default',
  '  --embedding-model <p>=<id> embedding model; the step runs only for a named provider',
  '  --no-embeddings           skip embedding steps even when a model is named',
  '  --timeout-ms <n>          per-request timeout from 1000 to 120000 (default: 90000)',
  '  --help                    print this text',
].join('\n');

export async function runCli(argv = process.argv.slice(2), overrides = {}) {
  const options = parseArgs(argv);
  if (options.help === true) {
    console.log(USAGE);
    return Object.freeze({ ok: true, help: true });
  }
  return runSmoke(options, overrides);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runCli();
    if (report.help !== true && report.ok !== true) process.exitCode = 1;
  } catch (error) {
    // The one print path outside `runSmoke` still redacts every key variable this host defines, so
    // an argument or usage error can never echo a credential.
    let message = error instanceof Error ? error.message : String(error);
    for (const preset of PROVIDER_PRESETS) {
      if (preset.apiKeyEnv === undefined) continue;
      const value = process.env[preset.apiKeyEnv];
      if (typeof value === 'string' && value.length > 0) message = message.split(value).join('[redacted]');
    }
    console.error(message);
    process.exitCode = 1;
  }
}
