// M2 B3 task-class provider router and token budgets.
//
// A validated policy table chooses the provider, model and output cap for each B3 task class.
// Each class is executed through the B2 fallback chain, so a transient primary failure still uses
// the class fallback. Before any provider is contacted the router reserves a conservative input
// upper bound plus the full output cap against both the task and the UTC day. A request that
// cannot cover that reservation fails closed, so it cannot begin a call that is known to exceed
// the budget. A successful answer replaces the reservation with its reported usage.

import { createProviderFallback } from './provider-fallback.mjs';
import { MAX_OUTPUT_TOKENS } from './provider-client.mjs';
import {
  MAX_MODEL_CHARS,
  MODEL_NAME,
  PROVIDER_ID,
} from './provider-presets.mjs';

export { MAX_OUTPUT_TOKENS };

export const PROVIDER_ROUTER_VERSION = 1;
export const TASK_CLASSES = Object.freeze([
  'plan',
  'code-edit',
  'quick-edit',
  'review',
  'summarize',
  'embed',
]);
export const MAX_ROUTES_PER_CLASS = 8;
export const MAX_TASK_ID_CHARS = 128;
export const MAX_BUDGET_TOKENS = 1_000_000_000;
export const MAX_TRACKED_TASKS = 10_000;
export const MAX_ESTIMATE_BYTES = 64 * 1024 * 1024;

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const ROUTE_KEYS = new Set(['provider', 'model', 'maxOutputTokens']);
const OPTION_KEYS = new Set(['policy', 'providers', 'budgets', 'now']);
const BUDGET_KEYS = new Set(['perTaskTokens', 'perDayTokens']);
const CHAT_KEYS = new Set(['taskId', 'messages', 'tools', 'stream']);
const EMBEDDING_KEYS = new Set(['taskId', 'input']);

export class ProviderRouterError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ProviderRouterError';
    this.code = code;
    if (extra.scope !== undefined) this.scope = extra.scope;
    if (extra.requiredTokens !== undefined) this.requiredTokens = extra.requiredTokens;
    if (extra.remainingTokens !== undefined) this.remainingTokens = extra.remainingTokens;
  }
}

function fail(code, message, extra) {
  throw new ProviderRouterError(code, message, extra);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

function ownData(object, key, code, label) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    fail(code, label + ' cannot be read');
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) fail(code, label + ' must be a data property');
  return descriptor.value;
}

function readObject(value, label, maximumKeys) {
  if (!isPlainObject(value)) fail('invalid-policy', label + ' must be a plain object');
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-policy', label + ' cannot be enumerated');
  }
  if (keys.length > maximumKeys) fail('invalid-policy', label + ' has too many keys');
  const out = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('invalid-policy', label + ' must contain data properties only');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function validateProviderId(value, label) {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) {
    fail('invalid-policy', label + ' must be a lowercase provider id');
  }
  return value;
}

function validateModel(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MODEL_CHARS ||
      CONTROL_OR_BIDI.test(value) || !MODEL_NAME.test(value)) {
    fail('invalid-policy', 'route model is invalid');
  }
  return value;
}

function validateOutputCap(value, taskClass) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_OUTPUT_TOKENS) {
    fail('invalid-policy', 'route maxOutputTokens is invalid');
  }
  if (taskClass === 'embed' && value !== 0) {
    fail('invalid-policy', 'embedding routes must have a zero output cap');
  }
  if (taskClass !== 'embed' && value === 0) {
    fail('invalid-policy', 'chat routes need a positive output cap');
  }
  return value;
}

function validateBudget(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BUDGET_TOKENS) {
    fail('invalid-budget', 'budgets must be positive integers');
  }
  return value;
}

