import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { PROVIDER_PRESETS } from '../../src/stable/gateway/provider-presets.mjs';
import {
  EMBEDDING_INPUTS,
  SMOKE_MAX_TOKENS,
  SMOKE_PROVIDERS,
  parseArgs,
  runCli,
  runSmoke,
  smokePolicyFor,
} from '../../vibe/tools/provider-smoke.mjs';

const HOST = 'localhost';
const MORPH_KEY = 'sk-morph-test-value';
const DEEPINFRA_KEY = 'sk-deepinfra-test-value';

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return 'no-error';
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function usage() {
  return { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
}

// DeepInfra's live shape: `tool_calls: null` on every message and on every streamed delta, and
// `reasoning_content` before the answer.
function sendStream(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning_content: null, tool_calls: null }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '', reasoning_content: 'thinking', tool_calls: null }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'pong', tool_calls: null }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage() })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function startMock(t, mode = 'happy') {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push({ url: request.url, headers: request.headers, body });
    if (mode === 'http-500') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"boom"}');
      return;
    }
    if (request.url === '/v1/embeddings') {
      return sendJson(response, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }, { embedding: [0.4, 0.5, 0.6], index: 1 }], usage: usage() });
    }
    if (request.url === '/v1/chat/completions') {
      if (body.stream === true) return sendStream(response);
      if (Array.isArray(body.tools)) {
        return sendJson(response, {
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: usage(),
        });
      }
      const content = mode === 'empty' ? '' : mode === 'hostile' ? 'p\u202Eu\u0085x\u2028y' : 'pong';
      return sendJson(response, {
        choices: [{
          index: 0,
          message: { role: 'assistant', content, reasoning_content: 'thinking', tool_calls: null },
          finish_reason: mode === 'empty' ? 'length' : mode === 'hostile' ? 'st\u202Ep' : 'stop',
        }],
        usage: mode === 'empty' ? { prompt_tokens: 3, completion_tokens: 8, total_tokens: 11 } : usage(),
      });
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, baseUrl: 'http://' + HOST + ':' + port + '/v1' };
}

function smokeOptions(overrides = {}) {
  return { ...parseArgs([]), ...overrides };
}

function captured() {
  const lines = [];
  return { lines, print: (line) => lines.push(line) };
}

test('SMOKE_PROVIDERS is the B1 external presets and excludes the local runtimes', () => {
  assert.ok(Object.isFrozen(SMOKE_PROVIDERS));
  const expected = PROVIDER_PRESETS.filter((preset) => preset.local !== true).map((preset) => preset.id);
  assert.deepEqual([...SMOKE_PROVIDERS], expected);
  for (const id of SMOKE_PROVIDERS) assert.ok(PROVIDER_PRESETS.find((preset) => preset.id === id).local !== true);
  assert.ok(!SMOKE_PROVIDERS.includes('llama-cpp'));
  assert.ok(!SMOKE_PROVIDERS.includes('ollama'));
  assert.ok(SMOKE_PROVIDERS.includes('morph'));
  assert.ok(SMOKE_PROVIDERS.includes('deepinfra'));
});

test('parseArgs defaults select every external preset with no model overrides', () => {
  const options = parseArgs([]);
  assert.equal(options.help, false);
  assert.equal(options.noEmbeddings, false);
  assert.equal(options.timeoutMs, 90_000);
  assert.deepEqual([...options.providers], []);
  assert.deepEqual({ ...options.models }, {});
  assert.deepEqual({ ...options.embeddingModels }, {});
  assert.ok(Object.isFrozen(options));
});

test('parseArgs reads providers, models and embedding models', () => {
  const options = parseArgs([
    '--provider', 'morph,deepinfra', '--provider', 'openrouter',
    '--model', 'deepinfra=zai-org/GLM-5.3',
    '--embedding-model', 'deepinfra=BAAI/bge-m3',
  ]);
  assert.deepEqual([...options.providers], ['morph', 'deepinfra', 'openrouter']);
  assert.equal(options.models.deepinfra, 'zai-org/GLM-5.3');
  assert.equal(options.embeddingModels.deepinfra, 'BAAI/bge-m3');
});

