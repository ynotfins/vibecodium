import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { AIEndpointPolicyError } from '../../src/stable/security/ai-endpoint-policy.mjs';
import { PROVIDER_PRESETS } from '../../src/stable/gateway/provider-presets.mjs';
import {
  ProviderClientError,
  createProviderClient,
  resolveProviderConfig,
} from '../../src/stable/gateway/provider-client.mjs';

const HOST = 'localhost';
const MESSAGES = [{ role: 'user', content: 'hello' }];
const TOOLS = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];

function urlFor(port, pathname) {
  return 'http://' + HOST + ':' + port + pathname;
}

function bodyFrom(text) {
  return (async function* () {
    yield Buffer.from(text, 'utf8');
  })();
}

function jsonResponse(payload, status = 200) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: bodyFrom(text),
  };
}

function sendJson(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function sendChatStream(response, tool) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n');
  if (tool) {
    response.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n');
    response.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}\n\n');
    response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
  } else {
    response.write('data: {"choices":[{"index":0,"delta":{"content":"Hello "}}]}\n\n');
    response.write('data: {"choices":[{"index":0,"delta":{"content":"world"}}]}\n\n');
    response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
  }
  response.end('data: [DONE]\n\n');
}

function sendResponsesStream(response, tool) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
  if (tool) {
    response.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":""}}\n\n');
    response.write('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"q\\":"}\n\n');
    response.write('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\\"x\\"}"}\n\n');
  } else {
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m_1","output_index":1,"delta":"Hello world"}\n\n');
  }
  response.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n');
  response.end();
}

async function startMock(t) {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push({ url: request.url, headers: request.headers, body });
    if (request.url === '/v1/chat/completions') {
      if (body.stream) return sendChatStream(response, Array.isArray(body.tools));
      if (Array.isArray(body.tools)) {
        return sendJson(response, {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        });
      }
      return sendJson(response, {
        choices: [{ message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
    }
    if (request.url === '/v1/embeddings') {
      return sendJson(response, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], usage: { prompt_tokens: 1 } });
    }
    if (request.url === '/codex/v1/responses') {
      if (body.stream) return sendResponsesStream(response, Array.isArray(body.tools));
      if (Array.isArray(body.tools)) {
        return sendJson(response, {
          output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }],
          usage: { input_tokens: 3, output_tokens: 2 },
        });
      }
      return sendJson(response, {
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] }],
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, port };
}

function basesFor(port, preset) {
  return preset.transport === 'openai-chat'
    ? { baseUrl: urlFor(port, '/v1'), endpoint: '/v1/chat/completions' }
    : { baseUrl: urlFor(port, '/codex/v1'), endpoint: '/codex/v1/responses' };
}

test('every preset passes chat, streaming and tool-call turns', async (t) => {
  const mock = await startMock(t);
  for (const preset of PROVIDER_PRESETS) {
    const { baseUrl, endpoint } = basesFor(mock.port, preset);
    const client = createProviderClient(preset.id, { baseUrl, model: 'test-model', apiKey: 'test-key', env: {} });
    const chat = await client.chat({ messages: MESSAGES });
    assert.equal(chat.text, 'Hello world', preset.id);
    assert.deepEqual(chat.toolCalls, []);
    assert.equal(mock.seen.at(-1).url, endpoint);
    assert.equal(mock.seen.at(-1).body.model, 'test-model');
    if (preset.auth === 'bearer') assert.equal(mock.seen.at(-1).headers.authorization, 'Bearer test-key');
    else assert.equal(mock.seen.at(-1).headers.authorization, undefined);

    const streamed = await client.chat({ messages: MESSAGES, stream: true });
    assert.equal(streamed.text, 'Hello world', preset.id);
    assert.equal(streamed.usage.outputTokens, 2);

    const tooled = await client.chat({ messages: MESSAGES, tools: TOOLS, stream: true });
    assert.equal(tooled.toolCalls.length, 1, preset.id);
    assert.equal(tooled.toolCalls[0].id, 'call_1');
    assert.equal(tooled.toolCalls[0].name, 'lookup');
    assert.equal(tooled.toolCalls[0].arguments, '{"q":"x"}');

    const tooledSync = await client.chat({ messages: MESSAGES, tools: TOOLS });
    assert.equal(tooledSync.toolCalls.length, 1, preset.id);
    assert.equal(tooledSync.toolCalls[0].id, 'call_1');
    assert.equal(tooledSync.toolCalls[0].name, 'lookup');
    assert.equal(tooledSync.toolCalls[0].arguments, '{"q":"x"}');
  }
});

