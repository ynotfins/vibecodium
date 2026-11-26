import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { createProviderClient } from '../../src/stable/gateway/provider-client.mjs';
import {
  DEFAULT_OLLAMA_PORT,
  OllamaError,
  discoverOllama,
  toOllamaProviderOptions,
  validateOllamaResult,
} from '../../src/stable/runtime/ollama.mjs';

const HOST = ['127', '0', '0', '1'].join('.');
const MESSAGES = [{ role: 'user', content: 'hello' }];
const TOOLS = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
const SECRET = 'sentinel-body-must-not-escape';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function model(name, overrides = {}) {
  return {
    name,
    model: name,
    modified_at: '2026-11-26T00:00:00.000000000Z',
    size: 1024,
    digest: 'a'.repeat(64),
    details: { format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '1B', quantization_level: 'Q4_K_M' },
    ...overrides,
  };
}

async function startServer(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    handler(request, response, requests);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const { port } = server.address();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { port, requests, url: 'http://' + HOST + ':' + port };
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function sendEvent(response, body) {
  response.write('data: ' + JSON.stringify(body) + '\n\n');
}

function tagsHandler(models) {
  return (request, response) => {
    if (request.url === '/api/tags') return sendJson(response, 200, { models });
    return sendJson(response, 404, { error: 'not found' });
  };
}

async function unusedPort(t) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

function isOllamaCode(code) {
  return (error) => error instanceof OllamaError && error.code === code;
}

test('discovers a local daemon, projects only its models and picks local chat and embedding models', async (t) => {
  const { port, requests } = await startServer(t, tagsHandler([
    model('nomic-embed-text:latest', {
      size: 274_302_368,
      details: { format: 'gguf', family: 'nomic-bert', families: ['nomic-bert'], parameter_size: '137M', quantization_level: 'F16' },
    }),
    model('qwen2.5-coder:1.5b', { size: 986_000_000 }),
    model('llama3.2:3b', { size: 2_019_393_189, details: { format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '3.2B', quantization_level: 'Q4_K_M' } }),
    model('gemma4:cloud', { size: 0, remote_model: 'gemma4:31b', remote_host: 'https://ollama.com' }),
  ]));

  const result = await discoverOllama({ port });

  assert.equal(result.available, true);
  assert.equal(result.reason, null);
  assert.equal(result.port, port);
  assert.equal(result.baseUrl, 'http://' + HOST + ':' + port + '/v1');
  assert.deepEqual(result.models.map((entry) => entry.id), [
    'gemma4:cloud', 'llama3.2:3b', 'nomic-embed-text:latest', 'qwen2.5-coder:1.5b',
  ]);
  const cloud = result.models.find((entry) => entry.id === 'gemma4:cloud');
  assert.equal(cloud.remote, true);
  assert.equal(cloud.embedding, false);
  const embed = result.models.find((entry) => entry.id === 'nomic-embed-text:latest');
  assert.equal(embed.embedding, true);
  assert.equal(embed.remote, false);
  assert.equal(embed.sizeBytes, 274_302_368);
  assert.equal(embed.parameterSize, '137M');
  assert.equal(embed.quantization, 'F16');
  assert.equal(embed.family, 'nomic-bert');
  assert.equal(result.chatModel, 'llama3.2:3b');
  assert.equal(result.embeddingModel, 'nomic-embed-text:latest');
  assert.deepEqual([...result.notices], ['ollama-remote-models']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.models));
  assert.ok(Object.isFrozen(result.models[0]));
  assert.ok(Object.isFrozen(result.notices));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, '/api/tags');
  assert.equal(requests[0].headers.accept, 'application/json');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('selects the largest local model and breaks a size tie by name', async (t) => {
  const { port } = await startServer(t, tagsHandler([
    model('zeta:1b', { size: 500 }),
    model('alpha:1b', { size: 900 }),
    model('beta:1b', { size: 900 }),
    model('tiny:1b', { size: 10 }),
  ]));

  const result = await discoverOllama({ port });
  assert.equal(result.chatModel, 'alpha:1b');
  assert.equal(result.embeddingModel, null);
  assert.deepEqual([...result.notices], ['ollama-no-embedding-model']);
});

test('reports an empty or chat-less daemon as notices, not failures', async (t) => {
  const empty = await startServer(t, tagsHandler([]));
  const emptyResult = await discoverOllama({ port: empty.port });
  assert.equal(emptyResult.available, true);
  assert.deepEqual(emptyResult.models, []);
  assert.equal(emptyResult.chatModel, null);
  assert.equal(emptyResult.embeddingModel, null);
  assert.deepEqual([...emptyResult.notices], ['ollama-no-models', 'ollama-no-chat-model', 'ollama-no-embedding-model']);

  const embedOnly = await startServer(t, tagsHandler([model('nomic-embed-text:latest')]));
  const embedResult = await discoverOllama({ port: embedOnly.port });
  assert.equal(embedResult.available, true);
  assert.equal(embedResult.chatModel, null);
  assert.equal(embedResult.embeddingModel, 'nomic-embed-text:latest');
  assert.deepEqual([...embedResult.notices], ['ollama-no-chat-model']);
});

test('reports a refused connection as unreachable without throwing', async (t) => {
  const port = await unusedPort(t);
  const result = await discoverOllama({ port, timeoutMs: 500 });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'unreachable');
  assert.equal(result.baseUrl, null);
  assert.equal(result.port, port);
  assert.deepEqual(result.models, []);
  assert.deepEqual([...result.notices], ['ollama-unreachable']);
});

