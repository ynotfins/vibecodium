import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { isEndpointPolicyError } from '../../src/stable/gateway/provider-client.mjs';
import {
  DEFAULT_ROUTER_TIMEOUT_MS,
  DIFFICULTIES,
  MAX_ROUTER_INPUT_CHARS,
  MAX_ROUTER_RESPONSE_BYTES,
  MORPH_ROUTER_API_KEY_ENV,
  MORPH_ROUTER_BASE_URL,
  MORPH_ROUTER_VERSION,
  MorphRouterError,
  ROUTER_CLASSIFY_PATH,
  ROUTER_CLASSES,
  ROUTER_TIERS,
  TIER_BY_DIFFICULTY,
  createMorphRouter,
} from '../../src/stable/gateway/morph-router.mjs';

const HOST = 'localhost';
const SECRET = ['sk', 'morph', 'router', 'acceptance', 'do', 'not', 'leak'].join('-');
const PROMPT = 'Add error handling to this function';

function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  });
  response.end(body);
}

function answer(label, confidence = 0.9, meetsThreshold = true) {
  return { classifications: { difficulty: { label, confidence, meets_threshold: meetsThreshold } } };
}

async function startMock(t, handler = () => answer('easy')) {
  const state = { requests: [] };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = undefined;
    }
    state.requests.push({ url: request.url, method: request.method, headers: request.headers, body });
    const outcome = await handler({ body, state, response, request });
    if (outcome === false) return;
    sendJson(response, outcome ?? answer('easy'));
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return { state, port: server.address().port };
}

function routerFor(port, options = {}) {
  return createMorphRouter({
    baseUrl: 'http://' + HOST + ':' + port + '/v1',
    apiKey: SECRET,
    env: {},
    timeoutMs: 3000,
    ...options,
  });
}

function countingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

function fakeResponse(body, { status = 200, headers = {} } = {}) {
  async function* stream() {
    yield Buffer.from(body, 'utf8');
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: stream(),
  };
}

test('the public surface, tier mapping and describe output are exact and immutable', () => {
  assert.equal(MORPH_ROUTER_VERSION, 1);
  assert.equal(ROUTER_CLASSIFY_PATH, '/router/classify');
  assert.equal(MORPH_ROUTER_BASE_URL, 'https://api.morphllm.com/v1');
  assert.equal(MORPH_ROUTER_API_KEY_ENV, 'MORPH_API_KEY');
  assert.deepEqual([...ROUTER_CLASSES], ['difficulty']);
  assert.deepEqual([...ROUTER_TIERS], ['cheap', 'standard', 'powerful']);
  assert.deepEqual([...DIFFICULTIES], ['easy', 'medium', 'hard']);
  assert.deepEqual({ ...TIER_BY_DIFFICULTY }, { easy: 'cheap', medium: 'standard', hard: 'powerful' });
  assert.equal(Object.isFrozen(TIER_BY_DIFFICULTY), true);

  const router = createMorphRouter({ apiKey: SECRET, env: {} });
  assert.deepEqual(router.describe(), {
    version: MORPH_ROUTER_VERSION,
    path: ROUTER_CLASSIFY_PATH,
    classes: ['difficulty'],
    tiers: ['cheap', 'standard', 'powerful'],
    tierByDifficulty: { easy: 'cheap', medium: 'standard', hard: 'powerful' },
    defaultTier: 'standard',
    maxInputChars: MAX_ROUTER_INPUT_CHARS,
    timeoutMs: DEFAULT_ROUTER_TIMEOUT_MS,
    maxResponseBytes: MAX_ROUTER_RESPONSE_BYTES,
  });
  assert.equal(Object.isFrozen(router.describe()), true);
  assert.equal(Object.isFrozen(router.describe().tiers), true);
  assert.equal(Object.isFrozen(router.describe().tierByDifficulty), true);
  assert.equal(Object.isFrozen(router), true);
  assert.equal(Object.keys(router).sort().join(','), 'classify,describe');
  assert.equal(JSON.stringify(router.describe()).includes(SECRET), false);
  assert.equal(JSON.stringify(router.describe()).includes('apiKey'), false);
  assert.throws(() => { router.describe = null; }, TypeError);
});

