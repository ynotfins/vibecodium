import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ProviderClientError, createProviderClient } from '../../src/stable/gateway/provider-client.mjs';
import {
  MAX_TRACKED_TASKS,
  ProviderRouterError,
  TASK_CLASSES,
  createProviderRouter,
} from '../../src/stable/gateway/provider-router.mjs';

const MESSAGES = [{ role: 'user', content: 'route this request' }];
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

function usage(inputTokens = 3, outputTokens = 2) {
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  });
}

function policyWith(providers = {}) {
  const policy = {};
  for (const taskClass of TASK_CLASSES) {
    const provider = providers[taskClass] ?? 'primary';
    policy[taskClass] = [{
      provider,
      model: taskClass + '-model',
      maxOutputTokens: taskClass === 'embed' ? 0 : 16,
    }];
  }
  return policy;
}

function recordingClient() {
  const calls = { chat: [], embeddings: [] };
  return {
    calls,
    client: Object.freeze({
      async chat(input) {
        calls.chat.push(input);
        return { text: 'answer from ' + input.model, toolCalls: [], usage: usage() };
      },
      async embeddings(input) {
        calls.embeddings.push(input);
        return { vectors: [Object.freeze([0.1, 0.2])], usage: usage(2, 0) };
      },
    }),
  };
}

function makeRouter(overrides = {}) {
  const primary = overrides.primary ?? recordingClient();
  const secondary = overrides.secondary ?? recordingClient();
  return {
    primary,
    secondary,
    router: createProviderRouter({
      policy: overrides.policy ?? policyWith(),
      providers: { primary: primary.client, secondary: secondary.client },
      budgets: overrides.budgets ?? { perTaskTokens: 100_000, perDayTokens: 1_000_000 },
      now: overrides.now ?? (() => NOW),
    }),
  };
}

test('the policy table chooses the provider and model for every B3 task class', async () => {
  const policy = policyWith({
    plan: 'primary',
    'code-edit': 'primary',
    'quick-edit': 'primary',
    review: 'secondary',
    summarize: 'secondary',
    embed: 'secondary',
  });
  const { router, primary, secondary } = makeRouter({ policy });
  const expected = {
    plan: primary,
    'code-edit': primary,
    'quick-edit': primary,
    review: secondary,
    summarize: secondary,
  };

  for (const taskClass of TASK_CLASSES.filter((name) => name !== 'embed')) {
    const before = expected[taskClass].calls.chat.length;
    const answer = await router.chat(taskClass, {
      taskId: 'task-' + taskClass,
      messages: [{ role: 'user', content: taskClass }],
      stream: true,
    });
    const calls = expected[taskClass].calls;
    assert.equal(calls.chat.length, before + 1, taskClass);
    assert.equal(calls.chat.at(-1).model, taskClass + '-model', taskClass);
    assert.equal(calls.chat.at(-1).maxTokens, 16, taskClass);
    assert.equal(calls.chat.at(-1).stream, true, taskClass);
    assert.deepEqual(answer.routedBy, {
      taskClass,
      provider: taskClass === 'review' || taskClass === 'summarize' ? 'secondary' : 'primary',
      model: taskClass + '-model',
    });
    assert.equal(answer.servedBy.id, answer.routedBy.provider);
  }

  const embedded = await router.embeddings('embed', { taskId: 'task-embed', input: 'embed me' });
  assert.equal(secondary.calls.embeddings.length, 1);
  assert.equal(secondary.calls.embeddings[0].model, 'embed-model');
  assert.equal(secondary.calls.embeddings[0].input, 'embed me');
  assert.equal(embedded.routedBy.taskClass, 'embed');
  assert.equal(embedded.vectors.length, 1);

  await assert.rejects(
    router.chat('embed', { taskId: 'wrong-chat', messages: MESSAGES }),
    (error) => error instanceof ProviderRouterError && error.code === 'invalid-task-class',
  );
  await assert.rejects(
    router.embeddings('plan', { taskId: 'wrong-embed', input: 'x' }),
    (error) => error instanceof ProviderRouterError && error.code === 'invalid-task-class',
  );
});