test('reports a non-200 status as http-error with the integer status and no body', async (t) => {
  const { port } = await startServer(t, (request, response) => {
    sendJson(response, 500, { error: SECRET });
  });
  const result = await discoverOllama({ port });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'http-error');
  assert.equal(result.status, 500);
  assert.deepEqual([...result.notices], ['ollama-http-error']);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('reports a non-JSON body as invalid-response without echoing it', async (t) => {
  const { port } = await startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>' + SECRET + '</html>');
  });
  const result = await discoverOllama({ port });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'invalid-response');
  assert.deepEqual([...result.notices], ['ollama-invalid-response']);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('rejects a control character, a bidi character or an out-of-class model name', async (t) => {
  for (const name of ['bad\u0007name', 'evil\u202Ename', 'has space', 'a'.repeat(201), '']) {
    const { port } = await startServer(t, tagsHandler([model(name, { name })]));
    const result = await discoverOllama({ port });
    assert.equal(result.available, false, JSON.stringify(name));
    assert.equal(result.reason, 'invalid-response');
  }
});

test('rejects a malformed list, a malformed entry and too many models', async (t) => {
  const cases = [
    { models: 'nope' },
    { models: [null] },
    { models: [{ size: 1 }] },
    { models: [model('ok:1b', { size: -1 })] },
    { models: [model('ok:1b', { size: 1.5 })] },
    { models: [model('ok:1b', { details: { quantization_level: 'bad\u202E' } })] },
    { models: Array.from({ length: 257 }, (_, index) => model('m' + index + ':1b')) },
  ];
  for (const body of cases) {
    const { port } = await startServer(t, (request, response) => sendJson(response, 200, body));
    const result = await discoverOllama({ port });
    assert.equal(result.available, false, JSON.stringify(body).slice(0, 80));
    assert.equal(result.reason, 'invalid-response');
  }
});

test('caps the response body and reports invalid-response', async (t) => {
  const { port } = await startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"models":[');
    response.end('"'.repeat(4096) + ']}');
  });
  const result = await discoverOllama({ port, maxResponseBytes: 1024 });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'invalid-response');
});

test('times out a body that stalls after the headers', async (t) => {
  const { port } = await startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"models":[');
  });
  const started = Date.now();
  const result = await discoverOllama({ port, timeoutMs: 150 });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'timeout');
  assert.deepEqual([...result.notices], ['ollama-timeout']);
  assert.ok(Date.now() - started < 5000);
});

test('times out an injected fetch that ignores the abort signal', async (t) => {
  const started = Date.now();
  const result = await discoverOllama({
    port: DEFAULT_OLLAMA_PORT,
    timeoutMs: 100,
    fetch: () => new Promise(() => {}),
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'timeout');
  assert.ok(Date.now() - started < 5000);
});

test('maps an injected fetch rejection to unreachable and an invalid answer to invalid-response', async () => {
  const rejected = await discoverOllama({
    port: DEFAULT_OLLAMA_PORT,
    fetch: async () => { throw new Error(SECRET); },
  });
  assert.equal(rejected.reason, 'unreachable');
  assert.equal(JSON.stringify(rejected).includes(SECRET), false);

  const notAResponse = await discoverOllama({ port: DEFAULT_OLLAMA_PORT, fetch: async () => null });
  assert.equal(notAResponse.reason, 'invalid-response');
});

test('does not follow a redirect', async (t) => {
  const { port, requests } = await startServer(t, (request, response) => {
    if (request.url === '/api/tags') {
      response.writeHead(302, { location: '/evil' });
      return response.end();
    }
    return sendJson(response, 200, { models: [] });
  });
  const result = await discoverOllama({ port });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'unreachable');
  assert.deepEqual(requests.map((entry) => entry.url), ['/api/tags']);
});