test('classify sends exactly one documented classify request and maps easy to cheap', async (t) => {
  const mock = await startMock(t, () => answer('easy', 0.93));
  const router = routerFor(mock.port);

  const result = await router.classify(PROMPT);
  assert.equal(mock.state.requests.length, 1);
  const request = mock.state.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/router/classify');
  assert.deepEqual(request.body, { input: PROMPT, classes: ['difficulty'] });
  assert.equal(request.headers.authorization, 'Bearer ' + SECRET);
  assert.match(String(request.headers['content-type']), /^application\/json/);
  assert.deepEqual(result, {
    tier: 'cheap',
    difficulty: 'easy',
    confidence: 0.93,
    meetsThreshold: true,
    needsInfo: false,
    fallback: false,
    code: null,
    status: null,
  });
  assert.equal(Object.isFrozen(result), true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(PROMPT), false);
});

test('medium maps to standard and hard maps to powerful', async (t) => {
  let label = 'medium';
  const mock = await startMock(t, () => answer(label, 0.8));
  const router = routerFor(mock.port);
  assert.equal((await router.classify(PROMPT)).tier, 'standard');
  label = 'hard';
  assert.equal((await router.classify(PROMPT)).tier, 'powerful');
  assert.equal(mock.state.requests.length, 2);
});

test('a below-threshold answer and a needs_info label use the configured default tier', async (t) => {
  let label = 'hard';
  let threshold = false;
  const mock = await startMock(t, () => answer(label, 0.4, threshold));
  const router = routerFor(mock.port, { defaultTier: 'powerful' });

  const low = await router.classify(PROMPT);
  assert.deepEqual(low, {
    tier: 'powerful',
    difficulty: 'hard',
    confidence: 0.4,
    meetsThreshold: false,
    needsInfo: true,
    fallback: false,
    code: null,
    status: null,
  });

  label = 'needs_info';
  threshold = true;
  const needsInfo = await router.classify(PROMPT);
  assert.equal(needsInfo.tier, 'powerful');
  assert.equal(needsInfo.difficulty, 'needs_info');
  assert.equal(needsInfo.needsInfo, true);
  assert.equal(needsInfo.fallback, false);
});

test('a missing meets_threshold is treated as needs_info', async (t) => {
  const mock = await startMock(t, () => ({ classifications: { difficulty: { label: 'medium', confidence: 0.7 } } }));
  const router = routerFor(mock.port);
  const result = await router.classify(PROMPT);
  assert.equal(result.tier, 'standard');
  assert.equal(result.difficulty, 'medium');
  assert.equal(result.needsInfo, true);
  assert.equal(result.fallback, false);
});

test('an unknown label, a bad confidence or a malformed answer degrades to the default tier', async (t) => {
  const answers = [
    answer('extreme'),
    answer('easy', 1.5),
    answer('easy', Number.NaN),
    { classifications: {} },
    { classifications: { difficulty: 'easy' } },
    { nope: true },
    [],
    'easy',
  ];
  let index = 0;
  const mock = await startMock(t, () => answers[index]);
  const router = routerFor(mock.port);
  for (index = 0; index < answers.length; index += 1) {
    const result = await router.classify(PROMPT);
    assert.equal(result.tier, 'standard');
    assert.equal(result.fallback, true);
    assert.equal(result.code, 'invalid-response');
    assert.equal(result.difficulty, null);
    assert.equal(result.confidence, null);
    assert.equal(result.needsInfo, true);
  }
});

test('a hostile response object fails closed with a bounded code', async () => {
  const hostile = createMorphRouter({
    baseUrl: 'http://' + HOST + ':1/v1',
    apiKey: SECRET,
    env: {},
    fetch: async () => ({
      get ok() {
        throw new Error('hostile getter');
      },
    }),
  });
  const result = await hostile.classify(PROMPT);
  assert.equal(result.fallback, true);
  assert.equal(result.code, 'invalid-response');
  assert.equal(JSON.stringify(result).includes('hostile getter'), false);

  const headersHostile = createMorphRouter({
    baseUrl: 'http://' + HOST + ':1/v1',
    apiKey: SECRET,
    env: {},
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: {
        get() {
          throw new Error('hostile headers');
        },
      },
      body: null,
    }),
  });
  const second = await headersHostile.classify(PROMPT);
  assert.equal(second.fallback, true);
  assert.equal(second.code, 'invalid-response');

  const aborted = createMorphRouter({
    baseUrl: 'http://' + HOST + ':1/v1',
    apiKey: SECRET,
    env: {},
    fetch: async () => {
      throw Object.assign(new Error('boom'), { name: 'AbortError' });
    },
  });
  const third = await aborted.classify(PROMPT);
  assert.equal(third.fallback, true);
  assert.equal(third.code, 'network-error');
});