function readRoutes(taskClass, routes, providers) {
  if (!Array.isArray(routes) || routes.length === 0 || routes.length > MAX_ROUTES_PER_CLASS) {
    fail('invalid-policy', 'task class ' + taskClass + ' needs between 1 and ' + MAX_ROUTES_PER_CLASS + ' routes');
  }
  const seen = new Set();
  const out = [];
  for (let index = 0; index < routes.length; index += 1) {
    const route = readObject(
      ownData(routes, String(index), 'invalid-policy', 'route entry'),
      'route for ' + taskClass,
      ROUTE_KEYS.size,
    );
    for (const key of Object.keys(route)) {
      if (!ROUTE_KEYS.has(key)) fail('invalid-policy', 'unknown route field: ' + key);
    }
    const provider = validateProviderId(route.provider, 'route provider');
    if (seen.has(provider)) fail('invalid-policy', 'task class ' + taskClass + ' repeats provider ' + provider);
    seen.add(provider);
    const model = validateModel(route.model);
    const maxOutputTokens = validateOutputCap(route.maxOutputTokens, taskClass);
    const client = providers[provider];
    if (client === undefined) fail('invalid-policy', 'task class ' + taskClass + ' references an unknown provider');
    const chat = ownData(client, 'chat', 'invalid-provider', 'provider chat method');
    if (typeof chat !== 'function') fail('invalid-provider', 'provider ' + provider + ' needs a chat method');
    if (taskClass === 'embed') {
      const embeddings = ownData(client, 'embeddings', 'invalid-provider', 'provider embeddings method');
      if (typeof embeddings !== 'function') {
        fail('invalid-provider', 'provider ' + provider + ' needs an embeddings method');
      }
    }
    out.push(Object.freeze({ provider, model, maxOutputTokens, client }));
  }
  return Object.freeze(out);
}

function readProviders(value) {
  const providers = readObject(value, 'providers', MAX_ROUTES_PER_CLASS * TASK_CLASSES.length);
  const out = Object.create(null);
  for (const id of Object.keys(providers)) {
    validateProviderId(id, 'provider id');
    const client = providers[id];
    if (client === null || typeof client !== 'object') {
      fail('invalid-provider', 'provider ' + id + ' must be a client object');
    }
    out[id] = client;
  }
  return out;
}

function readPolicy(value, providers) {
  const policy = readObject(value, 'policy', TASK_CLASSES.length);
  for (const key of Object.keys(policy)) {
    if (!TASK_CLASSES.includes(key)) fail('invalid-policy', 'unknown task class: ' + key);
  }
  const out = Object.create(null);
  const chains = Object.create(null);
  for (const taskClass of TASK_CLASSES) {
    if (policy[taskClass] === undefined) fail('invalid-policy', 'policy is missing task class ' + taskClass);
    const routes = readRoutes(taskClass, policy[taskClass], providers);
    out[taskClass] = routes;
    chains[taskClass] = createProviderFallback(routes.map((route) => Object.freeze({
      id: route.provider,
      label: route.provider,
      model: route.model,
      client: route.client,
    })));
  }
  return Object.freeze({ policy: Object.freeze(out), chains: Object.freeze(chains) });
}

function readBudgets(value) {
  const budgets = readObject(value, 'budgets', BUDGET_KEYS.size);
  for (const key of Object.keys(budgets)) {
    if (!BUDGET_KEYS.has(key)) fail('invalid-budget', 'unknown budget field: ' + key);
  }
  if (budgets.perTaskTokens === undefined || budgets.perDayTokens === undefined) {
    fail('invalid-budget', 'both perTaskTokens and perDayTokens are required');
  }
  return Object.freeze({
    perTaskTokens: validateBudget(budgets.perTaskTokens),
    perDayTokens: validateBudget(budgets.perDayTokens),
  });
}

function readOptions(value) {
  if (!isPlainObject(value)) fail('invalid-options', 'router options must be a plain object');
  const options = readObject(value, 'router options', OPTION_KEYS.size);
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail('invalid-options', 'unknown router option: ' + key);
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    fail('invalid-clock', 'now must be a function');
  }
  return {
    policy: options.policy,
    providers: options.providers,
    budgets: options.budgets,
    now: options.now ?? Date.now,
  };
}

function taskIdOf(input) {
  const taskId = ownData(input, 'taskId', 'invalid-request', 'taskId');
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    fail('invalid-request', 'taskId must be a bounded identifier');
  }
  return taskId;
}

function validateInputKeys(input, keys) {
  let names;
  try {
    names = Object.keys(input);
  } catch {
    fail('invalid-request', 'request input cannot be enumerated');
  }
  for (const name of names) {
    if (!keys.has(name)) fail('invalid-request', 'unknown request field: ' + name);
  }
}

function addBytes(state, count) {
  state.bytes += count;
  if (state.bytes > MAX_ESTIMATE_BYTES) fail('invalid-request', 'request input is too large');
}

function countedString(text, state) {
  let encoded;
  try {
    encoded = JSON.stringify(text);
  } catch {
    fail('invalid-request', 'request input strings cannot be serialized');
  }
  addBytes(state, Buffer.byteLength(encoded, 'utf8') + 1);
  return text;
}