test('rejects malformed options and never invokes an accessor', async () => {
  let invoked = false;
  const hostile = {};
  Object.defineProperty(hostile, 'port', {
    enumerable: true,
    get() {
      invoked = true;
      return 11434;
    },
  });

  const cases = [
    hostile,
    new Proxy({}, { ownKeys() { throw new Error('trapped'); } }),
    { port: 80 },
    { port: 65536 },
    { port: 11434.5 },
    { port: '11434' },
    { timeoutMs: 0 },
    { timeoutMs: 60_000 },
    { maxResponseBytes: 16 },
    { maxResponseBytes: 9 * 1024 * 1024 },
    { fetch: 'not-a-function' },
    { unknown: true },
  ];
  for (const options of cases) {
    await assert.rejects(discoverOllama(options), isOllamaCode('invalid-options'));
  }
  assert.equal(invoked, false);
});

test('toOllamaProviderOptions returns exactly the base URL and a discovered local chat model', async (t) => {
  const { port } = await startServer(t, tagsHandler([
    model('nomic-embed-text:latest', { details: { family: 'nomic-bert' } }),
    model('llama3.2:3b', { size: 900 }),
    model('qwen2.5-coder:1.5b', { size: 800 }),
  ]));
  const result = await discoverOllama({ port });

  const defaults = toOllamaProviderOptions(result);
  assert.deepEqual({ ...defaults }, { baseUrl: 'http://' + HOST + ':' + port + '/v1', model: 'llama3.2:3b' });
  assert.ok(Object.isFrozen(defaults));

  const chosen = toOllamaProviderOptions(result, { model: 'qwen2.5-coder:1.5b' });
  assert.equal(chosen.model, 'qwen2.5-coder:1.5b');
});

test('toOllamaProviderOptions rejects unavailable, unknown, remote and embedding models', async (t) => {
  const unavailable = await discoverOllama({ port: await unusedPort(t), timeoutMs: 500 });
  assert.throws(() => toOllamaProviderOptions(unavailable), isOllamaCode('ollama-unavailable'));

  const { port } = await startServer(t, tagsHandler([
    model('nomic-embed-text:latest', { details: { family: 'nomic-bert' } }),
    model('llama3.2:3b'),
    model('gemma4:cloud', { remote_host: 'https://ollama.com' }),
  ]));
  const result = await discoverOllama({ port });

  assert.throws(() => toOllamaProviderOptions(result, { model: 'not-installed:1b' }), isOllamaCode('unknown-model'));
  assert.throws(() => toOllamaProviderOptions(result, { model: 'nomic-embed-text:latest' }), isOllamaCode('unknown-model'));
  assert.throws(() => toOllamaProviderOptions(result, { model: 'gemma4:cloud' }), isOllamaCode('unknown-model'));

  let invoked = false;
  const hostile = {};
  Object.defineProperty(hostile, 'model', {
    enumerable: true,
    get() {
      invoked = true;
      return 'llama3.2:3b';
    },
  });
  assert.throws(() => toOllamaProviderOptions(result, hostile), isOllamaCode('invalid-options'));
  assert.throws(() => toOllamaProviderOptions(result, { unknown: true }), isOllamaCode('invalid-options'));
  assert.throws(() => toOllamaProviderOptions({ ...result, available: 'yes' }), isOllamaCode('invalid-result'));
  assert.equal(invoked, false);
});

test('the discovery result is deterministic and the daemon body is not retained', async (t) => {
  const body = { models: [model('b:1b', { size: 2 }), model('a:1b', { size: 1 })] };
  const { port } = await startServer(t, (request, response) => sendJson(response, 200, body));
  const first = await discoverOllama({ port });
  const second = await discoverOllama({ port });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes('modified_at'), false);
  assert.equal(JSON.stringify(first).includes('digest'), false);
  assert.deepEqual(body.models.map((entry) => entry.name), ['b:1b', 'a:1b']);
});