test('HTTP failures and a non-JSON body degrade to a bounded fallback', async (t) => {
  const cases = [
    { status: 500, code: 'http-status' },
    { status: 429, code: 'http-status' },
    { status: 408, code: 'http-status' },
    { status: 401, code: 'http-status' },
    { status: 400, code: 'http-status' },
  ];
  for (const item of cases) {
    const mock = await startMock(t, ({ response }) => {
      sendJson(response, { error: 'provider body that must not leak' }, item.status);
      return false;
    });
    const router = routerFor(mock.port);
    const result = await router.classify(PROMPT);
    assert.equal(result.tier, 'standard');
    assert.equal(result.fallback, true);
    assert.equal(result.code, item.code);
    assert.equal(result.status, item.status);
    assert.equal(JSON.stringify(result).includes('must not leak'), false);
  }

  const badJson = await startMock(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '7' });
    response.end('not-json');
    return false;
  });
  const result = await routerFor(badJson.port).classify(PROMPT);
  assert.equal(result.fallback, true);
  assert.equal(result.code, 'invalid-response');
  assert.equal(JSON.stringify(result).includes('not-json'), false);
});

test('a timeout degrades to a bounded fallback and never throws', async (t) => {
  const mock = await startMock(t, () => false);
  const router = routerFor(mock.port, { timeoutMs: 150 });
  const started = Date.now();
  const result = await router.classify(PROMPT);
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.tier, 'standard');
  assert.equal(result.fallback, true);
  assert.equal(result.code, 'timeout');
  assert.equal(result.status, null);
});

test('a network error degrades to a bounded fallback', async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const router = createMorphRouter({ baseUrl: 'http://' + HOST + ':' + port + '/v1', apiKey: SECRET, env: {}, timeoutMs: 1000 });
  const result = await router.classify(PROMPT);
  assert.equal(result.fallback, true);
  assert.equal(result.code, 'network-error');
});

test('a declared or streamed body above the cap degrades to response-too-large', async (t) => {
  const declared = await startMock(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(4096) });
    response.end('{}');
    return false;
  });
  const declaredResult = await routerFor(declared.port, { maxResponseBytes: 1024 }).classify(PROMPT);
  assert.equal(declaredResult.fallback, true);
  assert.equal(declaredResult.code, 'response-too-large');

  const streamed = await startMock(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('x'.repeat(2048));
    response.end();
    return false;
  });
  const streamedResult = await routerFor(streamed.port, { maxResponseBytes: 1024 }).classify(PROMPT);
  assert.equal(streamedResult.fallback, true);
  assert.equal(streamedResult.code, 'response-too-large');
});

