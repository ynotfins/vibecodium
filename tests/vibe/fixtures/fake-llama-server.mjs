// Stand-in for a caller-supplied llama.cpp llama-server, used by the llama-server supervisor tests. It
// speaks the loopback contract the supervisor and the B1 client rely on: GET /health, then
// /v1/chat/completions (plain, streaming and tool calls), /v1/embeddings, /v1/models and /infill.
// Environment switches control a never-ready, unhealthy, early-exit or SIGTERM-ignoring failure. It
// writes the argv and selected environment to FAKE_LLAMA_LOG so the test can prove exactly what it
// received.

import { writeFileSync } from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);

function flagValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const host = ['127', '0', '0', '1'].join('.');
const port = Number.parseInt(flagValue('--port') ?? '0', 10);
const mode = (process.env.FAKE_LLAMA_MODE ?? 'ok').trim().toLowerCase();
const log = process.env.FAKE_LLAMA_LOG;

const OUTPUT_MARKER = ['vibe', 'codium', 'output', 'tail', 'marker'].join('-');
process.stdout.write(OUTPUT_MARKER + '\n');
process.stderr.write(OUTPUT_MARKER + '-stderr\n');

if (log) {
  writeFileSync(log, JSON.stringify({
    pid: process.pid,
    args,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      LANG: process.env.LANG ?? '',
      LC_ALL: process.env.LC_ALL ?? '',
      FAKE_LLAMA_MODE: process.env.FAKE_LLAMA_MODE ?? '',
      FAKE_LLAMA_LOG: process.env.FAKE_LLAMA_LOG ?? '',
      HAS_LEAK: process.env.VIBECODIUM_TEST_LEAK === undefined ? 'absent' : 'present',
      VIBECODIUM_TEST_SECRET: process.env.VIBECODIUM_TEST_SECRET ?? '',
    },
  }));
  writeFileSync(log + '.leak', process.env.VIBECODIUM_TEST_LEAK ?? '');
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
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendEvent(response, body) {
  response.write('data: ' + JSON.stringify(body) + '\n\n');
}

function startServer() {
  const server = http.createServer(async (request, response) => {
    if (request.url === '/health') return sendJson(response, 200, { status: 'ok' });
    if (request.url === '/v1/models') return sendJson(response, 200, { data: [{ id: 'fake-gguf', object: 'model' }] });
    if (request.url === '/infill') return sendJson(response, 200, { content: 'filled', stop: true });
    if (request.url === '/v1/embeddings') {
      return sendJson(response, 200, {
        object: 'list', model: 'fake-gguf',
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
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":' },
                }],
              },
            }],
          });
          sendEvent(response, {
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }],
          });
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
  server.listen(port, host);
  server.on('close', () => process.exit(0));
  return server;
}

if (mode === 'exit') {
  setTimeout(() => process.exit(3), 20);
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'unhealthy') {
  http.createServer((request, response) => sendJson(response, 500, { status: 'loading' })).listen(port, host);
} else {
  if (mode === 'stubborn') process.on('SIGTERM', () => {});
  startServer();
}