test('parseArgs refuses an unknown, duplicate or local provider', () => {
  assert.equal(codeOf(() => parseArgs(['--provider', 'nope'])), 'unsupported-provider');
  assert.equal(codeOf(() => parseArgs(['--provider', 'morph,morph'])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--provider', 'morph', '--provider', 'morph'])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--provider', 'llama-cpp'])), 'unsupported-provider');
  assert.equal(codeOf(() => parseArgs(['--provider', 'ollama'])), 'unsupported-provider');
  assert.equal(codeOf(() => parseArgs(['--provider', 'morph,'])), 'invalid-argument');
});

test('parseArgs refuses a malformed, duplicate or invalid model assignment', () => {
  assert.equal(codeOf(() => parseArgs(['--model', 'morph'])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--model', '=x'])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--model', 'morph='])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--model', 'morph=a', '--model', 'morph=b'])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--model', 'llama-cpp=x'])), 'unsupported-provider');
  assert.equal(codeOf(() => parseArgs(['--model', 'morph=bad model'])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--embedding-model', 'morph'])), 'invalid-argument');
});

test('parseArgs bounds the timeout and reads the flags', () => {
  assert.equal(parseArgs(['--timeout-ms', '1000']).timeoutMs, 1_000);
  assert.equal(parseArgs(['--timeout-ms', '120000']).timeoutMs, 120_000);
  assert.equal(codeOf(() => parseArgs(['--timeout-ms', '999'])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--timeout-ms', '120001'])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--timeout-ms', 'abc'])), 'invalid-argument');
  assert.equal(parseArgs(['--no-embeddings']).noEmbeddings, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(codeOf(() => parseArgs(['--provider'])), 'invalid-argument');
  assert.equal(codeOf(() => parseArgs(['--verbose'])), 'invalid-argument');
});

test('every provider skips without a key and the smoke reports SKIP', async () => {
  const out = captured();
  let created = 0;
  const report = await runSmoke(smokeOptions(), {
    env: {},
    print: out.print,
    createClient: () => { created += 1; throw new Error('must not be called'); },
  });
  assert.equal(report.ok, true);
  assert.equal(report.result, 'SKIP');
  assert.equal(report.skippedAll, true);
  assert.equal(created, 0);
  assert.equal(report.providers.length, SMOKE_PROVIDERS.length);
  assert.ok(report.providers.every((provider) => provider.status === 'skipped'));
  const morph = report.providers.find((provider) => provider.id === 'morph');
  assert.equal(morph.reason, 'no-key');
  assert.equal(morph.envVar, 'MORPH_API_KEY');
  assert.ok(out.lines.some((line) => line === 'SMOKE_RESULT=SKIP 0.0s' || line.startsWith('SMOKE_RESULT=SKIP')));
  assert.ok(!out.lines.join('\n').includes('[redacted]'));
});

test('a skipped provider never prints its key value', async () => {
  const out = captured();
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: '' },
    print: out.print,
  });
  assert.equal(report.result, 'SKIP');
  assert.equal(report.providers[0].reason, 'no-base-url');
  assert.ok(!out.lines.join('\n').includes(MORPH_KEY));
});

test('a configured provider runs chat, stream and tools through the shipped client', async (t) => {
  const mock = await startMock(t);
  const out = captured();
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: mock.baseUrl },
    print: out.print,
  });
  assert.equal(report.ok, true);
  assert.equal(report.result, 'PASS');
  assert.deepEqual(report.providers.map((provider) => [provider.id, provider.status]), [['morph', 'passed']]);
  const names = report.steps.map((step) => step.name);
  assert.deepEqual(names, ['morph:config', 'morph:chat', 'morph:stream', 'morph:tools', 'fallback']);
  assert.equal(report.steps.find((step) => step.name === 'morph:chat').detail.sample, 'pong');
  assert.equal(report.steps.find((step) => step.name === 'fallback').detail.servedBy, 'morph');
  const printed = out.lines.join('\n');
  assert.ok(!printed.includes(MORPH_KEY));
  assert.ok(printed.includes('SMOKE_RESULT=PASS'));
  const chatRequest = mock.seen.find((entry) => entry.url === '/v1/chat/completions' && entry.body.stream !== true && !entry.body.tools);
  assert.equal(chatRequest.headers.authorization, 'Bearer ' + MORPH_KEY);
  assert.equal(chatRequest.body.max_tokens, SMOKE_MAX_TOKENS);
});