test('caller cancellation rejects as aborted instead of falling back', async (t) => {
  const mock = await startMock(t, () => false);
  const router = routerFor(mock.port, { timeoutMs: 5000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(router.classify(PROMPT, { signal: controller.signal }), (error) => {
    assert.equal(error instanceof MorphRouterError, true);
    assert.equal(error.code, 'aborted');
    return true;
  });

  const already = new AbortController();
  already.abort();
  await assert.rejects(router.classify(PROMPT, { signal: already.signal }), (error) => error.code === 'aborted');
});

test('the endpoint policy denies an external host before any fetch and allows it only when scoped', async () => {
  const denied = countingFetch(async () => fakeResponse(JSON.stringify(answer('easy'))));
  const router = createMorphRouter({ apiKey: SECRET, env: {}, fetch: denied.fetchImpl });
  await assert.rejects(router.classify(PROMPT), (error) => isEndpointPolicyError(error));
  assert.equal(denied.calls.length, 0);

  const allowed = countingFetch(async () => fakeResponse(JSON.stringify(answer('hard'))));
  const optedIn = createMorphRouter({
    apiKey: SECRET,
    env: {},
    policy: { allowExternalProviders: true },
    fetch: allowed.fetchImpl,
  });
  const result = await optedIn.classify(PROMPT);
  assert.equal(allowed.calls.length, 1);
  assert.equal(allowed.calls[0].url, 'https://api.morphllm.com/v1/router/classify');
  assert.equal(result.tier, 'powerful');
});

test('an explicit host allow reaches an external base URL without the external-provider switch', async () => {
  const counted = countingFetch(async () => fakeResponse(JSON.stringify(answer('medium'))));
  const router = createMorphRouter({
    apiKey: SECRET,
    env: {},
    policy: { allowHosts: ['api.morphllm.com'] },
    fetch: counted.fetchImpl,
  });
  const result = await router.classify(PROMPT);
  assert.equal(counted.calls.length, 1);
  assert.equal(result.tier, 'standard');
});

test('the API key comes from the configured environment variable when no explicit key is given', async (t) => {
  const mock = await startMock(t);
  const router = createMorphRouter({
    baseUrl: 'http://' + HOST + ':' + mock.port + '/v1',
    env: { MORPH_API_KEY: SECRET },
  });
  await router.classify(PROMPT);
  assert.equal(mock.state.requests[0].headers.authorization, 'Bearer ' + SECRET);
  assert.throws(
    () => createMorphRouter({ baseUrl: 'http://' + HOST + ':' + mock.port + '/v1', env: {} }),
    (error) => error.code === 'missing-api-key',
  );
});

test('invalid options fail closed without invoking accessors or echoing values', () => {
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'apiKey', {
    enumerable: true,
    get() {
      throw new Error('getter must not run');
    },
  });
  assert.throws(() => createMorphRouter(accessorOptions), (error) => error.code === 'invalid-options' || error.code === 'invalid-accessor');

  const revoked = Proxy.revocable({ apiKey: SECRET, env: {} }, {});
  revoked.revoke();
  assert.throws(() => createMorphRouter(revoked.proxy), (error) => error.code === 'invalid-options');

  const tierAccessor = { easy: 'cheap', medium: 'standard', hard: 'powerful' };
  Object.defineProperty(tierAccessor, 'hard', {
    enumerable: true,
    get() {
      throw new Error('tier getter must not run');
    },
  });
  assert.throws(
    () => createMorphRouter({ apiKey: SECRET, env: {}, tierByDifficulty: tierAccessor }),
    (error) => error.code === 'invalid-options',
  );

  for (const options of [
    { apiKey: SECRET, env: {}, unknown: true },
    { apiKey: SECRET, env: {}, __proto__: null, constructor: 1 },
    { apiKey: SECRET, env: {}, defaultTier: 'best' },
    { apiKey: SECRET, env: {}, tierByDifficulty: { easy: 'cheap', medium: 'standard' } },
    { apiKey: SECRET, env: {}, tierByDifficulty: { easy: 'cheap', medium: 'standard', hard: 'powerful', other: 'cheap' } },
    { apiKey: SECRET, env: {}, tierByDifficulty: { easy: 'cheap', medium: 'cheap', hard: 'powerful' } },
    { apiKey: SECRET, env: {}, timeoutMs: 0 },
    { apiKey: SECRET, env: {}, timeoutMs: 120000 },
    { apiKey: SECRET, env: {}, timeoutMs: '1000' },
    { apiKey: SECRET, env: {}, maxResponseBytes: 10 },
    { apiKey: SECRET, env: {}, maxResponseBytes: 8 * 1024 * 1024 },
    { apiKey: SECRET, env: {}, baseUrl: 'https://api.morphllm.com/v1?x=1' },
    { apiKey: SECRET, env: {}, baseUrl: 'https://api.morphllm.com/v1#frag' },
    { apiKey: SECRET, env: {}, baseUrl: 'https://user:pass@api.morphllm.com/v1' },
    { apiKey: SECRET, env: {}, baseUrl: 'http://example.com/v1' },
    { apiKey: SECRET, env: {}, baseUrl: 'ftp://api.morphllm.com/v1' },
    { apiKey: SECRET, env: {}, apiKeyEnv: 'not a name' },
    { apiKey: 42, env: {} },
    { apiKey: ['sk', 'split'].join(''), env: {}, fetch: 'nope' },
    { apiKey: SECRET, env: null },
  ]) {
    assert.throws(() => createMorphRouter(options), (error) => {
      assert.equal(error instanceof MorphRouterError, true);
      assert.equal(JSON.stringify(Object.fromEntries(Object.entries(error))).includes(SECRET), false);
      return true;
    }, JSON.stringify(Object.keys(options)));
  }

  assert.throws(() => createMorphRouter({ apiKey: 'bad\u0000key', env: {} }), (error) => error.code === 'invalid-api-key');
  assert.throws(() => createMorphRouter({ apiKey: ' ' + SECRET, env: {} }), (error) => error.code === 'invalid-api-key');
  assert.throws(() => createMorphRouter({ env: {} }), (error) => error.code === 'missing-api-key');
});

test('an accessor-backed policy fails closed before any read', () => {
  const policy = {};
  Object.defineProperty(policy, 'allowExternalProviders', {
    enumerable: true,
    get() {
      throw new Error('policy getter must not run');
    },
  });
  assert.throws(
    () => createMorphRouter({ apiKey: SECRET, env: {}, policy }),
    (error) => error.code === 'invalid-options',
  );

  const throwing = new Proxy({ allowExternalProviders: true }, {
    ownKeys() {
      throw new Error('policy keys must not be enumerated');
    },
  });
  assert.throws(
    () => createMorphRouter({ apiKey: SECRET, env: {}, policy: throwing }),
    (error) => error.code === 'invalid-options',
  );
});

test('invalid prompts fail closed without making a request', async () => {
  const { calls, fetchImpl } = countingFetch(async () => fakeResponse(JSON.stringify(answer('easy'))));
  const router = createMorphRouter({ apiKey: SECRET, env: {}, fetch: fetchImpl });
  const bad = ['', '   ', 42, null, undefined, 'x'.repeat(MAX_ROUTER_INPUT_CHARS + 1), 'bad\u0000prompt', 'lone\ud800surrogate'];
  for (const prompt of bad) {
    await assert.rejects(router.classify(prompt), (error) => {
      assert.equal(error instanceof MorphRouterError, true);
      assert.equal(error.code, 'invalid-input');
      return true;
    });
  }
  await assert.rejects(router.classify(PROMPT, { unknown: true }), (error) => error.code === 'invalid-options');
  await assert.rejects(router.classify(PROMPT, { signal: {} }), (error) => error.code === 'invalid-options');
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(bad.join('')).includes(SECRET), false);
});