test('the B1 ollama preset serves chat, streaming, tool calls and embeddings from the discovered base URL', async (t) => {
  const { port, requests } = await startServer(t, async (request, response) => {
    if (request.url === '/api/tags') {
      return sendJson(response, 200, {
        models: [model('llama3.2:3b', { size: 900 }), model('nomic-embed-text:latest', { details: { family: 'nomic-bert' } })],
      });
    }
    if (request.url === '/v1/embeddings') {
      const body = await readBody(request);
      return sendJson(response, 200, {
        object: 'list',
        model: body.model,
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 1 },
      });
    }
    if (request.url === '/v1/chat/completions') {
      const body = await readBody(request);
      const tools = Array.isArray(body.tools) && body.tools.length > 0;
      const usage = { prompt_tokens: 3, completion_tokens: 2 };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        sendEvent(response, { choices: [{ index: 0, delta: { role: 'assistant' } }] });
        if (tools) {
          sendEvent(response, {
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] },
            }],
          });
          sendEvent(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] });
          sendEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
        } else {
          sendEvent(response, { choices: [{ index: 0, delta: { content: 'local ' } }] });
          sendEvent(response, { choices: [{ index: 0, delta: { content: 'answer' } }] });
          sendEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
        }
        return response.end('data: [DONE]\n\n');
      }
      if (tools) {
        return sendJson(response, 200, {
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage,
        });
      }
      return sendJson(response, 200, {
        choices: [{ index: 0, message: { role: 'assistant', content: 'local answer' }, finish_reason: 'stop' }],
        usage,
      });
    }
    return sendJson(response, 404, { error: 'not found' });
  });

  const discovered = await discoverOllama({ port });
  const options = toOllamaProviderOptions(discovered);
  const client = createProviderClient('ollama', { ...options, env: {} });

  const chat = await client.chat({ messages: MESSAGES });
  assert.equal(chat.text, 'local answer');
  const streamed = await client.chat({ messages: MESSAGES, stream: true });
  assert.equal(streamed.text, 'local answer');
  const tooled = await client.chat({ messages: MESSAGES, tools: TOOLS });
  assert.equal(tooled.toolCalls.length, 1);
  assert.equal(tooled.toolCalls[0].name, 'lookup');
  assert.equal(tooled.toolCalls[0].arguments, '{"q":"x"}');
  const streamedTool = await client.chat({ messages: MESSAGES, tools: TOOLS, stream: true });
  assert.equal(streamedTool.toolCalls.length, 1);
  assert.equal(streamedTool.toolCalls[0].arguments, '{"q":"x"}');
  const embedded = await client.embeddings({ input: ['a'], model: discovered.embeddingModel });
  assert.deepEqual([...embedded.vectors[0]], [0.1, 0.2, 0.3]);

  const apiRequests = requests.filter((entry) => entry.url !== '/api/tags');
  assert.ok(apiRequests.length >= 5);
  for (const entry of apiRequests) {
    assert.equal(entry.headers.authorization, undefined);
    assert.equal(entry.headers['content-type'], 'application/json');
  }
  await delay(0);
});

test('accepts a JSON body exactly at the byte cap and rejects one byte more', async (t) => {
  const base = JSON.stringify({ models: [] });
  const cap = 1024;
  const exact = base + ' '.repeat(cap - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(exact), cap);

  const atCap = await startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(exact);
  });
  const accepted = await discoverOllama({ port: atCap.port, maxResponseBytes: cap });
  assert.equal(accepted.available, true);
  assert.deepEqual(accepted.models, []);

  const overCap = await startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(exact + ' ');
  });
  const rejected = await discoverOllama({ port: overCap.port, maxResponseBytes: cap });
  assert.equal(rejected.available, false);
  assert.equal(rejected.reason, 'invalid-response');
});

test('rejects a valid JSON body that exceeds the byte cap', async (t) => {
  const cap = 1024;
  const padded = JSON.stringify({ models: [] }) + ' '.repeat(cap);
  const { port } = await startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(padded);
  });
  const result = await discoverOllama({ port, maxResponseBytes: cap });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'invalid-response');
});

test('reads a Response-like answer without a body stream through text()', async () => {
  const text = JSON.stringify({ models: [model('fallback:1b', { size: 7 })] });
  const fakeFetch = async () => ({
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => text,
  });
  const result = await discoverOllama({ port: DEFAULT_OLLAMA_PORT, fetch: fakeFetch });
  assert.equal(result.available, true);
  assert.equal(result.chatModel, 'fallback:1b');
});