test('a transient primary failure uses the policy fallback for that task class', async () => {
  const primary = Object.freeze({
    async chat() {
      throw new ProviderClientError('http-status', 'primary unavailable', { status: 503 });
    },
  });
  const secondary = recordingClient();
  const policy = policyWith({ embed: 'secondary' });
  policy.plan = [
    { provider: 'primary', model: 'plan-primary', maxOutputTokens: 16 },
    { provider: 'secondary', model: 'plan-fallback', maxOutputTokens: 16 },
  ];
  const router = createProviderRouter({
    policy,
    providers: { primary, secondary: secondary.client },
    budgets: { perTaskTokens: 100_000, perDayTokens: 100_000 },
    now: () => NOW,
  });

  const answer = await router.chat('plan', { taskId: 'fallback', messages: MESSAGES });
  assert.equal(answer.text, 'answer from plan-fallback');
  assert.deepEqual(answer.servedBy, { id: 'secondary', label: 'secondary', fallback: true });
  assert.deepEqual(answer.routedBy, { taskClass: 'plan', provider: 'primary', model: 'plan-primary' });
  assert.deepEqual(answer.attempts.map((attempt) => attempt.outcome), ['failed', 'answered']);
  assert.equal(secondary.calls.chat[0].model, 'plan-fallback');
});

test('task and day budgets stop a request before any provider is called', async () => {
  const task = makeRouter({ budgets: { perTaskTokens: 20, perDayTokens: 1_000_000 } });
  const canary = 'PROMPT-MUST-NOT-LEAK';
  const taskError = await task.router.chat('plan', {
    taskId: 'small-task',
    messages: [{ role: 'user', content: canary }],
  }).catch((error) => error);
  assert.ok(taskError instanceof ProviderRouterError);
  assert.equal(taskError.code, 'budget-exhausted');
  assert.equal(taskError.scope, 'task');
  assert.equal(task.primary.calls.chat.length, 0);
  assert.equal(JSON.stringify(taskError).includes(canary), false);
  assert.equal(String(taskError).includes(canary), false);

  const day = makeRouter({ budgets: { perTaskTokens: 1_000_000, perDayTokens: 20 } });
  const dayError = await day.router.chat('plan', { taskId: 'small-day', messages: MESSAGES })
    .catch((error) => error);
  assert.ok(dayError instanceof ProviderRouterError);
  assert.equal(dayError.code, 'budget-exhausted');
  assert.equal(dayError.scope, 'day');
  assert.equal(day.primary.calls.chat.length, 0);
});

test('successful usage replaces the reservation and the next call is hard-stopped', async () => {
  const primary = recordingClient();
  primary.client = Object.freeze({
    async chat() {
      primary.calls.chat.push('called');
      return { text: 'large usage', toolCalls: [], usage: usage(440, 10) };
    },
    embeddings: primary.client.embeddings,
  });
  const { router } = makeRouter({
    primary,
    budgets: { perTaskTokens: 500, perDayTokens: 500 },
  });

  const first = await router.chat('plan', { taskId: 'reconcile', messages: MESSAGES });
  assert.equal(first.text, 'large usage');
  const status = router.status('reconcile');
  assert.equal(status.task.usedTokens, 450);
  assert.equal(status.task.reservedTokens, 0);
  assert.equal(status.day.usedTokens, 450);
  assert.equal(status.day.reservedTokens, 0);

  const blocked = await router.chat('plan', { taskId: 'reconcile', messages: MESSAGES })
    .catch((error) => error);
  assert.ok(blocked instanceof ProviderRouterError);
  assert.equal(blocked.code, 'budget-exhausted');
  assert.equal(primary.calls.chat.length, 1);
});