function snapshotValue(value, state, seen, depth) {
  if (depth > 32) fail('invalid-request', 'request input is nested too deeply');
  state.nodes += 1;
  if (state.nodes > 20_000) fail('invalid-request', 'request input has too many values');
  if (typeof value === 'string') return countedString(value, state);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid-request', 'request input numbers must be finite');
    addBytes(state, String(value).length + 1);
    return value;
  }
  if (typeof value === 'boolean') {
    addBytes(state, 5);
    return value;
  }
  if (value === null) {
    addBytes(state, 4);
    return value;
  }
  if (typeof value !== 'object') fail('invalid-request', 'request input must contain JSON-safe data');
  if (seen.has(value)) fail('invalid-request', 'request input must not contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 20_000) fail('invalid-request', 'request input has too many items');
    addBytes(state, 2 + Math.max(0, value.length - 1));
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const child = ownData(value, String(index), 'invalid-request', 'array item');
      out.push(snapshotValue(child, state, seen, depth + 1));
    }
    seen.delete(value);
    return Object.freeze(out);
  }
  if (!isPlainObject(value)) fail('invalid-request', 'request input must contain JSON-safe data');
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail('invalid-request', 'request input object cannot be enumerated');
  }
  if (keys.length > 20_000) fail('invalid-request', 'request input object has too many keys');
  addBytes(state, 2 + Math.max(0, keys.length - 1));
  const out = Object.create(null);
  for (const key of keys) {
    countedString(key, state);
    addBytes(state, 1);
    const child = ownData(value, key, 'invalid-request', 'object property');
    out[key] = snapshotValue(child, state, seen, depth + 1);
  }
  seen.delete(value);
  return Object.freeze(out);
}

function snapshotRequest(input, keys) {
  if (!isPlainObject(input)) fail('invalid-request', 'request input must be a plain object');
  validateInputKeys(input, keys);
  const state = { bytes: 0, nodes: 0 };
  const seen = new WeakSet();
  const out = Object.create(null);
  for (const key of Object.keys(input)) {
    const value = ownData(input, key, 'invalid-request', 'request input');
    out[key] = snapshotValue(value, state, seen, 0);
  }
  return Object.freeze(out);
}

// The snapshotted request has no accessors or functions, so its exact JSON size is stable. A token
// cannot encode less than one UTF-8 byte, so that size plus fixed message/tool allowances is a
// conservative upper bound without shipping a tokenizer.
function estimateInputTokens(input) {
  const payload = input.messages !== undefined
    ? { messages: input.messages, ...(input.tools === undefined ? {} : { tools: input.tools }) }
    : { input: input.input };
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    fail('invalid-request', 'request input cannot be serialized');
  }
  const bytes = typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : 0;
  const messages = Array.isArray(input.messages) ? input.messages.length : 0;
  const tools = Array.isArray(input.tools) ? input.tools.length : 0;
  return Math.max(1, bytes + messages * 16 + tools * 16 + 64);
}

function dayKey(stamp) {
  if (!Number.isFinite(stamp)) fail('invalid-clock', 'now must return a finite timestamp');
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime())) fail('invalid-clock', 'now must return a valid timestamp');
  return date.toISOString().slice(0, 10);
}

function usageTokens(answer) {
  const usage = answer?.usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const total = ownData(usage, 'totalTokens', 'invalid-response', 'usage totalTokens');
  return Number.isInteger(total) && total >= 0 ? total : undefined;
}

function publicTask(task) {
  return Object.freeze({
    id: task.id,
    budgetTokens: task.budgetTokens,
    usedTokens: task.used,
    reservedTokens: task.reserved,
    remainingTokens: Math.max(0, task.budgetTokens - task.used - task.reserved),
  });
}

function publicDay(day) {
  return Object.freeze({
    key: day.key,
    budgetTokens: day.budgetTokens,
    usedTokens: day.used,
    reservedTokens: day.reserved,
    remainingTokens: Math.max(0, day.budgetTokens - day.used - day.reserved),
  });
}