test('a live-style tool_calls: null answer is accepted on the plain and streamed turn', async (t) => {
  const mock = await startMock(t);
  const report = await runSmoke(smokeOptions({ providers: ['deepinfra'], models: { deepinfra: 'zai-org/GLM-5.3' } }), {
    env: { DEEPINFRA_API_KEY: DEEPINFRA_KEY },
    baseUrls: { deepinfra: mock.baseUrl },
    print: () => {},
  });
  assert.equal(report.result, 'PASS', JSON.stringify(report.steps));
  assert.equal(report.steps.find((step) => step.name === 'deepinfra:chat').detail.textChars, 4);
  assert.equal(report.steps.find((step) => step.name === 'deepinfra:stream').detail.textChars, 4);
  assert.equal(report.steps.find((step) => step.name === 'deepinfra:tools').detail.toolCalls, 1);
});

test('embeddings run only for a named model and a preset that advertises them', async (t) => {
  const mock = await startMock(t);
  const report = await runSmoke(smokeOptions({
    providers: ['deepinfra'],
    models: { deepinfra: 'zai-org/GLM-5.3' },
    embeddingModels: { deepinfra: 'BAAI/bge-m3' },
  }), {
    env: { DEEPINFRA_API_KEY: DEEPINFRA_KEY },
    baseUrls: { deepinfra: mock.baseUrl },
    print: () => {},
  });
  const embeddings = report.steps.find((step) => step.name === 'deepinfra:embeddings');
  assert.equal(embeddings.ok, true);
  assert.deepEqual({ ...embeddings.detail }, { vectors: EMBEDDING_INPUTS.length, dims: 3, norm: Number(Math.hypot(0.1, 0.2, 0.3).toFixed(4)) });
});

test('an embedding model named for a preset without the capability fails', async (t) => {
  const mock = await startMock(t);
  const report = await runSmoke(smokeOptions({
    providers: ['morph'],
    embeddingModels: { morph: 'morph-embedding-v4' },
  }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: mock.baseUrl },
    print: () => {},
  });
  assert.equal(report.ok, false);
  assert.equal(report.result, 'FAIL');
  const step = report.steps.find((entry) => entry.name === 'morph:embeddings');
  assert.equal(step.ok, false);
  assert.equal(step.detail.code, 'unsupported-embeddings');
  assert.equal(report.providers[0].status, 'failed');
});

test('--no-embeddings drops the step even when a model is named', async (t) => {
  const mock = await startMock(t);
  const report = await runSmoke(smokeOptions({
    providers: ['deepinfra'],
    models: { deepinfra: 'zai-org/GLM-5.3' },
    embeddingModels: { deepinfra: 'BAAI/bge-m3' },
    noEmbeddings: true,
  }), {
    env: { DEEPINFRA_API_KEY: DEEPINFRA_KEY },
    baseUrls: { deepinfra: mock.baseUrl },
    print: () => {},
  });
  assert.equal(report.result, 'PASS');
  assert.ok(!report.steps.some((step) => step.name === 'deepinfra:embeddings'));
});

test('an HTTP failure fails the provider and the smoke', async (t) => {
  const mock = await startMock(t, 'http-500');
  const out = captured();
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: mock.baseUrl },
    print: out.print,
  });
  assert.equal(report.ok, false);
  assert.equal(report.result, 'FAIL');
  assert.equal(report.providers[0].status, 'failed');
  const chat = report.steps.find((step) => step.name === 'morph:chat');
  assert.equal(chat.ok, false);
  assert.equal(chat.detail.code, 'http-status');
  assert.ok(!out.lines.join('\n').includes(MORPH_KEY));
});