test('the B1 client sends the router output cap on both transports', async (t) => {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push({ url: request.url, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/chat/completions') {
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'chat' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }));
      return;
    }
    response.end(JSON.stringify({
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'responses' }] }],
      usage: { input_tokens: 2, output_tokens: 1 },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const chatClient = createProviderClient('openai-compatible', {
    baseUrl: 'http://127.0.0.1:' + port + '/v1',
    model: 'chat-default',
    apiKey: 'test-key',
    env: {},
  });
  const responsesClient = createProviderClient('kie', {
    baseUrl: 'http://127.0.0.1:' + port + '/codex/v1',
    model: 'responses-default',
    apiKey: 'test-key',
    env: {},
  });
  const policy = policyWith({ review: 'responses' });
  policy.plan[0].maxOutputTokens = 37;
  policy.review[0].maxOutputTokens = 37;
  const router = createProviderRouter({
    policy,
    providers: { primary: chatClient, responses: responsesClient },
    budgets: { perTaskTokens: 100_000, perDayTokens: 100_000 },
    now: () => NOW,
  });

  assert.equal((await router.chat('plan', { taskId: 'chat', messages: MESSAGES })).text, 'chat');
  assert.equal((await router.chat('review', { taskId: 'responses', messages: MESSAGES })).text, 'responses');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].body.max_tokens, 37);
  assert.equal(seen[1].url, '/codex/v1/responses');
  assert.equal(seen[1].body.max_output_tokens, 37);

  for (const maxTokens of [0, -1, 1.5, 1_000_001, '5']) {
    await assert.rejects(
      chatClient.chat({ messages: MESSAGES, maxTokens }),
      (error) => error instanceof ProviderClientError && error.code === 'invalid-options',
    );
  }
});

test('malformed policies, providers, budgets and request controls fail closed', async () => {
  const good = recordingClient();
  const base = () => ({
    policy: policyWith(),
    providers: { primary: good.client, secondary: good.client },
    budgets: { perTaskTokens: 10_000, perDayTokens: 10_000 },
    now: () => NOW,
  });
  const invalid = (mutate) => {
    const options = base();
    mutate(options);
    return options;
  };
  const cases = [
    invalid((options) => { delete options.policy.review; }),
    invalid((options) => { options.policy.extra = []; }),
    invalid((options) => { options.policy.plan = []; }),
    invalid((options) => {
      options.policy.plan = Array.from({ length: 9 }, () => ({ provider: 'primary', model: 'm', maxOutputTokens: 1 }));
    }),
    invalid((options) => { options.policy.plan = [{ provider: 'missing', model: 'm', maxOutputTokens: 1 }]; }),
    invalid((options) => { options.policy.plan[0].model = 'bad model'; }),
    invalid((options) => { options.policy.plan[0].maxOutputTokens = 0; }),
    invalid((options) => { options.policy.embed[0].maxOutputTokens = 1; }),
    invalid((options) => { options.policy.plan[0].extra = true; }),
    invalid((options) => { options.budgets.perTaskTokens = 0; }),
    invalid((options) => { options.budgets.perDayTokens = 1.5; }),
    invalid((options) => { delete options.budgets.perDayTokens; }),
    invalid((options) => { options.now = 'later'; }),
    invalid((options) => { options.providers.primary = {}; }),
  ];
  for (const options of cases) assert.throws(() => createProviderRouter(options), ProviderRouterError);

  const sparse = policyWith();
  sparse.plan = [{ provider: 'primary', model: 'm', maxOutputTokens: 1 }];
  sparse.plan.length = 3;
  assert.throws(() => createProviderRouter({ ...base(), policy: sparse }), ProviderRouterError);

  const accessorPolicy = policyWith();
  Object.defineProperty(accessorPolicy, 'review', { enumerable: true, get: () => [] });
  assert.throws(() => createProviderRouter({ ...base(), policy: accessorPolicy }), ProviderRouterError);

  const { router } = makeRouter({ primary: good, secondary: good });
  for (const taskId of ['', 'bad\nid', 'a'.repeat(129)]) {
    await assert.rejects(
      router.chat('plan', { taskId, messages: MESSAGES }),
      (error) => error instanceof ProviderRouterError,
    );
  }
  await assert.rejects(
    router.chat('plan', { taskId: 'model-override', messages: MESSAGES, model: 'other' }),
    (error) => error instanceof ProviderRouterError && error.code === 'invalid-request',
  );
  const accessorInput = { messages: MESSAGES };
  Object.defineProperty(accessorInput, 'taskId', { enumerable: true, get: () => { throw new Error('getter ran'); } });
  await assert.rejects(
    router.chat('plan', accessorInput),
    (error) => error instanceof ProviderRouterError && error.code === 'invalid-request',
  );
});