test('a prompt at the cap is accepted and is sent only once', async (t) => {
  const mock = await startMock(t);
  const router = routerFor(mock.port);
  const prompt = 'a'.repeat(MAX_ROUTER_INPUT_CHARS);
  const result = await router.classify(prompt);
  assert.equal(result.fallback, false);
  assert.equal(mock.state.requests.length, 1);
  assert.equal(mock.state.requests[0].body.input.length, MAX_ROUTER_INPUT_CHARS);
});

test('two sequential calls are independent and frozen', async (t) => {
  let label = 'easy';
  const mock = await startMock(t, () => answer(label));
  const router = routerFor(mock.port);
  const first = await router.classify(PROMPT);
  label = 'hard';
  const second = await router.classify(PROMPT);
  assert.notEqual(first, second);
  assert.equal(first.tier, 'cheap');
  assert.equal(second.tier, 'powerful');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
});

test('a hostile failure status is reported as a bounded integer or null', async () => {
  const router = createMorphRouter({
    baseUrl: 'http://' + HOST + ':1/v1',
    apiKey: SECRET,
    env: {},
    fetch: async () => ({ ok: false, status: 'five hundred', headers: { get: () => null }, body: null }),
  });
  const result = await router.classify(PROMPT);
  assert.equal(result.fallback, true);
  assert.equal(result.code, 'http-status');
  assert.equal(result.status, null);
});

test('the request init pins POST, redirect error and a live abort signal', async () => {
  const { calls, fetchImpl } = countingFetch(async () => fakeResponse(JSON.stringify(answer('easy'))));
  const router = createMorphRouter({ baseUrl: 'http://' + HOST + ':1/v1', apiKey: SECRET, env: {}, fetch: fetchImpl });
  await router.classify(PROMPT);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'http://' + HOST + ':1/v1/router/classify');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers.authorization, 'Bearer ' + SECRET);
  assert.equal(typeof call.init.signal, 'object');
  assert.equal(call.init.signal.aborted, false);
  assert.deepEqual(JSON.parse(String(call.init.body)), { input: PROMPT, classes: ['difficulty'] });
});

test('a redirect response is refused instead of followed to another host', async (t) => {
  const hits = { second: 0 };
  const second = http.createServer((request, response) => {
    hits.second += 1;
    sendJson(response, answer('hard'));
  });
  await new Promise((resolve) => second.listen(0, HOST, resolve));
  t.after(() => {
    second.closeAllConnections?.();
    return new Promise((resolve) => second.close(resolve));
  });
  const target = 'http://' + HOST + ':' + second.address().port + '/v1/router/classify';

  const mock = await startMock(t, ({ response }) => {
    response.writeHead(302, { location: target, 'content-length': '0' });
    response.end();
    return false;
  });
  const result = await routerFor(mock.port).classify(PROMPT);
  assert.equal(result.fallback, true);
  assert.equal(result.code, 'network-error');
  assert.equal(mock.state.requests.length, 1);
  assert.equal(hits.second, 0);
});

