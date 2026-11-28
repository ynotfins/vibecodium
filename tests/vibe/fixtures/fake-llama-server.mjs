// Stand-in for a caller-supplied llama.cpp llama-server, used by the llama-server supervisor tests. It
// speaks the loopback contract the supervisor and the B1 client rely on: GET /health and /props, then
// /v1/chat/completions (plain, streaming and tool calls), /v1/embeddings, /v1/models and /infill.
// When LLAMA_API_KEY is set it enforces the llama.cpp rule: /health stays public, every other path
// needs `Authorization: Bearer <key>` or `X-Api-Key`.
// Environment switches control a never-ready, unhealthy, early-exit or SIGTERM-ignoring failure. It
// writes the argv and selected environment to FAKE_LLAMA_LOG so the test can prove exactly what it
// received, and appends one boot line to FAKE_LLAMA_STARTS so a restart can be counted.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
const startsFile = process.env.FAKE_LLAMA_STARTS;
const crashMs = Number.parseInt(process.env.FAKE_LLAMA_CRASH_MS ?? '150', 10);
// Never written to the log: the test only needs to know that a key reached the child.
const apiKey = process.env.LLAMA_API_KEY ?? '';

function presentedKey(request) {
  const bearer = request.headers.authorization;
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) return bearer.slice('Bearer '.length);
  const header = request.headers['x-api-key'];
  return typeof header === 'string' ? header : '';
}

function authorized(request) {
  return apiKey.length === 0 || presentedKey(request) === apiKey;
}

let startCount = 1;
if (startsFile) {
  appendFileSync(startsFile, String(Date.now()) + ':' + String(process.pid) + '\n');
  startCount = readFileSync(startsFile, 'utf8').split('\n').filter((line) => line.length > 0).length;
}

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
      HAS_API_KEY: apiKey.length === 0 ? 'absent' : 'present',
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
    // /health is public in llama.cpp so a supervisor can poll it before the key is accepted; every
    // other path is authenticated.
    if (request.url === '/health') return sendJson(response, 200, { status: 'ok' });
    if (!authorized(request)) {
      return sendJson(response, 401, { error: { message: 'Invalid API Key', type: 'authentication_error' } });
    }
    if (request.url === '/props') {
      return sendJson(response, 200, {
        default_generation_settings: { n_ctx: 4096 },
        model_path: 'fake-gguf',
        total_slots: 1,
      });
    }
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
} else if (mode === 'crash-once' || mode === 'crash-twice' || mode === 'crash-after') {
  // Become healthy first, then die while serving, so the supervisor sees an unexpected exit after
  // readiness instead of a failed start. crash-once dies on its first boot, crash-twice on the first
  // two boots and crash-after on every boot.
  startServer();
  const crashes = mode === 'crash-after'
    || (mode === 'crash-once' && startCount === 1)
    || (mode === 'crash-twice' && startCount <= 2);
  if (crashes) setTimeout(() => process.exit(7), crashMs);
} else if (mode === 'crash-once-then-exit') {
  // Become healthy once and then die while serving, so the supervisor restarts; every later boot
  // exits before it can become ready, so a restart attempt itself fails.
  if (startCount === 1) {
    startServer();
    setTimeout(() => process.exit(7), crashMs);
  } else {
    setTimeout(() => process.exit(3), 20);
  }
} else {
  if (mode === 'stubborn') process.on('SIGTERM', () => {});
  startServer();
}