test('the day budget rolls over and task ids cannot expose a client secret', async () => {
  let current = Date.UTC(2026, 10, 24, 23, 59, 0);
  const primary = recordingClient();
  primary.client = Object.freeze({
    secret: 'CLIENT-SECRET',
    async chat() {
      primary.calls.chat.push('called');
      return { text: 'ok', toolCalls: [], usage: usage(985, 5) };
    },
    embeddings: primary.client.embeddings,
  });
  const { router } = makeRouter({
    primary,
    budgets: { perTaskTokens: 10_000, perDayTokens: 1_000 },
    now: () => current,
  });

  await router.chat('plan', { taskId: 'rollover', messages: MESSAGES });
  assert.equal(router.status('rollover').day.key, '2026-11-24');
  assert.equal(router.status('rollover').day.usedTokens, 990);
  await assert.rejects(
    router.chat('plan', { taskId: 'rollover', messages: MESSAGES }),
    (error) => error instanceof ProviderRouterError && error.code === 'budget-exhausted',
  );

  current += 2 * 60 * 1000;
  assert.equal(router.status('rollover').day.key, '2026-11-25');
  assert.equal(router.status('rollover').day.usedTokens, 0);
  await router.chat('plan', { taskId: 'rollover', messages: MESSAGES });
  assert.equal(primary.calls.chat.length, 2);
  assert.equal(router.status('rollover').day.usedTokens, 990);
  assert.equal(JSON.stringify(router.describe()).includes('CLIENT-SECRET'), false);
});

test('the task reservation includes the class output cap, not just the input bound', async () => {
  const messages = [{ role: 'user', content: 'x'.repeat(20) }];
  const serialized = JSON.stringify({ messages });
  const inputBound = Buffer.byteLength(serialized, 'utf8') + 16 + 64;
  const reservation = inputBound + 16;
  const blocked = makeRouter({
    budgets: { perTaskTokens: reservation - 1, perDayTokens: 100_000 },
  });
  const error = await blocked.router.chat('plan', { taskId: 'cap-blocked', messages })
    .catch((failure) => failure);
  assert.ok(error instanceof ProviderRouterError);
  assert.equal(error.code, 'budget-exhausted');
  assert.equal(error.scope, 'task');
  assert.equal(error.requiredTokens, reservation);
  assert.equal(error.remainingTokens, reservation - 1);
  assert.equal(blocked.primary.calls.chat.length, 0);

  const allowed = makeRouter({
    budgets: { perTaskTokens: reservation, perDayTokens: 100_000 },
  });
  const answer = await allowed.router.chat('plan', { taskId: 'cap-allowed', messages });
  assert.equal(answer.text, 'answer from plan-model');
  assert.equal(allowed.primary.calls.chat.length, 1);
});