test('caps a text-only answer without a body stream', async () => {
  const cap = 1024;
  const padded = JSON.stringify({ models: [] }) + ' '.repeat(cap);
  const fakeFetch = async () => ({
    status: 200,
    headers: { get: () => null },
    text: async () => padded,
  });
  const result = await discoverOllama({ port: DEFAULT_OLLAMA_PORT, maxResponseBytes: cap, fetch: fakeFetch });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'invalid-response');
});

test('accepts an entry with only the model field and ignores unknown entry fields', async (t) => {
  const entry = { model: 'only-model:1b', size: 5, details: {}, surprise: 'ignored' };
  const { port } = await startServer(t, tagsHandler([entry]));
  const result = await discoverOllama({ port });
  assert.equal(result.available, true);
  assert.equal(result.models[0].id, 'only-model:1b');
  assert.equal(result.chatModel, 'only-model:1b');
});

test('toOllamaProviderOptions rejects a result model entry accessor without invoking it', async (t) => {
  const { port } = await startServer(t, tagsHandler([model('llama3.2:3b')]));
  const result = await discoverOllama({ port });
  let invoked = false;
  const hostileEntry = {};
  Object.defineProperty(hostileEntry, 'id', {
    enumerable: true,
    get() {
      invoked = true;
      return 'llama3.2:3b';
    },
  });
  for (const key of ['sizeBytes', 'parameterSize', 'quantization', 'family']) {
    Object.defineProperty(hostileEntry, key, { enumerable: true, value: null });
  }
  hostileEntry.embedding = false;
  hostileEntry.remote = false;
  const forged = { ...result, models: [hostileEntry] };
  assert.throws(() => toOllamaProviderOptions(forged), isOllamaCode('invalid-result'));
  assert.equal(invoked, false);
});

test('accepts null scalar metadata and detects an embedding model from families alone', async (t) => {
  const { port } = await startServer(t, tagsHandler([
    model('plain-families:1b', {
      size: null,
      details: { family: null, families: ['bert'], parameter_size: null, quantization_level: null },
    }),
  ]));
  const result = await discoverOllama({ port });
  assert.equal(result.available, true);
  const entry = result.models[0];
  assert.equal(entry.sizeBytes, null);
  assert.equal(entry.family, null);
  assert.equal(entry.parameterSize, null);
  assert.equal(entry.quantization, null);
  assert.equal(entry.embedding, true);
  assert.equal(result.embeddingModel, 'plain-families:1b');
});

test('rejects sizes, metadata and family lists beyond their bounds', async (t) => {
  const cases = [
    [model('big:1b', { size: Number.MAX_SAFE_INTEGER + 1 })],
    [model('long:1b', { details: { family: 'a'.repeat(65) } })],
    [model('many:1b', { details: { families: Array.from({ length: 17 }, () => 'x') } })],
    [model('longfam:1b', { details: { families: ['a'.repeat(65)] } })],
  ];
  for (const models of cases) {
    const { port } = await startServer(t, tagsHandler(models));
    const result = await discoverOllama({ port });
    assert.equal(result.available, false, JSON.stringify(models));
    assert.equal(result.reason, 'invalid-response');
  }
});

test('marks remote_model and :cloud entries as remote without a remote_host', async (t) => {
  const { port } = await startServer(t, tagsHandler([
    model('vendor-model:latest', { remote_model: 'vendor-model:70b' }),
    model('gemma4:cloud'),
    model('local:1b', { size: 10 }),
  ]));
  const result = await discoverOllama({ port });
  assert.equal(result.models.find((entry) => entry.id === 'vendor-model:latest').remote, true);
  assert.equal(result.models.find((entry) => entry.id === 'gemma4:cloud').remote, true);
  assert.equal(result.chatModel, 'local:1b');
  assert.ok([...result.notices].includes('ollama-remote-models'));
});

test('rejects out-of-range ports and any host or URL override', async () => {
  const cases = [
    { port: 999 },
    { port: 1_000_000 },
    { host: HOST },
    { baseUrl: 'http://' + HOST + ':11434' },
    { url: 'http://example.com:11434/api/tags' },
  ];
  for (const options of cases) {
    await assert.rejects(discoverOllama(options), isOllamaCode('invalid-options'));
  }
});