test('embeddings work where the preset advertises them', async (t) => {
  const mock = await startMock(t);
  for (const preset of PROVIDER_PRESETS) {
    if (!preset.capabilities.includes('embeddings')) continue;
    const { baseUrl } = basesFor(mock.port, preset);
    const client = createProviderClient(preset.id, { baseUrl, model: 'test-model', apiKey: 'test-key', env: {} });
    const result = await client.embeddings({ input: ['a', 'b'] });
    assert.equal(result.vectors.length, 1);
    assert.deepEqual([...result.vectors[0]], [0.1, 0.2, 0.3]);
  }
  const kie = createProviderClient('kie', {
    baseUrl: urlFor(mock.port, '/codex/v1'), model: 'gpt-6-1-sol', apiKey: 'test-key', env: {},
  });
  await assert.rejects(kie.embeddings({ input: 'a' }), (error) => error instanceof ProviderClientError && error.code === 'unsupported-transport');
});

test('a provider added only through settings JSON works end to end', async (t) => {
  const mock = await startMock(t);
  const settings = {
    providers: {
      lab: {
        label: 'Lab',
        transport: 'openai-chat',
        baseUrl: urlFor(mock.port, '/v1'),
        model: 'lab-model',
        auth: 'none',
        capabilities: ['chat', 'stream', 'tools'],
      },
    },
  };
  const client = createProviderClient('lab', { settings });
  const chat = await client.chat({ messages: MESSAGES });
  assert.equal(chat.text, 'Hello world');
  assert.equal(mock.seen.at(-1).body.model, 'lab-model');
  const streamed = await client.chat({ messages: MESSAGES, stream: true });
  assert.equal(streamed.text, 'Hello world');
  const tooled = await client.chat({ messages: MESSAGES, tools: TOOLS, stream: true });
  assert.equal(tooled.toolCalls.length, 1);
  assert.equal(tooled.toolCalls[0].arguments, '{"q":"x"}');
  const tooledSync = await client.chat({ messages: MESSAGES, tools: TOOLS });
  assert.equal(tooledSync.toolCalls.length, 1);
  await assert.rejects(
    client.embeddings({ input: 'a' }),
    (error) => error instanceof ProviderClientError && error.code === 'unsupported-transport',
  );
});

test('the endpoint policy denies remote providers unless the caller opts in', async () => {
  let called = false;
  const blocked = createProviderClient('openrouter', {
    model: 'm', apiKey: 'sk-test', fetch: async () => { called = true; },
  });
  await assert.rejects(
    blocked.chat({ messages: MESSAGES }),
    (error) => error instanceof AIEndpointPolicyError && error.code === 'denied-by-default',
  );
  assert.equal(called, false);

  const allowed = () => jsonResponse({ choices: [{ message: { content: 'allowed' } }], usage: {} });
  const allowedByHost = createProviderClient('openrouter', {
    model: 'm',
    apiKey: 'sk-test',
    policy: { allowHosts: ['openrouter.ai'] },
    fetch: async () => allowed(),
  });
  assert.equal((await allowedByHost.chat({ messages: MESSAGES })).text, 'allowed');
  const allowedByCategory = createProviderClient('openrouter', {
    model: 'm',
    apiKey: 'sk-test',
    policy: { allowExternalProviders: true },
    fetch: async () => allowed(),
  });
  assert.equal((await allowedByCategory.chat({ messages: MESSAGES })).text, 'allowed');
});

test('secrets never appear in a config, error, or serialized client', async () => {
  const secret = 'sk-' + 'secret-value';
  const client = createProviderClient('openrouter', { model: 'm', apiKey: secret, env: {} });
  assert.equal(JSON.stringify(client.config).includes(secret), false);
  assert.equal(JSON.stringify(client.describe()).includes(secret), false);
  assert.equal(JSON.stringify(client).includes(secret), false);
  assert.equal('apiKey' in client.config, false);
  const error = await client.chat({
    messages: MESSAGES,
  }).catch((value) => value);
  assert.ok(error instanceof AIEndpointPolicyError);
  assert.equal(String(error).includes(secret), false);

  assert.throws(
    () => createProviderClient('openrouter', { model: 'm', env: {} }),
    (value) => value instanceof ProviderClientError && value.code === 'missing-api-key' && !String(value).includes(secret),
  );
  assert.throws(
    () => createProviderClient('openrouter', { model: 'm', apiKey: 'bad' + String.fromCharCode(0) + 'key' }),
    (value) => value instanceof ProviderClientError && value.code === 'invalid-api-key',
  );
  assert.throws(
    () => createProviderClient('openrouter', { model: 'm', apiKey: 'sk-' + String.fromCharCode(0x202e) + 'key' }),
    (value) => value instanceof ProviderClientError && value.code === 'invalid-api-key',
  );
  assert.throws(
    () => createProviderClient('openrouter', { model: 'm', apiKey: 'a'.repeat(4097) }),
    (value) => value instanceof ProviderClientError && value.code === 'invalid-api-key',
  );
});