test('fallback exhaustion releases the reservation and stays bounded and secret-free', async () => {
  const canary = 'BODY-CANARY-MUST-NOT-LEAK';
  const failing = Object.freeze({
    async chat() {
      throw new ProviderClientError('http-status', 'provider said ' + canary, { status: 503 });
    },
    async embeddings() {
      throw new ProviderClientError('http-status', 'provider said ' + canary, { status: 503 });
    },
  });
  const policy = policyWith({ embed: 'primary' });
  policy.plan = [
    { provider: 'primary', model: 'plan-primary', maxOutputTokens: 16 },
    { provider: 'secondary', model: 'plan-fallback', maxOutputTokens: 16 },
  ];
  const router = createProviderRouter({
    policy,
    providers: { primary: failing, secondary: failing },
    budgets: { perTaskTokens: 100_000, perDayTokens: 100_000 },
    now: () => NOW,
  });

  const error = await router.chat('plan', { taskId: 'exhaust', messages: MESSAGES })
    .catch((failure) => failure);
  assert.equal(error.code, 'fallback-exhausted');
  assert.equal(error.attempts.length, 2);
  for (const attempt of error.attempts) {
    assert.deepEqual(Object.keys(attempt).sort(), ['code', 'id', 'label', 'outcome', 'status']);
    assert.equal(attempt.outcome, 'failed');
    assert.equal(attempt.code, 'http-status');
    assert.equal(attempt.status, 503);
  }
  assert.equal(JSON.stringify(error.attempts).includes(canary), false);
  assert.equal(String(error).includes(canary), false);
  assert.equal(router.status('exhaust').task.reservedTokens, 0);
  assert.equal(router.status('exhaust').task.usedTokens, 0);
});

test('unknown task classes are rejected and a completed task budget cannot be reset', async () => {
  const { router, primary } = makeRouter();
  assert.throws(
    () => router.chat('nonsense', { taskId: 'unknown', messages: MESSAGES }),
    (error) => error instanceof ProviderRouterError && error.code === 'invalid-task-class',
  );
  assert.throws(
    () => router.embeddings('nonsense', { taskId: 'unknown', input: 'x' }),
    (error) => error instanceof ProviderRouterError && error.code === 'invalid-task-class',
  );
  assert.equal(primary.calls.chat.length, 0);

  await router.chat('plan', { taskId: 'to-end', messages: MESSAGES });
  assert.equal(router.status('to-end').task.usedTokens, 5);
  assert.equal(router.endTask, undefined);
  assert.equal(router.status('to-end').task.usedTokens, 5);
});

test('request and policy accessors are rejected without being invoked', async () => {
  const { router, primary } = makeRouter();
  let requestGetterRan = false;
  const messages = [{ role: 'user', content: 'x' }];
  Object.defineProperty(messages, '0', {
    enumerable: true,
    get() {
      requestGetterRan = true;
      return { role: 'user', content: 'x' };
    },
  });
  await assert.rejects(
    router.chat('plan', { taskId: 'accessor-array', messages }),
    (error) => error instanceof ProviderRouterError && error.code === 'invalid-request',
  );
  assert.equal(requestGetterRan, false);
  assert.equal(primary.calls.chat.length, 0);

  let policyGetterRan = false;
  const policy = policyWith();
  Object.defineProperty(policy.plan, '0', {
    enumerable: true,
    get() {
      policyGetterRan = true;
      return { provider: 'primary', model: 'm', maxOutputTokens: 1 };
    },
  });
  assert.throws(
    () => createProviderRouter({
      policy,
      providers: { primary: primary.client, secondary: primary.client },
      budgets: { perTaskTokens: 10_000, perDayTokens: 10_000 },
      now: () => NOW,
    }),
    ProviderRouterError,
  );
  assert.equal(policyGetterRan, false);
});

test('numeric and enum tool schemas reserve at least their serialized bytes', async () => {
  const numbers = Array.from({ length: 40 }, (_, index) => 100_000_000 + index);
  const tools = [{
    type: 'function',
    function: {
      name: 'measure',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', enum: numbers },
          mode: { type: 'string', enum: ['fast', 'careful', 'review'] },
        },
      },
    },
  }];
  const serialized = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  assert.ok(serialized > 200);
  const { router, primary } = makeRouter({ budgets: { perTaskTokens: 100, perDayTokens: 100_000 } });
  const error = await router.chat('plan', {
    taskId: 'json-tools',
    messages: [{ role: 'user', content: 'x' }],
    tools,
  }).catch((failure) => failure);
  assert.equal(error.code, 'budget-exhausted');
  assert.ok(error.requiredTokens >= serialized);
  assert.equal(primary.calls.chat.length, 0);
});