test('toOllamaProviderOptions rejects a daemon with no chat model and an invalid chosen model', async (t) => {
  const { port } = await startServer(t, tagsHandler([
    model('nomic-embed-text:latest', { details: { family: 'nomic-bert' } }),
  ]));
  const embedOnly = await discoverOllama({ port });
  assert.equal(embedOnly.chatModel, null);
  assert.throws(() => toOllamaProviderOptions(embedOnly), isOllamaCode('ollama-no-chat-model'));

  const chat = await startServer(t, tagsHandler([model('llama3.2:3b')]));
  const withChat = await discoverOllama({ port: chat.port });
  assert.throws(() => toOllamaProviderOptions(withChat, { model: 'has space' }), isOllamaCode('invalid-options'));
  assert.throws(() => toOllamaProviderOptions(withChat, { model: '' }), isOllamaCode('invalid-options'));
});

test('reports an invalid JSON body without echoing it', async (t) => {
  const { port } = await startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"models": ' + SECRET + ' not-json');
  });
  const result = await discoverOllama({ port });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'invalid-response');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('evaluates the M1 policy before the request and maps a denial to policy-denied', async () => {
  const calls = [];
  let fetched = false;
  const denied = await discoverOllama({
    port: DEFAULT_OLLAMA_PORT,
    fetch: async () => { fetched = true; throw new Error('must not fetch'); },
    evaluate: (url) => {
      calls.push(url);
      return { allowed: false, code: 'denied-by-default' };
    },
  });
  assert.deepEqual(calls, ['http://' + HOST + ':' + DEFAULT_OLLAMA_PORT + '/api/tags']);
  assert.equal(fetched, false);
  assert.equal(denied.available, false);
  assert.equal(denied.reason, 'policy-denied');
  assert.deepEqual([...denied.notices], ['ollama-policy-denied']);

  const noDecision = await discoverOllama({ port: DEFAULT_OLLAMA_PORT, evaluate: () => undefined });
  assert.equal(noDecision.reason, 'policy-denied');

  const allowed = await discoverOllama({
    port: DEFAULT_OLLAMA_PORT,
    fetch: async () => ({ status: 200, headers: { get: () => 'application/json' }, text: async () => '{"models":[]}' }),
    evaluate: () => ({ allowed: true, code: 'local-endpoint' }),
  });
  assert.equal(allowed.available, true);

  await assert.rejects(discoverOllama({ port: DEFAULT_OLLAMA_PORT, evaluate: 'nope' }), isOllamaCode('invalid-options'));
  const thrown = await discoverOllama({ port: DEFAULT_OLLAMA_PORT, evaluate: () => { throw new Error('x'); } });
  assert.equal(thrown.reason, 'policy-denied');
});

test('accepts null scalar metadata and null families, and rejects a non-JSON content type suffix', async (t) => {
  const { port } = await startServer(t, tagsHandler([
    model('llama3.2:3b', { size: null, details: { family: null, families: null, parameter_size: null, quantization_level: null } }),
  ]));
  const result = await discoverOllama({ port });
  assert.equal(result.available, true);
  assert.equal(result.chatModel, 'llama3.2:3b');
  assert.equal(result.models[0].sizeBytes, null);
  assert.equal(result.models[0].family, null);

  const suffix = await startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/jsonx' });
    response.end('{"models":[]}');
  });
  const rejected = await discoverOllama({ port: suffix.port });
  assert.equal(rejected.available, false);
  assert.equal(rejected.reason, 'invalid-response');
});

test('rejects a forged result whose default models are remote, embedding-only or absent', async (t) => {
  const { port } = await startServer(t, tagsHandler([
    model('llama3.2:3b'),
    model('nomic-embed-text:latest', { details: { family: 'nomic-bert' } }),
    model('gemma4:cloud', { remote_host: 'https://ollama.com' }),
  ]));
  const result = await discoverOllama({ port });
  const forgedChat = { ...result, chatModel: 'gemma4:cloud' };
  assert.throws(() => toOllamaProviderOptions(forgedChat), isOllamaCode('invalid-result'));
  const forgedEmbedding = { ...result, embeddingModel: 'llama3.2:3b' };
  assert.throws(() => toOllamaProviderOptions(forgedEmbedding), isOllamaCode('invalid-result'));
  const missingChat = { ...result, chatModel: 'not-installed:1b' };
  assert.throws(() => toOllamaProviderOptions(missingChat), isOllamaCode('invalid-result'));
  const forgedVersion = { ...result, version: 2 };
  assert.throws(() => toOllamaProviderOptions(forgedVersion), isOllamaCode('invalid-result'));
  const forgedBaseUrl = { ...result, baseUrl: 'http://example.com/v1' };
  assert.throws(() => toOllamaProviderOptions(forgedBaseUrl), isOllamaCode('invalid-result'));
  const valid = toOllamaProviderOptions(result);
  assert.equal(valid.model, 'llama3.2:3b');
});
test('sends exactly one credential-free GET with the accept header and the redirect refusal', async () => {
  let seen;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return {
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ models: [] }),
    };
  };
  const result = await discoverOllama({ port: DEFAULT_OLLAMA_PORT, fetch: fakeFetch });
  assert.equal(result.available, true);
  assert.equal(seen.url, 'http://' + HOST + ':' + DEFAULT_OLLAMA_PORT + '/api/tags');
  assert.equal(seen.init.method, 'GET');
  assert.deepEqual(seen.init.headers, { accept: 'application/json' });
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.headers.authorization, undefined);
  assert.equal('body' in seen.init, false);
});