test('HTTP errors carry no response body', async () => {
  const fetch = async () => jsonResponse('{"error":"sk-live-secret"}', 401);
  const client = createProviderClient('openrouter', {
    model: 'm', apiKey: 'sk-test', policy: { allowExternalProviders: true }, fetch,
  });
  await assert.rejects(
    client.chat({ messages: MESSAGES }),
    (error) => error instanceof ProviderClientError &&
      error.code === 'http-status' && error.status === 401 && !String(error).includes('sk-live-secret'),
  );
});

test('input and response validation fail closed', async () => {
  const client = createProviderClient('llama-cpp', { baseUrl: urlFor(1, '/v1'), model: 'm', env: {} });
  await assert.rejects(client.chat({ messages: [] }), (error) => error.code === 'invalid-messages');
  await assert.rejects(client.chat({ messages: [{ role: 'system', content: 'x'.repeat(1_000_001) }] }), (error) => error.code === 'invalid-message');
  await assert.rejects(client.chat({ messages: [{ role: 'wizard', content: 'x' }] }), (error) => error.code === 'invalid-message');
  await assert.rejects(client.chat({ messages: [{ role: 'user', content: 'x' + String.fromCharCode(0) }] }), (error) => error.code === 'invalid-message');
  await assert.rejects(client.chat({ messages: MESSAGES, tools: [{ type: 'function', function: { name: 'bad name' } }] }), (error) => error.code === 'invalid-tools');
  await assert.rejects(client.chat({ messages: MESSAGES, model: 'bad model' }), (error) => error.code === 'invalid-preset');
  await assert.rejects(client.chat({ messages: MESSAGES, stream: 'yes' }), (error) => error.code === 'invalid-options');

  const invalidJson = createProviderClient('llama-cpp', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    fetch: async () => jsonResponse('not json'),
  });
  await assert.rejects(invalidJson.chat({ messages: MESSAGES }), (error) => error.code === 'invalid-response');

  const oversized = createProviderClient('llama-cpp', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    maxResponseBytes: 1024,
    fetch: async () => jsonResponse('x'.repeat(2048)),
  });
  await assert.rejects(oversized.chat({ messages: MESSAGES }), (error) => error.code === 'response-too-large');

  const badHeader = createProviderClient('llama-cpp', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'abc' }, body: bodyFrom('{}') }),
  });
  await assert.rejects(badHeader.chat({ messages: MESSAGES }), (error) => error.code === 'invalid-response');

  const throwingHeader = createProviderClient('llama-cpp', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => { throw new Error('bad header'); } },
      body: bodyFrom('{}'),
    }),
  });
  await assert.rejects(throwingHeader.chat({ messages: MESSAGES }), (error) => error.code === 'invalid-response');

  const textFallback = createProviderClient('llama-cpp', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }) }),
  });
  await assert.rejects(textFallback.chat({ messages: MESSAGES }), (error) => error.code === 'invalid-response');
});

test('configuration resolves base URLs and models without exposing credentials', () => {
  const port = 4567;
  const config = resolveProviderConfig('omniroute', {
    model: 'm',
    env: { OMNIROUTE_BASE_URL: urlFor(port, '/v1'), OMNIROUTE_API_KEY: 'sk-test' },
  });
  assert.equal(config.baseUrl, urlFor(port, '/v1'));
  assert.equal(config.model, 'm');
  assert.equal(config.apiKeyRequired, false);
  assert.equal(JSON.stringify(config).includes('sk-test'), false);
  assert.equal(config.transport, 'openai-chat');
  assert.throws(() => resolveProviderConfig('openrouter', { env: {} }), (error) => error.code === 'missing-model');
  assert.throws(() => resolveProviderConfig('omniroute', { model: 'm', env: {} }), (error) => error.code === 'missing-base-url');
  assert.throws(() => resolveProviderConfig('llama-cpp', { model: 'm', timeoutMs: 1, env: {} }), (error) => error.code === 'invalid-options');
  assert.throws(() => resolveProviderConfig('llama-cpp', { model: 'm', policy: [] }), (error) => error.code === 'invalid-options');
});

test('the external-provider opt-in cannot reach Copilot, telemetry, GitHub or metadata hosts', () => {
  for (const host of ['api.githubcopilot.com', 'copilot-telemetry.githubusercontent.com', 'api.github.com', 'metadata.google.internal']) {
    assert.throws(
      () => createProviderClient('openai-compatible', {
        baseUrl: 'https://' + host + '/v1',
        model: 'm',
        env: {},
        policy: { allowExternalProviders: true },
        fetch: async () => jsonResponse({}),
      }),
      (error) => error instanceof AIEndpointPolicyError &&
        (error.code === 'denied-by-default' || error.code === 'forbidden-endpoint'),
      host,
    );
  }
});