export function createProviderRouter(options) {
  const config = readOptions(options);
  const budgets = readBudgets(config.budgets);
  const providers = readProviders(config.providers);
  const { policy, chains } = readPolicy(config.policy, providers);
  const tasks = new Map();
  let day = { key: undefined, used: 0, reserved: 0 };

  function now() {
    let stamp;
    try {
      stamp = config.now();
    } catch {
      fail('invalid-clock', 'now failed');
    }
    const key = dayKey(stamp);
    if (day.key !== key) day = { key, used: 0, reserved: 0 };
    return { key, stamp, record: day };
  }

  function taskFor(taskId) {
    let task = tasks.get(taskId);
    if (task !== undefined) return task;
    if (tasks.size >= MAX_TRACKED_TASKS) {
      fail('too-many-tasks', 'too many task budgets are tracked');
    }
    task = { id: taskId, used: 0, reserved: 0, budgetTokens: budgets.perTaskTokens };
    tasks.set(taskId, task);
    return task;
  }

  function reserve(task, tokens) {
    const taskRemaining = task.budgetTokens - task.used - task.reserved;
    if (tokens > taskRemaining) {
      fail('budget-exhausted', 'task token budget is exhausted', {
        scope: 'task', requiredTokens: tokens, remainingTokens: Math.max(0, taskRemaining),
      });
    }
    const dayRemaining = budgets.perDayTokens - day.used - day.reserved;
    if (tokens > dayRemaining) {
      fail('budget-exhausted', 'daily token budget is exhausted', {
        scope: 'day', requiredTokens: tokens, remainingTokens: Math.max(0, dayRemaining),
      });
    }
    const record = day;
    task.reserved += tokens;
    record.reserved += tokens;
    return { tokens, day: record };
  }

  function settle(task, reservation, actual) {
    task.reserved -= reservation.tokens;
    reservation.day.reserved -= reservation.tokens;
    task.used += actual;
    // The reservation belongs to the day that was current when the call started. If the call
    // finishes after UTC midnight, the new day never held that reservation, so it is released
    // from the old day and only the actual usage is charged to the current day. A clock failure
    // here must not mask a provider result, so the reservation's day is the fallback.
    let current = reservation.day;
    try {
      current = now().record;
    } catch {
      current = reservation.day;
    }
    current.used += actual;
  }

  async function run(taskClass, input, operation) {
    const request = snapshotRequest(input, operation === 'chat' ? CHAT_KEYS : EMBEDDING_KEYS);
    const taskId = taskIdOf(request);
    if (taskClass === 'embed' && operation !== 'embeddings') {
      fail('invalid-task-class', 'the embed class accepts embeddings only');
    }
    if (taskClass !== 'embed' && operation !== 'chat') {
      fail('invalid-task-class', 'only the embed class accepts embeddings');
    }
    const routes = policy[taskClass];
    const chain = chains[taskClass];
    now();
    const task = taskFor(taskId);
    const inputTokens = estimateInputTokens(request);
    const outputTokens = operation === 'chat'
      ? Math.max(...routes.map((route) => route.maxOutputTokens))
      : 0;
    const reservation = (inputTokens + outputTokens) * routes.length;
    const held = reserve(task, reservation);

    const outgoing = Object.create(null);
    for (const key of Object.keys(request)) {
      if (key !== 'taskId') outgoing[key] = request[key];
    }
    if (operation === 'chat') {
      outgoing.model = routes[0].model;
      outgoing.maxTokens = outputTokens;
    } else {
      outgoing.model = routes[0].model;
    }

    let answer;
    try {
      answer = await chain[operation](outgoing);
    } catch (error) {
      settle(task, held, 0);
      throw error;
    }
    const actual = usageTokens(answer);
    settle(task, held, actual === undefined || actual === 0 ? reservation : actual);
    return Object.freeze({
      ...answer,
      routedBy: Object.freeze({
        taskClass,
        provider: routes[0].provider,
        model: routes[0].model,
      }),
    });
  }

  return Object.freeze({
    chat: (taskClass, input) => {
      if (!TASK_CLASSES.includes(taskClass)) fail('invalid-task-class', 'unknown task class');
      return run(taskClass, input, 'chat');
    },
    embeddings: (taskClass, input) => {
      if (!TASK_CLASSES.includes(taskClass)) fail('invalid-task-class', 'unknown task class');
      return run(taskClass, input, 'embeddings');
    },
    status: (taskId) => {
      if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) fail('invalid-request', 'taskId is invalid');
      now();
      const task = tasks.get(taskId) ?? { id: taskId, used: 0, reserved: 0, budgetTokens: budgets.perTaskTokens };
      return Object.freeze({
        task: publicTask(task),
        day: publicDay({ key: day.key, budgetTokens: budgets.perDayTokens, ...day }),
      });
    },
    describe: () => Object.freeze({
      version: PROVIDER_ROUTER_VERSION,
      taskClasses: TASK_CLASSES,
      policy: Object.freeze(Object.fromEntries(TASK_CLASSES.map((taskClass) => [
        taskClass,
        Object.freeze(policy[taskClass].map((route) => Object.freeze({
          provider: route.provider,
          model: route.model,
          maxOutputTokens: route.maxOutputTokens,
        }))),
      ]))),
      budgets,
    }),
  });
}