test('fails closed on a throwing policy decision and on a non-bytes body chunk', async () => {
  const hostile = new Proxy({}, {
    get() { throw new Error('trap'); },
  });
  const denied = await discoverOllama({ port: DEFAULT_OLLAMA_PORT, evaluate: () => hostile });
  assert.equal(denied.available, false);
  assert.equal(denied.reason, 'policy-denied');

  const steps = [{ done: false, value: '{"models":[]}' }, { done: true }];
  const reader = {
    read: async () => steps.shift() ?? { done: true },
    cancel: async () => {},
    releaseLock() {},
  };
  const chunked = await discoverOllama({
    port: DEFAULT_OLLAMA_PORT,
    fetch: async () => ({
      status: 200,
      headers: { get: () => 'application/json' },
      body: { getReader: () => reader },
    }),
  });
  assert.equal(chunked.available, false);
  assert.equal(chunked.reason, 'invalid-response');
});

test('rejects a body-less response on the product fetch path without calling text()', async () => {
  const originalFetch = globalThis.fetch;
  let textCalled = false;
  globalThis.fetch = async () => ({
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => {
      textCalled = true;
      return '{"models":[]}';
    },
  });
  try {
    const result = await discoverOllama({ port: DEFAULT_OLLAMA_PORT });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'invalid-response');
    assert.equal(textCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('tolerates a missing content type and accepts an application/json suffix', async (t) => {
  const missing = await startServer(t, (request, response) => {
    response.writeHead(200);
    response.end('{"models":[{"name":"no-ct:1b","size":1,"details":{}}]}');
  });
  const noHeader = await discoverOllama({ port: missing.port });
  assert.equal(noHeader.available, true);
  assert.equal(noHeader.chatModel, 'no-ct:1b');

  const suffix = await startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end('{"models":[{"name":"suffix:1b","size":1,"details":{}}]}');
  });
  const withSuffix = await discoverOllama({ port: suffix.port });
  assert.equal(withSuffix.available, true);
  assert.equal(withSuffix.chatModel, 'suffix:1b');
});

test('aborts the request on a non-200 or non-JSON failure and accepts DataView and ArrayBuffer chunks', async () => {
  let aborted = false;
  const failing = await discoverOllama({
    port: DEFAULT_OLLAMA_PORT,
    fetch: async (url, init) => {
      init.signal.addEventListener('abort', () => { aborted = true; });
      return {
        status: 500,
        headers: { get: () => 'application/json' },
        body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
      };
    },
  });
  assert.equal(failing.available, false);
  assert.equal(failing.reason, 'http-error');
  assert.equal(aborted, true);

  const body = Buffer.from(JSON.stringify({ models: [model('llama3.2:3b')] }), 'utf8');
  const midpoint = Math.floor(body.byteLength / 2);
  const chunks = [
    new DataView(body.buffer, body.byteOffset, midpoint),
    body.buffer.slice(body.byteOffset + midpoint, body.byteOffset + body.byteLength),
  ];
  const parsed = await discoverOllama({
    port: DEFAULT_OLLAMA_PORT,
    fetch: async () => ({
      status: 200,
      headers: { get: () => 'application/json' },
      body: {
        getReader: () => {
          let index = 0;
          return {
            read: async () => (index < chunks.length
              ? { done: false, value: chunks[index++] }
              : { done: true }),
            cancel: async () => {},
            releaseLock() {},
          };
        },
      },
    }),
  });
  assert.equal(parsed.available, true);
  assert.equal(parsed.chatModel, 'llama3.2:3b');
});

test('validateOllamaResult projects an available result to a frozen display summary', async (t) => {
  const { port } = await startServer(t, tagsHandler([
    model('nomic-embed-text:latest', { details: { family: 'nomic-bert' } }),
    model('llama3.2:3b', { size: 900 }),
  ]));
  const summary = validateOllamaResult(await discoverOllama({ port }));
  assert.deepEqual({ ...summary }, {
    version: 1,
    available: true,
    reason: null,
    status: 200,
    port,
    baseUrl: 'http://' + HOST + ':' + port + '/v1',
    chatModel: 'llama3.2:3b',
    embeddingModel: 'nomic-embed-text:latest',
    modelCount: 2,
    notices: [],
  });
  assert.equal('models' in summary, false);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.notices), true);
});

