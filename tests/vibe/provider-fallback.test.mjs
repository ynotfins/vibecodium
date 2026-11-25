import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { AIEndpointPolicyError } from '../../src/stable/security/ai-endpoint-policy.mjs';
import { ProviderClientError, createProviderClient } from '../../src/stable/gateway/provider-client.mjs';
import {
  ProviderFallbackError,
  createProviderFallback,
} from '../../src/stable/gateway/provider-fallback.mjs';

const MESSAGES = [{ role: 'user', content: 'hello' }];
const TOOLS = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
const PROVIDER_BODY = 'provider-body-must-not-leak';
const HOST = 'localhost';

function sendJson(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function sendChatStream(response, tool) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: {"choices":[{"index":0,"delta":{"content":"fallback stream"}}]}\n\n');
  if (tool) {
    response.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_fb","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n');
    response.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}\n\n');
  }
  response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n');
  response.end('data: [DONE]\n\n');
}

async function startMock(t) {
  const state = {
    primary: 'ok',
    fallback: 'ok',
    requests: { primary: 0, fallback: 0 },
    models: { primary: [], fallback: [] },
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const side = request.url.startsWith('/primary/v1/') ? 'primary'
      : request.url.startsWith('/fallback/v1/') ? 'fallback' : undefined;
    if (side === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    state.requests[side] += 1;
    state.models[side].push(body.model);
    const mode = state[side];
    if (mode === 'timeout') {
      const timer = setTimeout(() => {
        try {
          sendJson(response, { choices: [{ message: { role: 'assistant', content: 'late' } }] });
        } catch { /* the client already aborted */ }
      }, 250);
      timer.unref();
      return;
    }
    if (mode === 'empty-stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: [DONE]\n\n');
      return;
    }
    if (/^\d{3}$/.test(mode)) {
      response.writeHead(Number(mode), { 'content-type': 'text/plain' });
      response.end(PROVIDER_BODY);
      return;
    }
    if (request.url.endsWith('/embeddings')) {
      sendJson(response, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], usage: { prompt_tokens: 1 } });
      return;
    }
    if (body.stream) {
      sendChatStream(response, Array.isArray(body.tools));
      return;
    }
    sendJson(response, {
      choices: [{ message: { role: 'assistant', content: side + ' answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, state };
}

function makeClient(port, side, options = {}) {
  return createProviderClient('openai-compatible', {
    baseUrl: 'http://localhost:' + port + '/' + side + '/v1',
    model: side + '-default',
    apiKey: 'test-key',
    env: {},
    timeoutMs: 1000,
    ...options,
  });
}

function makeChain(primary, fallback) {
  return createProviderFallback([
    { id: 'primary', label: 'Primary', client: primary },
    { id: 'fallback', label: 'Fallback', client: fallback },
  ]);
}

test('retryable primary failures return the fallback answer in the same turn', async (t) => {
  const mock = await startMock(t);
  const primary = makeClient(mock.port, 'primary', { timeoutMs: 100 });
  const fallback = makeClient(mock.port, 'fallback');
  const chain = makeChain(primary, fallback);

  const cases = [
    ['429', (attempt) => attempt.status === 429, {}],
    ['503', (attempt) => attempt.status === 503, {}],
    ['empty-stream', (attempt) => attempt.outcome === 'empty', { stream: true }],
    ['timeout', (attempt) => attempt.code === 'timeout', {}],
  ];
  for (const [mode, failed, input] of cases) {
    mock.state.primary = mode;
    const before = mock.state.requests.fallback;
    const answer = await chain.chat({ messages: MESSAGES, ...input });
    assert.equal(answer.text, input.stream ? 'fallback stream' : 'fallback answer', mode);
    assert.equal(answer.servedBy.id, 'fallback', mode);
    assert.equal(answer.servedBy.fallback, true, mode);
    assert.equal(answer.attempts.length, 2, mode);
    assert.equal(answer.attempts[0].id, 'primary', mode);
    assert.equal(answer.attempts[0].outcome === 'answered', false, mode);
    assert.equal(failed(answer.attempts[0]), true, mode);
    assert.deepEqual(answer.attempts[1], { id: 'fallback', label: 'Fallback', outcome: 'answered' }, mode);
    assert.equal(mock.state.requests.fallback, before + 1, mode);
  }
});

test('streamed text and tool calls survive failover', async (t) => {
  const mock = await startMock(t);
  mock.state.primary = '429';
  const chain = makeChain(makeClient(mock.port, 'primary'), makeClient(mock.port, 'fallback'));

  const answer = await chain.chat({ messages: MESSAGES, tools: TOOLS, stream: true });
  assert.equal(answer.text, 'fallback stream');
  assert.equal(answer.toolCalls.length, 1);
  assert.equal(answer.toolCalls[0].id, 'call_fb');
  assert.equal(answer.toolCalls[0].name, 'lookup');
  assert.equal(answer.toolCalls[0].arguments, '{"q":"x"}');
  assert.equal(answer.servedBy.id, 'fallback');
});

test('non-retryable failures do not touch the fallback', async (t) => {
  const mock = await startMock(t);
  mock.state.primary = '400';
  const fallback = makeClient(mock.port, 'fallback');
  const chain = makeChain(makeClient(mock.port, 'primary'), fallback);

  await assert.rejects(
    chain.chat({ messages: MESSAGES }),
    (error) => error instanceof ProviderClientError && error.code === 'http-status' && error.status === 400,
  );
  assert.equal(mock.state.requests.fallback, 0);
});

test('an endpoint-policy denial and caller cancellation never fail over', async (t) => {
  const mock = await startMock(t);
  const fallback = makeClient(mock.port, 'fallback');
  const deniedPrimary = createProviderClient('openrouter', { model: 'm', apiKey: 'sk-test', env: {} });
  await assert.rejects(
    makeChain(deniedPrimary, fallback).chat({ messages: MESSAGES }),
    (error) => error instanceof AIEndpointPolicyError && error.code === 'denied-by-default',
  );
  assert.equal(mock.state.requests.fallback, 0);

  const controller = new AbortController();
  controller.abort();
  const cancelledPrimary = makeClient(mock.port, 'primary', { signal: controller.signal });
  await assert.rejects(
    makeChain(cancelledPrimary, fallback).chat({ messages: MESSAGES }),
    (error) => error instanceof ProviderClientError && error.code === 'aborted',
  );
  assert.equal(mock.state.requests.fallback, 0);
});

test('exhaustion reports only bounded, safe attempt summaries', async (t) => {
  const mock = await startMock(t);
  mock.state.primary = '429';
  mock.state.fallback = '503';
  const secret = 'sk-' + 'fallback-secret';
  const chain = makeChain(
    makeClient(mock.port, 'primary', { apiKey: secret }),
    makeClient(mock.port, 'fallback', { apiKey: secret }),
  );

  const error = await chain.chat({ messages: MESSAGES }).catch((value) => value);
  assert.ok(error instanceof ProviderFallbackError);
  assert.equal(error.code, 'fallback-exhausted');
  assert.equal(error.attempts.length, 2);
  assert.deepEqual(error.attempts.map((attempt) => attempt.status), [429, 503]);
  assert.equal(String(error).includes(secret), false);
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(JSON.stringify(error).includes(PROVIDER_BODY), false);
  assert.equal(JSON.stringify(chain.describe()).includes(secret), false);
  assert.equal(JSON.stringify(chain).includes(secret), false);
});

test('fallback model selection is per provider and embeddings fail over', async (t) => {
  const mock = await startMock(t);
  mock.state.primary = '429';
  const primary = makeClient(mock.port, 'primary');
  const fallback = makeClient(mock.port, 'fallback');
  const chosen = createProviderFallback([
    { id: 'primary', client: primary },
    { id: 'fallback', client: fallback, model: 'fallback-chosen' },
  ]);

  await chosen.chat({ messages: MESSAGES, model: 'primary-call-model' });
  assert.equal(mock.state.models.fallback.at(-1), 'fallback-chosen');

  const defaults = makeChain(primary, fallback);
  await defaults.chat({ messages: MESSAGES, model: 'primary-call-model' });
  assert.equal(mock.state.models.fallback.at(-1), 'fallback-default');

  mock.state.primary = '503';
  const embedded = await defaults.embeddings({ input: ['a', 'b'] });
  assert.deepEqual([...embedded.vectors[0]], [0.1, 0.2, 0.3]);
  assert.equal(embedded.servedBy.id, 'fallback');
});

test('malformed fallback definitions fail closed', () => {
  const client = makeClient(1, 'primary');
  assert.throws(() => createProviderFallback([]), (error) => error.code === 'invalid-chain');
  assert.throws(() => createProviderFallback([{ id: 'primary' }]), (error) => error.code === 'invalid-provider');
  assert.throws(
    () => createProviderFallback([{ id: 'primary', client }, { id: 'primary', client }]),
    (error) => error.code === 'duplicate-provider',
  );
  assert.throws(
    () => createProviderFallback([{ id: 'primary', client, label: 'bad\nlabel' }]),
    (error) => error.code === 'invalid-provider',
  );
  assert.throws(
    () => createProviderFallback([{ id: 'primary', client, model: 'bad model' }]),
    (error) => error.code === 'invalid-provider',
  );
  assert.throws(
    () => createProviderFallback([{ id: 'primary', client, unexpected: true }]),
    (error) => error.code === 'invalid-provider',
  );
  const many = Array.from({ length: 9 }, (_, index) => ({ id: 'p' + index, client }));
  assert.throws(() => createProviderFallback(many), (error) => error.code === 'invalid-chain');
});

function sendExtraJson(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function startExtraMock(t) {
  const state = {
    primary: 'ok',
    fallback: 'ok',
    requests: { primary: 0, fallback: 0 },
    models: { primary: [], fallback: [] },
    sockets: new Set(),
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const side = request.url.startsWith('/primary/v1/') ? 'primary'
      : request.url.startsWith('/fallback/v1/') ? 'fallback' : undefined;
    if (side === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    state.requests[side] += 1;
    state.models[side].push(body.model);
    const mode = state[side];
    if (mode === 'tool-only') {
      sendExtraJson(response, {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_primary',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"a"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      return;
    }
    if (/^\d{3}$/.test(mode)) {
      response.writeHead(Number(mode), { 'content-type': 'text/plain' });
      response.end('provider-body-must-not-leak');
      return;
    }
    sendExtraJson(response, {
      choices: [{ message: { role: 'assistant', content: side + ' answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
  server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of state.sockets) socket.destroy();
    server.close(resolve);
  }));
  return { port: server.address().port, state };
}

function makeExtraClient(port, side, options = {}) {
  return createProviderClient('openai-compatible', {
    baseUrl: 'http://127.0.0.1:' + port + '/' + side + '/v1',
    model: side + '-default',
    apiKey: 'test-key',
    env: {},
    timeoutMs: 1000,
    ...options,
  });
}

function makeExtraChain(primary, fallback) {
  return createProviderFallback([
    { id: 'primary', label: 'Primary', client: primary },
    { id: 'fallback', label: 'Fallback', client: fallback },
  ]);
}

test('HTTP 408 and a network error are retried on the next provider', async (t) => {
  const mock = await startExtraMock(t);
  const chain = makeExtraChain(makeExtraClient(mock.port, 'primary'), makeExtraClient(mock.port, 'fallback'));

  mock.state.primary = '408';
  const answer = await chain.chat({ messages: MESSAGES });
  assert.equal(answer.text, 'fallback answer');
  assert.equal(answer.attempts[0].status, 408);
  assert.equal(answer.servedBy.id, 'fallback');

  const dead = createProviderClient('openai-compatible', {
    baseUrl: 'http://127.0.0.1:1/primary/v1',
    model: 'dead-model',
    apiKey: 'test-key',
    env: {},
    timeoutMs: 1000,
  });
  const before = mock.state.requests.fallback;
  const network = await makeExtraChain(dead, makeExtraClient(mock.port, 'fallback')).chat({ messages: MESSAGES });
  assert.equal(network.attempts[0].code, 'network-error');
  assert.equal(network.servedBy.id, 'fallback');
  assert.equal(mock.state.requests.fallback, before + 1);
});

test('a tool-call-only answer is served by the primary and not treated as empty', async (t) => {
  const mock = await startExtraMock(t);
  mock.state.primary = 'tool-only';
  const chain = makeExtraChain(makeExtraClient(mock.port, 'primary'), makeExtraClient(mock.port, 'fallback'));
  const before = mock.state.requests.fallback;

  const answer = await chain.chat({ messages: MESSAGES, tools: TOOLS });
  assert.equal(answer.text, '');
  assert.equal(answer.toolCalls.length, 1);
  assert.equal(answer.toolCalls[0].id, 'call_primary');
  assert.equal(answer.toolCalls[0].name, 'lookup');
  assert.equal(answer.toolCalls[0].arguments, '{"q":"a"}');
  assert.deepEqual(answer.servedBy, { id: 'primary', label: 'Primary', fallback: false });
  assert.deepEqual(answer.attempts, [{ id: 'primary', label: 'Primary', outcome: 'answered' }]);
  assert.equal(mock.state.requests.fallback, before);
});

test('the caller model reaches the primary while the fallback keeps its configured model', async (t) => {
  const mock = await startExtraMock(t);
  const chain = createProviderFallback([
    { id: 'primary', client: makeExtraClient(mock.port, 'primary'), model: 'primary-configured' },
    { id: 'fallback', client: makeExtraClient(mock.port, 'fallback'), model: 'fallback-chosen' },
  ]);

  const first = await chain.chat({ messages: MESSAGES, model: 'caller-model' });
  assert.equal(first.servedBy.id, 'primary');
  assert.equal(mock.state.models.primary.at(-1), 'caller-model');

  mock.state.primary = '429';
  const second = await chain.chat({ messages: MESSAGES, model: 'caller-model' });
  assert.equal(second.servedBy.id, 'fallback');
  assert.equal(mock.state.models.fallback.at(-1), 'fallback-chosen');
});

async function startResetMock(t) {
  const state = { primary: 0, fallback: 0, sockets: new Set() };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url.startsWith('/primary/v1/')) {
      state.primary += 1;
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
        response.write('{"choices":[');
      }
      setTimeout(() => response.destroy(), 10).unref();
      return;
    }
    if (request.url.startsWith('/fallback/v1/')) {
      state.fallback += 1;
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"choices":[{"index":0,"delta":{"content":"fallback stream"}}]}\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      sendJson(response, {
        choices: [{ message: { role: 'assistant', content: 'fallback answer' }, finish_reason: 'stop' }],
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of state.sockets) socket.destroy();
    server.close(resolve);
  }));
  return { port: server.address().port, state };
}

function makeResetClient(port, side) {
  return createProviderClient('openai-compatible', {
    baseUrl: 'http://' + HOST + ':' + port + '/' + side + '/v1',
    model: side + '-default',
    apiKey: 'test-key',
    env: {},
    timeoutMs: 2000,
  });
}

test('a connection reset while reading the response body fails over', async (t) => {
  const mock = await startResetMock(t);
  const chain = createProviderFallback([
    { id: 'primary', client: makeResetClient(mock.port, 'primary') },
    { id: 'fallback', client: makeResetClient(mock.port, 'fallback') },
  ]);

  const answer = await chain.chat({ messages: MESSAGES });
  assert.equal(answer.text, 'fallback answer');
  assert.equal(answer.servedBy.id, 'fallback');
  assert.equal(answer.attempts[0].code, 'network-error');
  assert.equal(mock.state.fallback, 1);
});

test('a connection reset mid-stream fails over and keeps the fallback stream', async (t) => {
  const mock = await startResetMock(t);
  const chain = createProviderFallback([
    { id: 'primary', client: makeResetClient(mock.port, 'primary') },
    { id: 'fallback', client: makeResetClient(mock.port, 'fallback') },
  ]);

  const answer = await chain.chat({ messages: MESSAGES, stream: true });
  assert.equal(answer.text, 'fallback stream');
  assert.equal(answer.servedBy.id, 'fallback');
  assert.equal(answer.attempts[0].code, 'network-error');
  assert.equal(mock.state.fallback, 1);
});

function failingClient(extra) {
  return {
    chat() {
      throw new ProviderClientError('http-status', 'provider said CANARY-MESSAGE', { status: 429, ...extra });
    },
  };
}

test('attempt summaries and exhaustion errors copy only allowlisted error fields', async () => {
  const canary = 'CANARY-BODY-VALUE';
  const chain = createProviderFallback([
    { id: 'a', client: failingClient({ body: canary, detail: canary }) },
    { id: 'b', client: failingClient({ body: canary, detail: canary }) },
  ]);

  const error = await chain.chat({ messages: MESSAGES }).catch((value) => value);
  assert.equal(error.code, 'fallback-exhausted');
  assert.equal(JSON.stringify(error).includes(canary), false);
  assert.equal(String(error).includes(canary), false);
  assert.equal(JSON.stringify(chain.describe()).includes(canary), false);
  assert.deepEqual(error.attempts.map((attempt) => attempt.status), [429, 429]);
  assert.deepEqual(Object.keys(error.attempts[0]).sort(), ['code', 'id', 'label', 'outcome', 'status']);
});

test('a successful answer keeps only id, label and outcome in attempts', async () => {
  const canary = 'CANARY-ANSWER-VALUE';
  const client = { chat() { return { text: 'ok', toolCalls: [], extra: canary }; } };
  const chain = createProviderFallback([{ id: 'a', client }]);

  const answer = await chain.chat({ messages: MESSAGES });
  assert.equal(answer.text, 'ok');
  assert.deepEqual(Object.keys(answer.attempts[0]).sort(), ['id', 'label', 'outcome']);
  assert.equal(JSON.stringify(answer.attempts).includes(canary), false);
});
