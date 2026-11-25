import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createProviderClient } from '../../src/stable/gateway/provider-client.mjs';
import { TASK_CLASSES, createProviderRouter } from '../../src/stable/gateway/provider-router.mjs';
import {
  MORPH_DIRECT_PROVIDER_ORDER,
  MORPH_DIRECT_VERSION,
  MorphDirectError,
  createMorphDirectPolicy,
} from '../../src/stable/gateway/morph-direct.mjs';

const HOST = '127.0.0.1';
const SECRET_PREFIX = ['sk', ''].join('-');
const MORPH_SECRET = ['sk', 'morph', 'acceptance', 'do', 'not', 'leak'].join('-');
const OMNI_SECRET = ['sk', 'omniroute', 'acceptance', 'do', 'not', 'leak'].join('-');
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const MESSAGES = Object.freeze([{ role: 'user', content: 'route this request' }]);

function modelsFor(prefix) {
  return Object.fromEntries(TASK_CLASSES.map((taskClass) => [taskClass, prefix + '-' + taskClass]));
}

function capsFor() {
  return {
    plan: 32,
    'code-edit': 64,
    'quick-edit': 16,
    review: 48,
    summarize: 24,
    embed: 0,
  };
}

function validOptions() {
  return {
    omnirouteModels: modelsFor('omni'),
    morphModels: modelsFor('morph-direct'),
    outputCaps: capsFor(),
  };
}

function invalid(options, label) {
  return assert.rejects(
    async () => createMorphDirectPolicy(options),
    (error) => error instanceof MorphDirectError && /^invalid-/.test(error.code),
    label,
  );
}

function urlFor(port, path) {
  return 'http://' + HOST + ':' + port + path;
}