test('validateOllamaResult summarizes an unavailable result and rejects forged or unsafe results', async (t) => {
  const unavailable = await discoverOllama({ port: await unusedPort(t), timeoutMs: 500 });
  const summary = validateOllamaResult(unavailable);
  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'unreachable');
  assert.equal(summary.status, null);
  assert.equal(summary.baseUrl, null);
  assert.equal(summary.chatModel, null);
  assert.equal(summary.modelCount, 0);
  assert.deepEqual([...summary.notices], ['ollama-unreachable']);
  assert.equal(Object.isFrozen(summary), true);

  const { port } = await startServer(t, tagsHandler([model('llama3.2:3b')]));
  const result = await discoverOllama({ port });
  for (const forged of [
    { ...result, version: 2 },
    { ...result, available: 'yes' },
    { ...result, port: 80 },
    { ...result, chatModel: 'missing:1b' },
    { ...result, notices: ['ollama-unknown'] },
    { ...result, notices: [{ length: 0 }] },
    { ...result, baseUrl: 'http://example.com/v1' },
  ]) {
    assert.throws(() => validateOllamaResult(forged), isOllamaCode('invalid-result'));
  }
  assert.throws(() => validateOllamaResult({ ...unavailable, reason: 'melted' }), isOllamaCode('invalid-result'));
  assert.throws(() => validateOllamaResult({ ...unavailable, status: 99 }), isOllamaCode('invalid-result'));
  assert.throws(() => validateOllamaResult({ ...unavailable, baseUrl: 'http://example.com/v1' }),
    isOllamaCode('invalid-result'));
  assert.throws(() => validateOllamaResult({ ...unavailable, status: '500' }), isOllamaCode('invalid-result'));
  assert.throws(() => validateOllamaResult({ ...unavailable, models: [{ id: 'llama3.2:3b' }] }),
    isOllamaCode('invalid-result'));
  assert.throws(() => validateOllamaResult({ ...unavailable, chatModel: 'llama3.2:3b' }),
    isOllamaCode('invalid-result'));
  assert.throws(() => validateOllamaResult({ ...unavailable, embeddingModel: 'nomic-embed-text:latest' }),
    isOllamaCode('invalid-result'));

  const missingNotices = { ...result };
  delete missingNotices.notices;
  assert.throws(() => validateOllamaResult(missingNotices), isOllamaCode('invalid-result'));

  // A live Proxy whose get trap throws must still be read through own data descriptors.
  const proxied = new Proxy(result, {
    get() { throw new Error('get trap must not run'); },
  });
  assert.equal(validateOllamaResult(proxied).available, true);

  let invoked = false;
  const accessor = { ...result };
  Object.defineProperty(accessor, 'chatModel', {
    enumerable: true,
    get() { invoked = true; return 'llama3.2:3b'; },
  });
  assert.throws(() => validateOllamaResult(accessor), isOllamaCode('invalid-result'));
  assert.equal(invoked, false);

  const revoked = Proxy.revocable(result, {});
  revoked.revoke();
  assert.throws(() => validateOllamaResult(revoked.proxy), isOllamaCode('invalid-result'));
});

test('validateOllamaResult never invokes a Proxy array get trap', async (t) => {
  const { port } = await startServer(t, (request, response) => sendJson(response, 200, {
    models: [model('llama3.2:3b')],
  }));
  const result = await discoverOllama({ port });
  const trapped = (items) => new Proxy(items, {
    get() { throw new Error('get trap ran'); },
  });
  const summary = validateOllamaResult({
    ...result,
    models: trapped([...result.models]),
    notices: trapped([...result.notices]),
  });
  assert.equal(summary.available, true);
  assert.equal(summary.modelCount, 1);
  assert.deepEqual([...summary.notices], ['ollama-no-embedding-model']);
  assert.ok(Object.isFrozen(summary.notices));
});