test('the deadline also covers the body read, not just the connect', async (t) => {
  const mock = await startMock(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    response.write('{"classifications":');
    return false;
  });
  const router = routerFor(mock.port, { timeoutMs: 200 });
  const started = Date.now();
  const result = await router.classify(PROMPT);
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.tier, 'standard');
  assert.equal(result.fallback, true);
  assert.equal(result.code, 'timeout');
  assert.equal(result.status, null);
});

test('the API key is read once from the environment and an explicit key bypasses it', async (t) => {
  const mock = await startMock(t);
  let reads = 0;
  const env = {};
  Object.defineProperty(env, MORPH_ROUTER_API_KEY_ENV, {
    enumerable: true,
    get() {
      reads += 1;
      return SECRET;
    },
  });
  const router = createMorphRouter({ baseUrl: 'http://' + HOST + ':' + mock.port + '/v1', env });
  await router.classify(PROMPT);
  await router.classify(PROMPT);
  assert.equal(reads, 1);
  assert.equal(mock.state.requests.length, 2);
  assert.equal(mock.state.requests[0].headers.authorization, 'Bearer ' + SECRET);

  const hostile = {};
  Object.defineProperty(hostile, MORPH_ROUTER_API_KEY_ENV, {
    enumerable: true,
    get() {
      throw new Error('the environment must not be read when an explicit key is given');
    },
  });
  const explicit = createMorphRouter({ baseUrl: 'http://' + HOST + ':' + mock.port + '/v1', apiKey: SECRET, env: hostile });
  const result = await explicit.classify(PROMPT);
  assert.equal(result.fallback, false);
  assert.equal(mock.state.requests.length, 3);
});

test('a base URL with credentials is rejected without echoing it', () => {
  assert.throws(
    () => createMorphRouter({ apiKey: SECRET, env: {}, baseUrl: 'https://user:' + SECRET + '@api.morphllm.com/v1' }),
    (error) => {
      assert.equal(error.code, 'invalid-base-url');
      assert.equal(JSON.stringify(Object.fromEntries(Object.entries(error))).includes(SECRET), false);
      return true;
    },
  );
});

test('a live Proxy is validated through descriptors, never through a get trap', () => {
  const proxied = new Proxy({ apiKey: SECRET, env: {} }, {
    get() {
      throw new Error('a get trap must not run');
    },
  });
  assert.doesNotThrow(() => createMorphRouter(proxied));

  const hostileKeys = new Proxy({ apiKey: SECRET, env: {} }, {
    ownKeys() {
      throw new Error('a hostile ownKeys trap');
    },
  });
  assert.throws(() => createMorphRouter(hostileKeys), (error) => error.code === 'invalid-options');

  const hostileDescriptor = new Proxy({ apiKey: SECRET, env: {} }, {
    getOwnPropertyDescriptor() {
      throw new Error('a hostile descriptor trap');
    },
  });
  assert.throws(() => createMorphRouter(hostileDescriptor), (error) => error.code === 'invalid-options');
});

test('allowExternalProviders cannot widen the policy to a hard-denied host', () => {
  const counted = countingFetch(async () => fakeResponse(JSON.stringify(answer('easy'))));
  assert.throws(
    () => createMorphRouter({
      baseUrl: 'https://copilot-telemetry.githubusercontent.com/v1',
      apiKey: SECRET,
      env: {},
      policy: { allowExternalProviders: true },
      fetch: counted.fetchImpl,
    }),
    (error) => isEndpointPolicyError(error),
  );
  assert.equal(counted.calls.length, 0);
});