function sendJson(response, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function startMorphMock(t) {
  const state = { chats: [], embeddings: [] };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/v1/chat/completions') {
      state.chats.push(body);
      sendJson(response, {
        choices: [{ message: { role: 'assistant', content: 'morph answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
      return;
    }
    if (request.url === '/v1/embeddings') {
      state.embeddings.push(body);
      sendJson(response, {
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        usage: { prompt_tokens: 1 },
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, port: server.address().port };
}

async function closedLoopbackPort(t) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function assertNoClientOrSecret(value, path = 'value') {
  if (typeof value === 'function') assert.fail(path + ' exposes a function');
  if (typeof value === 'string') {
    assert.equal(value.includes(SECRET_PREFIX), false, path + ' contains a credential-shaped value');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const forbidden of ['config', 'chat', 'embeddings', 'describe', 'apiKey', 'authorization', 'baseUrl', 'endpoint', 'secret', 'token', 'password']) {
    assert.equal(Object.prototype.hasOwnProperty.call(value, forbidden), false, path + ' exposes ' + forbidden);
  }
  for (const key of Object.keys(value)) assertNoClientOrSecret(value[key], path + '.' + key);
}

test('the helper builds the complete six-class policy with morph as the deterministic second route', () => {
  const policy = createMorphDirectPolicy(validOptions());
  const caps = capsFor();
  assert.equal(MORPH_DIRECT_VERSION, 1);
  assert.deepEqual([...MORPH_DIRECT_PROVIDER_ORDER], ['omniroute', 'morph']);
  assert.deepEqual(Object.keys(policy), [...TASK_CLASSES]);
  assert.equal(Object.isFrozen(policy), true);

  for (const taskClass of TASK_CLASSES) {
    const routes = policy[taskClass];
    assert.equal(Object.isFrozen(routes), true, taskClass);
    assert.deepEqual(routes.map((route) => route.provider), ['omniroute', 'morph'], taskClass);
    assert.deepEqual(routes.map((route) => route.model), ['omni-' + taskClass, 'morph-direct-' + taskClass], taskClass);
    assert.deepEqual(routes.map((route) => route.maxOutputTokens), [caps[taskClass], caps[taskClass]], taskClass);
    for (const route of routes) {
      assert.equal(Object.isFrozen(route), true, taskClass);
      assert.deepEqual(Object.keys(route), ['provider', 'model', 'maxOutputTokens'], taskClass);
    }
  }
  assertNoClientOrSecret(policy, 'policy');
});

test('a stopped omniroute endpoint completes chat and embeddings on morph in the same call', async (t) => {
  const mock = await startMorphMock(t);
  const stoppedPort = await closedLoopbackPort(t);
  const omniroute = createProviderClient('omniroute', {
    baseUrl: urlFor(stoppedPort, '/v1'),
    model: 'omni-default',
    apiKey: OMNI_SECRET,
    env: {},
    timeoutMs: 2000,
  });
  const morph = createProviderClient('morph', {
    baseUrl: urlFor(mock.port, '/v1'),
    model: 'morph-default',
    apiKey: MORPH_SECRET,
    env: {},
    timeoutMs: 2000,
  });
  const router = createProviderRouter({
    policy: createMorphDirectPolicy(validOptions()),
    providers: { omniroute, morph },
    budgets: { perTaskTokens: 1_000_000, perDayTokens: 10_000_000 },
    now: () => NOW,
  });

  const chat = await router.chat('plan', { taskId: 'acceptance-chat', messages: MESSAGES });
  assert.equal(chat.text, 'morph answer');
  assert.deepEqual(chat.servedBy, { id: 'morph', label: 'morph', fallback: true });
  assert.deepEqual(chat.routedBy, { taskClass: 'plan', provider: 'omniroute', model: 'omni-plan' });
  assert.equal(chat.attempts.length, 2);
  assert.deepEqual(chat.attempts[0], {
    id: 'omniroute',
    label: 'omniroute',
    outcome: 'failed',
    code: 'network-error',
  });
  assert.deepEqual(chat.attempts[1], { id: 'morph', label: 'morph', outcome: 'answered' });
  assert.equal(mock.state.chats.length, 1);
  assert.equal(mock.state.chats[0].model, 'morph-direct-plan');
  assert.equal(mock.state.chats[0].max_tokens, 32);

  const embeddings = await router.embeddings('embed', { taskId: 'acceptance-embed', input: 'embed me' });
  assert.deepEqual(embeddings.vectors, [[0.1, 0.2, 0.3]]);
  assert.deepEqual(embeddings.servedBy, { id: 'morph', label: 'morph', fallback: true });
  assert.deepEqual(embeddings.routedBy, { taskClass: 'embed', provider: 'omniroute', model: 'omni-embed' });
  assert.equal(embeddings.attempts[0].code, 'network-error');
  assert.equal(mock.state.embeddings.length, 1);
  assert.equal(mock.state.embeddings[0].model, 'morph-direct-embed');
  assert.deepEqual(mock.state.embeddings[0].input, ['embed me']);

  const serialized = JSON.stringify({ chat, embeddings });
  for (const secret of [MORPH_SECRET, OMNI_SECRET]) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(String(stoppedPort)), false);
  assert.equal(serialized.includes('provider request failed'), false);
  for (const attempt of [...chat.attempts, ...embeddings.attempts]) {
    for (const key of Object.keys(attempt)) {
      assert.equal(['id', 'label', 'outcome', 'code', 'status'].includes(key), true, key);
    }
  }
  assertNoClientOrSecret(chat, 'chat');
  assertNoClientOrSecret(embeddings, 'embeddings');
});

test('malformed options and maps fail closed without invoking accessors or echoing values', async () => {
  await invalid(undefined, 'missing options');
  await invalid(null, 'null options');
  await invalid([], 'array options');
  await invalid({ ...validOptions(), extra: true }, 'unknown option');
  const sentinelOption = SECRET_PREFIX + 'option';
  await assert.rejects(
    async () => createMorphDirectPolicy({ ...validOptions(), [sentinelOption]: true }),
    (error) => {
      assert.equal(error instanceof MorphDirectError, true);
      assert.equal(error.code, 'invalid-options');
      assert.equal(error.message.includes(SECRET_PREFIX), false);
      return true;
    },
  );
  await invalid({ ...validOptions(), providers: { omniroute: {} } }, 'client injection');

  const missing = validOptions();
  delete missing.morphModels;
  await invalid(missing, 'missing map');

  const missingClass = validOptions();
  delete missingClass.omnirouteModels.review;
  await invalid(missingClass, 'missing class');

  const extraClass = validOptions();
  extraClass.morphModels.extra = 'extra-model';
  await invalid(extraClass, 'extra class');

  for (const [label, mutate] of [
    ['chat cap zero', (options) => { options.outputCaps.plan = 0; }],
    ['embed cap nonzero', (options) => { options.outputCaps.embed = 8; }],
    ['fractional cap', (options) => { options.outputCaps.review = 1.5; }],
    ['negative cap', (options) => { options.outputCaps.summarize = -1; }],
    ['cap too large', (options) => { options.outputCaps['code-edit'] = 1_000_001; }],
    ['cap string', (options) => { options.outputCaps['quick-edit'] = '16'; }],
    ['empty model', (options) => { options.omnirouteModels.plan = ''; }],
    ['model with space', (options) => { options.morphModels.review = 'bad model'; }],
    ['model with control', (options) => { options.morphModels.embed = SECRET_PREFIX + '-value\u0000'; }],
    ['model too long', (options) => { options.omnirouteModels.embed = 'm'.repeat(201); }],
    ['non-string model', (options) => { options.omnirouteModels['code-edit'] = 7; }],
  ]) {
    const options = validOptions();
    mutate(options);
    await invalid(options, label);
  }

  const reserved = JSON.parse('{"plan":"proto-model","code-edit":"a","quick-edit":"b","review":"c","summarize":"d","embed":"e","__proto__":"x"}');
  await invalid({ ...validOptions(), omnirouteModels: reserved }, 'reserved key');

  let invoked = false;
  const accessorRoot = {
    get omnirouteModels() {
      invoked = true;
      throw new Error('must not run');
    },
    morphModels: modelsFor('morph-direct'),
    outputCaps: capsFor(),
  };
  await invalid(accessorRoot, 'accessor root');
  assert.equal(invoked, false);

  const accessorMap = modelsFor('omni');
  Object.defineProperty(accessorMap, 'review', {
    enumerable: true,
    configurable: true,
    get() {
      invoked = true;
      throw new Error('must not run');
    },
  });
  await invalid({ ...validOptions(), omnirouteModels: accessorMap }, 'accessor class');
  assert.equal(invoked, false);

  let trapCalls = 0;
  const duplicateKeyMap = new Proxy(modelsFor('omni'), {
    ownKeys(target) {
      trapCalls += 1;
      return [...Reflect.ownKeys(target), 'plan'];
    },
  });
  await invalid({ ...validOptions(), omnirouteModels: duplicateKeyMap }, 'duplicate keys');
  assert.equal(trapCalls, 1);

  class CustomMap {
    constructor() {
      Object.assign(this, modelsFor('omni'));
    }
  }
  await invalid({ ...validOptions(), omnirouteModels: new CustomMap() }, 'class-backed map');
});

test('a malformed model error never echoes the supplied model value', async () => {
  const options = validOptions();
  options.morphModels.plan = SECRET_PREFIX + '-value\u0000';
  await assert.rejects(
    async () => createMorphDirectPolicy(options),
    (error) => {
      assert.equal(error instanceof MorphDirectError, true);
      assert.equal(error.message.includes(SECRET_PREFIX), false);
      return true;
    },
  );
});