test('an unknown external host is allowed only through the scoped opt-in', async () => {
  const seen = [];
  const client = createProviderClient('openai-compatible', {
    baseUrl: 'https://models.example.test/v1',
    model: 'm',
    env: {},
    policy: { allowExternalProviders: true },
    fetch: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({ choices: [{ message: { content: 'ok' } }], usage: {} });
    },
  });
  assert.equal((await client.chat({ messages: MESSAGES })).text, 'ok');
  assert.equal(seen[0].url, 'https://models.example.test/v1/chat/completions');

  const unopted = createProviderClient('openai-compatible', {
    baseUrl: 'https://models.example.test/v1',
    model: 'm',
    env: {},
    fetch: async () => jsonResponse({}),
  });
  await assert.rejects(
    unopted.chat({ messages: MESSAGES }),
    (error) => error instanceof AIEndpointPolicyError && error.code === 'denied-by-default',
  );
});

test('the client refuses redirects', async () => {
  let seen;
  const client = createProviderClient('openai-compatible', {
    baseUrl: 'https://models.example.test/v1',
    model: 'm',
    env: {},
    policy: { allowExternalProviders: true },
    fetch: async (url, init) => {
      seen = init;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }], usage: {} });
    },
  });
  await client.chat({ messages: MESSAGES });
  assert.equal(seen.redirect, 'error');
});

test('a stalled response body times out', { timeout: 5000 }, async () => {
  const client = createProviderClient('llama-cpp', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    timeoutMs: 100,
    fetch: async (url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return new Promise((resolve, reject) => {
                if (init.signal.aborted) return reject(new Error('aborted'));
                init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
              });
            },
          };
        },
      },
    }),
  });
  await assert.rejects(
    client.chat({ messages: MESSAGES }),
    (error) => error instanceof ProviderClientError && error.code === 'timeout',
  );
});

test('an oversized streamed body is rejected while reading', async () => {
  const client = createProviderClient('llama-cpp', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    maxResponseBytes: 1024,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from('x'.repeat(2048), 'utf8');
      })(),
    }),
  });
  await assert.rejects(
    client.chat({ messages: MESSAGES }),
    (error) => error instanceof ProviderClientError && error.code === 'response-too-large',
  );
});

test('a caller abort is reported as aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createProviderClient('llama-cpp', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    signal: controller.signal,
    fetch: async () => { throw new Error('should not be reached'); },
  });
  await assert.rejects(
    client.chat({ messages: MESSAGES }),
    (error) => error instanceof ProviderClientError && error.code === 'aborted',
  );
});

// DeepInfra answers every chat message with `tool_calls: null` when no tool was called and every
// streamed delta with `tool_calls: null` (verified live 2026-11-28). Null means absent.
test('a null tool_calls field is an absent tool call, not an invalid one', async () => {
  const client = createProviderClient('openai-compatible', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    policy: { allowExternalProviders: true },
    fetch: async () => jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'pong', reasoning_content: 'thinking', tool_calls: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
  });
  const answer = await client.chat({ messages: MESSAGES });
  assert.equal(answer.text, 'pong');
  assert.equal(answer.toolCalls.length, 0);
  assert.equal(answer.usage.totalTokens, 4);
});

test('a null content and a null tool_calls field make an empty answer, not an error', async () => {
  const client = createProviderClient('openai-compatible', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    policy: { allowExternalProviders: true },
    fetch: async () => jsonResponse({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: null }, finish_reason: 'stop' }],
    }),
  });
  const answer = await client.chat({ messages: MESSAGES });
  assert.equal(answer.text, '');
  assert.equal(answer.toolCalls.length, 0);
});

test('a streamed null tool_calls delta does not stop the text deltas', async () => {
  const events = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":null,"tool_calls":null},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":"thinking","tool_calls":null},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"Hello","tool_calls":null},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":" world","tool_calls":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    'data: [DONE]',
  ];
  const client = createProviderClient('openai-compatible', {
    baseUrl: urlFor(1, '/v1'),
    model: 'm',
    env: {},
    policy: { allowExternalProviders: true },
    fetch: async () => jsonResponse(events.join('\n\n') + '\n\n'),
  });
  const answer = await client.chat({ messages: MESSAGES, stream: true });
  assert.equal(answer.text, 'Hello world');
  assert.equal(answer.toolCalls.length, 0);
  assert.equal(answer.finishReason, 'stop');
  assert.equal(answer.usage.totalTokens, 5);
});