test('no result, error or describe output carries the endpoint, prompt or key', async (t) => {
  const mock = await startMock(t, ({ response }) => {
    sendJson(response, { error: 'body must not leak' }, 500);
    return false;
  });
  const router = routerFor(mock.port);
  const result = await router.classify(PROMPT);
  assert.equal(result.fallback, true);
  const serialized = JSON.stringify(result);
  for (const needle of [SECRET, PROMPT, HOST, String(mock.port), '/v1/router/classify', 'body must not leak']) {
    assert.equal(serialized.includes(needle), false, needle);
  }

  const described = JSON.stringify(router.describe());
  for (const needle of [SECRET, PROMPT, HOST, String(mock.port)]) {
    assert.equal(described.includes(needle), false, needle);
  }
  assert.equal(described.includes(ROUTER_CLASSIFY_PATH), true);

  const denied = createMorphRouter({
    apiKey: SECRET,
    env: {},
    fetch: countingFetch(async () => fakeResponse(JSON.stringify(answer('easy')))).fetchImpl,
  });
  await assert.rejects(denied.classify(PROMPT), (error) => {
    assert.equal(String(error.message).includes(SECRET), false);
    assert.equal(String(error.message).includes(PROMPT), false);
    assert.equal(String(error.stack).includes(SECRET), false);
    return true;
  });
});

test('a polluted Object.prototype cannot switch the external-provider opt-in', async () => {
  const counted = countingFetch(async () => fakeResponse(JSON.stringify(answer('easy'))));
  Object.prototype.allowExternalProviders = true;
  let router;
  try {
    router = createMorphRouter({ apiKey: SECRET, env: {}, fetch: counted.fetchImpl });
    await assert.rejects(router.classify(PROMPT), (error) => isEndpointPolicyError(error));
  } finally {
    delete Object.prototype.allowExternalProviders;
  }
  assert.equal(counted.calls.length, 0);

  const optedIn = countingFetch(async () => fakeResponse(JSON.stringify(answer('easy'))));
  const allowed = createMorphRouter({
    apiKey: SECRET,
    env: {},
    policy: { allowExternalProviders: true },
    fetch: optedIn.fetchImpl,
  });
  const result = await allowed.classify(PROMPT);
  assert.equal(result.tier, 'cheap');
  assert.equal(optedIn.calls.length, 1);
});

test('an empty key, an arbitrary key variable and null options fail closed', () => {
  const cases = [
    { apiKey: '', env: {} },
    { apiKey: SECRET, env: {}, apiKeyEnv: 'OPENAI_API_KEY' },
    { apiKey: SECRET, env: {}, policy: null },
    { apiKey: SECRET, env: {}, timeoutMs: null },
    { apiKey: SECRET, env: {}, maxResponseBytes: null },
    { apiKey: SECRET, env: {}, defaultTier: null },
    { apiKey: SECRET, env: {}, fetch: null },
  ];
  for (const options of cases) {
    assert.throws(() => createMorphRouter(options), (error) => {
      assert.equal(error instanceof MorphRouterError, true);
      return true;
    });
  }
  assert.throws(() => createMorphRouter({ apiKey: '', env: {} }), (error) => error.code === 'invalid-api-key');
  assert.throws(() => createMorphRouter({ apiKey: SECRET, env: {}, fetch: null }), (error) => error.code === 'missing-fetch');
});

test('an oversized, shadowed or invalid body chunk fails closed', async () => {
  const oversized = createMorphRouter({
    baseUrl: 'http://localhost:1/v1',
    apiKey: SECRET,
    env: {},
    maxResponseBytes: 1024,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* body() {
        yield 'x'.repeat(4096);
      })(),
    }),
  });
  const result = await oversized.classify(PROMPT);
  assert.equal(result.fallback, true);
  assert.equal(result.code, 'response-too-large');

  const invalid = createMorphRouter({
    baseUrl: 'http://localhost:1/v1',
    apiKey: SECRET,
    env: {},
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* body() {
        yield 42;
      })(),
    }),
  });
  const invalidResult = await invalid.classify(PROMPT);
  assert.equal(invalidResult.fallback, true);
  assert.equal(invalidResult.code, 'invalid-response');

  const padded = JSON.stringify({ ...answer('easy'), padding: 'x'.repeat(2048) });
  const shadowedBytes = Buffer.from(padded, 'utf8');
  Object.defineProperty(shadowedBytes, 'byteLength', { value: 0 });
  const shadowed = createMorphRouter({
    baseUrl: 'http://localhost:1/v1',
    apiKey: SECRET,
    env: {},
    maxResponseBytes: 1024,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* body() {
        yield shadowedBytes;
      })(),
    }),
  });
  const shadowedResult = await shadowed.classify(PROMPT);
  assert.equal(shadowedResult.fallback, true);
  assert.equal(shadowedResult.code, 'response-too-large');
});