test('a completed task budget cannot be reset by the caller', async () => {
  const primary = recordingClient();
  primary.client = Object.freeze({
    async chat() {
      primary.calls.chat.push('called');
      return { text: 'done', toolCalls: [], usage: usage(440, 10) };
    },
    embeddings: primary.client.embeddings,
  });
  const { router } = makeRouter({
    primary,
    budgets: { perTaskTokens: 450, perDayTokens: 100_000 },
  });

  await router.chat('plan', { taskId: 'finished', messages: MESSAGES });
  assert.equal(router.status('finished').task.usedTokens, 450);
  assert.equal(router.endTask, undefined);
  const error = await router.chat('plan', { taskId: 'finished', messages: MESSAGES })
    .catch((failure) => failure);
  assert.equal(error.code, 'budget-exhausted');
  assert.equal(error.scope, 'task');
  assert.equal(router.status('finished').task.usedTokens, 450);
  assert.equal(primary.calls.chat.length, 1);
});

test('the task map fails closed at its cap instead of evicting a completed task', async () => {
  const { router, primary } = makeRouter({
    budgets: { perTaskTokens: 10_000, perDayTokens: 1_000_000_000 },
  });
  for (let index = 0; index < MAX_TRACKED_TASKS; index += 1) {
    await router.chat('plan', { taskId: 'capped-' + index, messages: MESSAGES });
  }
  const error = await router.chat('plan', { taskId: 'overflow', messages: MESSAGES })
    .catch((failure) => failure);
  assert.equal(error.code, 'too-many-tasks');
  assert.equal(primary.calls.chat.length, MAX_TRACKED_TASKS);
  assert.equal(router.status('capped-0').task.usedTokens, 5);
});

test('the input reservation counts tool schemas, not a fixed per-tool allowance', async () => {
  const description = 'd'.repeat(4000);
  const tools = [{
    type: 'function',
    function: {
      name: 'do_thing',
      description,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  }];
  const { router } = makeRouter({ budgets: { perTaskTokens: 100, perDayTokens: 100_000 } });
  const error = await router.chat('plan', {
    taskId: 'tool-bound',
    messages: [{ role: 'user', content: 'x' }],
    tools,
  }).catch((failure) => failure);
  assert.equal(error.code, 'budget-exhausted');
  assert.ok(
    error.requiredTokens >= description.length,
    'reserved ' + error.requiredTokens + ' tokens for a ' + description.length + '-character tool schema',
  );
});

test('an in-flight reservation does not leak across the UTC day boundary', async () => {
  let current = Date.UTC(2026, 10, 24, 23, 59, 0);
  let notify;
  const called = new Promise((resolve) => { notify = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = Object.freeze({
    async chat() {
      notify();
      await gate;
      return { text: 'crossed midnight', toolCalls: [], usage: usage(45, 5) };
    },
    async embeddings() {
      return { vectors: [Object.freeze([0.1])], usage: usage(2, 0) };
    },
  });
  const policy = policyWith({ plan: 'primary', embed: 'primary' });
  const router = createProviderRouter({
    policy,
    providers: { primary: client },
    budgets: { perTaskTokens: 100_000, perDayTokens: 1_000 },
    now: () => current,
  });

  const pending = router.chat('plan', { taskId: 'midnight', messages: [{ role: 'user', content: 'x'.repeat(20) }] });
  await called;
  current += 2 * 60 * 1000;
  assert.equal(router.status('observer').day.key, '2026-11-25');
  release();
  await pending;

  const day = router.status('midnight').day;
  assert.equal(day.usedTokens, 50);
  assert.equal(day.reservedTokens, 0);
  assert.ok(day.remainingTokens <= 1_000);
});