test('an empty chat answer fails with a named reason and the truncation facts', async (t) => {
  const mock = await startMock(t, 'empty');
  const out = captured();
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: mock.baseUrl },
    print: out.print,
  });
  assert.equal(report.result, 'FAIL');
  assert.equal(report.failedSteps, 1);
  const chat = report.steps.find((step) => step.name === 'morph:chat');
  assert.equal(chat.detail.code, 'empty-chat');
  // A reasoning model can stop on the cap with empty text: the failure says so instead of leaving
  // the operator unable to tell a truncation from a provider defect.
  assert.match(chat.detail.message, /finish_reason=length/);
  assert.match(chat.detail.message, /output_tokens=8/);
  assert.ok(out.lines.some((line) => line.includes('steps failed=1')));
  assert.ok(out.lines.some((line) => line.includes('SMOKE_RESULT=FAIL')));
});

test('a client construction failure fails the provider and counts as a failed step', async () => {
  const out = captured();
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: 'http://127.0.0.1:1/v1' },
    createClient: () => {
      const error = new Error('the client could not be built');
      error.code = 'invalid-config';
      throw error;
    },
    print: out.print,
  });
  assert.equal(report.result, 'FAIL');
  assert.equal(report.providers[0].status, 'failed');
  assert.equal(report.providers[0].reason, 'client');
  assert.equal(report.failedSteps, 1);
  const step = report.steps.find((entry) => entry.name === 'morph:client');
  assert.equal(step.ok, false);
  assert.equal(step.detail.code, 'invalid-config');
  assert.ok(out.lines.some((line) => line.includes('steps failed=1')));
});

test('an invalid base URL fails the provider without printing or storing the credential', async () => {
  const out = captured();
  const token = 'sk-userinfo-LEAK-42';
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: 'https://user:' + token + '@gateway.example.com/v1' },
    print: out.print,
  });
  assert.equal(report.result, 'FAIL');
  assert.equal(report.failedSteps, 1);
  assert.equal(report.providers[0].reason, 'config');
  const step = report.steps.find((entry) => entry.name === 'morph:config');
  assert.equal(step.ok, false);
  assert.equal(step.detail.code, 'invalid-base-url');
  const printed = out.lines.join('\n');
  assert.ok(!printed.includes(token));
  assert.ok(!JSON.stringify(report).includes(token));
  assert.ok(!JSON.stringify(report).includes('gateway.example.com'));
});

test('the smoke policy allows exactly the planned host and no provider category', () => {
  const policy = smokePolicyFor('https://api.morphllm.com/v1');
  assert.ok(Object.isFrozen(policy));
  assert.deepEqual({ ...policy }, { allowHosts: ['api.morphllm.com'] });
  assert.equal(policy.allowExternalProviders, undefined);
  // The M1 matcher compares hostnames, so a port must not enter the allow list.
  assert.deepEqual({ ...smokePolicyFor('http://127.0.0.1:8123/v1') }, { allowHosts: ['127.0.0.1'] });
  assert.deepEqual({ ...smokePolicyFor('https://api.morphllm.com:8443/v1') }, { allowHosts: ['api.morphllm.com'] });
});

test('the config line reports the model and the host, never the endpoint path', async (t) => {
  const mock = await startMock(t);
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: mock.baseUrl + '/tenant-TENANTSECRET42' },
    print: () => {},
  });
  const config = report.steps.find((step) => step.name === 'morph:config');
  assert.deepEqual({ ...config.detail }, { model: 'morph-dsv41flash', host: HOST });
  assert.ok(!JSON.stringify(report).includes('TENANTSECRET42'));
});

test('every client, including the stopped primary, is built with an exact host allow', async (t) => {
  const mock = await startMock(t);
  const { createProviderClient } = await import('../../src/stable/gateway/provider-client.mjs');
  const built = [];
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: mock.baseUrl },
    createClient: (id, options) => {
      built.push({ id, policy: options.policy });
      return createProviderClient(id, options);
    },
    print: () => {},
  });
  assert.equal(report.result, 'PASS');
  assert.deepEqual(built.map((entry) => entry.id), ['morph', 'omniroute']);
  for (const entry of built) {
    assert.equal(entry.policy.allowExternalProviders, undefined);
    assert.ok(Object.isFrozen(entry.policy.allowHosts));
  }
  assert.deepEqual({ ...built[0].policy }, { allowHosts: [HOST] });
  assert.deepEqual({ ...built[1].policy }, { allowHosts: ['127.0.0.1'] });
});

test('a provider that sends control, bidi and separator characters cannot break the report', async (t) => {
  const mock = await startMock(t, 'hostile');
  const out = captured();
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: mock.baseUrl },
    print: out.print,
  });
  assert.equal(report.result, 'PASS');
  const chat = report.steps.find((step) => step.name === 'morph:chat');
  assert.equal(chat.detail.finishReason, 'stp');
  assert.ok(!/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202E]/.test(chat.detail.sample));
  // The line separator between entries is a newline; every other control, bidi or separator
  // character from the provider must be gone.
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202E]/.test(out.lines.join('\n')));
});

test('the fallback step is absent when Morph did not run', async (t) => {
  const mock = await startMock(t);
  const report = await runSmoke(smokeOptions({ providers: ['deepinfra'], models: { deepinfra: 'zai-org/GLM-5.3' } }), {
    env: { DEEPINFRA_API_KEY: DEEPINFRA_KEY },
    baseUrls: { deepinfra: mock.baseUrl },
    print: () => {},
  });
  assert.equal(report.result, 'PASS');
  assert.ok(!report.steps.some((step) => step.name === 'fallback'));
});

test('a provider without a model skips and runs once a model is named', async (t) => {
  const mock = await startMock(t);
  const skipped = await runSmoke(smokeOptions({ providers: ['deepinfra'] }), {
    env: { DEEPINFRA_API_KEY: DEEPINFRA_KEY },
    baseUrls: { deepinfra: mock.baseUrl },
    print: () => {},
  });
  assert.equal(skipped.result, 'SKIP');
  assert.equal(skipped.providers[0].reason, 'no-model');
  const ran = await runSmoke(smokeOptions({ providers: ['deepinfra'], models: { deepinfra: 'zai-org/GLM-5.3' } }), {
    env: { DEEPINFRA_API_KEY: DEEPINFRA_KEY },
    baseUrls: { deepinfra: mock.baseUrl },
    print: () => {},
  });
  assert.equal(ran.result, 'PASS');
});

test('a key echoed by a client error is redacted from the report and the output', async () => {
  const out = captured();
  const report = await runSmoke(smokeOptions({ providers: ['morph'] }), {
    env: { MORPH_API_KEY: MORPH_KEY },
    baseUrls: { morph: 'http://localhost:1/v1' },
    print: out.print,
    createClient: () => { throw new Error('bad key ' + MORPH_KEY); },
  });
  assert.equal(report.ok, false);
  assert.equal(report.providers[0].reason, 'client');
  assert.ok(!out.lines.join('\n').includes(MORPH_KEY));
  assert.ok(out.lines.join('\n').includes('[redacted]'));
});

test('runCli prints usage for --help and makes no request', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const report = await runCli(['--help'], { print: () => { throw new Error('must not run a smoke'); } });
    assert.equal(report.help, true);
  } finally {
    console.log = original;
  }
  assert.ok(lines.join('\n').includes('usage: node vibe/tools/provider-smoke.mjs'));
});

test('runCli returns the smoke report for a normal run', async () => {
  const report = await runCli(['--provider', 'morph'], { env: {}, print: () => {} });
  assert.equal(report.result, 'SKIP');
  assert.equal(report.ok, true);
});
