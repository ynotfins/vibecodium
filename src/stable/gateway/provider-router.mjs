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

// A Router difficulty maps to one of these tiers (`morph-router.mjs` exports the same list as
// `ROUTER_TIERS`). The list, the prompt caps and the answer bound are local so the policy layer has
// no runtime dependency on the network adapter, and the tests assert equality with the adapter's
// constants so the numbers cannot drift.
export const DIFFICULTY_TIERS = Object.freeze(['cheap', 'standard', 'powerful']);
export const MAX_CLASSIFY_PROMPT_CHARS = 32 * 1024;
export const MAX_CLASSIFY_PROMPT_BYTES = 128 * 1024;
export const MAX_CLASSIFY_ANSWER_BYTES = 32 * 1024;
// The classify request body is a small JSON envelope around the prompt; a token cannot encode less
// than one UTF-8 byte, so framing bytes plus prompt bytes plus the adapter's answer byte bound is a
// conservative upper bound on a billed classification without shipping a tokenizer.
export const CLASSIFY_FRAMING_TOKENS = 256;

const DIFFICULTY_LABELS = Object.freeze(['easy', 'medium', 'hard', 'needs_info']);

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const ROUTE_KEYS = new Set(['provider', 'model', 'maxOutputTokens', 'tiers']);
const OPTION_KEYS = new Set(['policy', 'providers', 'budgets', 'now', 'difficulty']);
const BUDGET_KEYS = new Set(['perTaskTokens', 'perDayTokens']);
const CHAT_KEYS = new Set(['taskId', 'messages', 'tools', 'stream', 'tier']);
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

function validateTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    fail('invalid-request', 'taskId must be a bounded identifier');
  }
  return value;
}

function isWellFormed(value) {
  if (typeof value.isWellFormed === 'function') return value.isWellFormed();
  return !LONE_SURROGATE.test(value);
}

// A route may name the difficulty tiers it serves. An untagged route serves every tier, so the
// existing policies keep their meaning and a tier hint can only reorder routes, never remove one.
function readTiers(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) fail('invalid-policy', 'route tiers must be an array');
  if (value.length === 0 || value.length > DIFFICULTY_TIERS.length) {
    fail('invalid-policy', 'route tiers must list between 1 and ' + DIFFICULTY_TIERS.length + ' known tiers');
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const tier = ownData(value, String(index), 'invalid-policy', 'route tier');
    if (!DIFFICULTY_TIERS.includes(tier)) {
      fail('invalid-policy', 'route tier is not a known difficulty tier');
    }
    if (out.includes(tier)) fail('invalid-policy', 'route tiers must not repeat a tier');
    out.push(tier);
  }
  return Object.freeze(out);
}

function readDifficulty(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-options', 'difficulty must be an adapter object with a classify method');
  }
  const classify = ownData(value, 'classify', 'invalid-options', 'difficulty adapter classify method');
  if (typeof classify !== 'function') {
    fail('invalid-options', 'difficulty adapter needs a classify method');
  }
  return Object.freeze({ classify });
}

function orderRoutes(routes, tier) {
  if (tier === null) return routes;
  const matching = routes.filter((route) => route.tiers.includes(tier));
  if (matching.length === 0) return routes;
  const neutral = routes.filter((route) => route.tiers.length === 0);
  const other = routes.filter((route) => route.tiers.length > 0 && !route.tiers.includes(tier));
  return Object.freeze([...matching, ...neutral, ...other]);
}

function readTierHint(request) {
  const tier = request.tier;
  if (tier === undefined) return null;
  if (typeof tier !== 'string' || !DIFFICULTY_TIERS.includes(tier)) {
    fail('invalid-request', 'tier must be cheap, standard or powerful');
  }
  return tier;
}

function readClassifyPrompt(value) {
  if (typeof value !== 'string') fail('invalid-request', 'classify prompt must be a string');
  if (value.length > MAX_CLASSIFY_PROMPT_CHARS) fail('invalid-request', 'classify prompt is too long');
  if (!isWellFormed(value)) fail('invalid-request', 'classify prompt is not well-formed Unicode');
  if (value.includes('\u0000')) fail('invalid-request', 'classify prompt carries a NUL character');
  if (value.trim().length === 0) fail('invalid-request', 'classify prompt is empty');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_CLASSIFY_PROMPT_BYTES) fail('invalid-request', 'classify prompt is too long');
  // The adapter JSON-escapes the prompt in the request body, so the billed bound counts the escaped
  // form: one control character costs six bytes once encoded, and the plan must not under-reserve it.
  return Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
}

function classifyReservationTokens(promptBytes) {
  return CLASSIFY_FRAMING_TOKENS + promptBytes + MAX_CLASSIFY_ANSWER_BYTES;
}

// The adapter answer is copied field by field into a frozen result, so a hostile or buggy adapter
// cannot smuggle extra data (a prompt echo, a credential) through the classification result.
function readClassifyAnswer(value) {
  if (!isPlainObject(value)) fail('invalid-response', 'the difficulty answer is invalid');
  const tier = ownData(value, 'tier', 'invalid-response', 'difficulty answer tier');
  if (!DIFFICULTY_TIERS.includes(tier)) fail('invalid-response', 'the difficulty answer tier is unknown');
  const difficulty = ownData(value, 'difficulty', 'invalid-response', 'difficulty answer difficulty');
  if (difficulty !== null && !DIFFICULTY_LABELS.includes(difficulty)) {
    fail('invalid-response', 'the difficulty answer label is unknown');
  }
  const confidence = ownData(value, 'confidence', 'invalid-response', 'difficulty answer confidence');
  if (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) ||
      confidence < 0 || confidence > 1)) {
    fail('invalid-response', 'the difficulty answer confidence is out of range');
  }
  const meetsThreshold = ownData(value, 'meetsThreshold', 'invalid-response', 'difficulty answer meetsThreshold');
  if (typeof meetsThreshold !== 'boolean') fail('invalid-response', 'the difficulty answer meetsThreshold is invalid');
  const needsInfo = ownData(value, 'needsInfo', 'invalid-response', 'difficulty answer needsInfo');
  if (typeof needsInfo !== 'boolean') fail('invalid-response', 'the difficulty answer needsInfo is invalid');
  const fallback = ownData(value, 'fallback', 'invalid-response', 'difficulty answer fallback');
  if (typeof fallback !== 'boolean') fail('invalid-response', 'the difficulty answer fallback is invalid');
  const code = ownData(value, 'code', 'invalid-response', 'difficulty answer code');
  if (code !== null && (typeof code !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(code))) {
    fail('invalid-response', 'the difficulty answer code is invalid');
  }
  const status = ownData(value, 'status', 'invalid-response', 'difficulty answer status');
  if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) {
    fail('invalid-response', 'the difficulty answer status is invalid');
  }
  return Object.freeze({ tier, difficulty, confidence, meetsThreshold, needsInfo, fallback, code, status });
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
    const tiers = readTiers(route.tiers);
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
    out.push(Object.freeze({ provider, model, maxOutputTokens, client, tiers }));
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
  const plans = Object.create(null);
  for (const taskClass of TASK_CLASSES) {
    if (policy[taskClass] === undefined) fail('invalid-policy', 'policy is missing task class ' + taskClass);
    const routes = readRoutes(taskClass, policy[taskClass], providers);
    out[taskClass] = routes;
    const orders = { default: routes };
    for (const tier of DIFFICULTY_TIERS) orders[tier] = orderRoutes(routes, tier);
    plans[taskClass] = Object.freeze(Object.fromEntries(Object.entries(orders).map(([key, list]) => [
      key,
      Object.freeze({
        routes: list,
        chain: createProviderFallback(list.map((route) => Object.freeze({
          id: route.provider,
          label: route.provider,
          model: route.model,
          client: route.client,
        }))),
      }),
    ])));
  }
  return Object.freeze({ policy: Object.freeze(out), plans: Object.freeze(plans) });
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
    difficulty: readDifficulty(options.difficulty),
    now: options.now ?? Date.now,
  };
}

function taskIdOf(input) {
  return validateTaskId(ownData(input, 'taskId', 'invalid-request', 'taskId'));
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

// The usage hint is read through own data descriptors so a hostile or accessor-backed answer cannot
// run a getter during settlement, and only a positive safe integer is trusted as a token count; a
// bad, absent or over-large value keeps the conservative reservation instead.
function usageTokens(answer) {
  let usage;
  try {
    usage = ownData(answer, 'usage', 'invalid-response', 'usage');
  } catch {
    return undefined;
  }
  if (usage === null || typeof usage !== 'object') return undefined;
  let total;
  try {
    total = ownData(usage, 'totalTokens', 'invalid-response', 'usage totalTokens');
  } catch {
    return undefined;
  }
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
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
  const { policy, plans } = readPolicy(config.policy, providers);
  const difficulty = config.difficulty;
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
    const tier = operation === 'chat' ? readTierHint(request) : null;
    now();
    const task = taskFor(taskId);
    const inputTokens = estimateInputTokens(request);
    const outputTokens = operation === 'chat'
      ? Math.max(...routes.map((route) => route.maxOutputTokens))
      : 0;
    // The tier only reorders the same policy routes, so the worst-case reservation is unchanged.
    const reservation = (inputTokens + outputTokens) * routes.length;
    const held = reserve(task, reservation);
    const plan = plans[taskClass][tier ?? 'default'];
    const first = plan.routes[0];

    const outgoing = Object.create(null);
    for (const key of Object.keys(request)) {
      if (key !== 'taskId' && key !== 'tier') outgoing[key] = request[key];
    }
    if (operation === 'chat') {
      outgoing.model = first.model;
      outgoing.maxTokens = outputTokens;
    } else {
      outgoing.model = first.model;
    }

    let answer;
    try {
      answer = await plan.chain[operation](outgoing);
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
        provider: first.provider,
        model: first.model,
        tier,
      }),
    });
  }

  // A billed classification is charged like any other provider call: the conservative bound is
  // reserved against the task and day before dispatch, and settled with the adapter's reported usage
  // when it provides one. The answer is re-validated and copied, never trusted.
  async function classify(taskId, prompt) {
    const id = validateTaskId(taskId);
    if (difficulty === null) fail('no-difficulty-provider', 'no difficulty adapter is configured');
    const promptBytes = readClassifyPrompt(prompt);
    now();
    const task = taskFor(id);
    const tokens = classifyReservationTokens(promptBytes);
    const held = reserve(task, tokens);
    let answer;
    try {
      answer = await difficulty.classify(prompt);
    } catch (error) {
      settle(task, held, 0);
      throw error;
    }
    let result;
    try {
      result = readClassifyAnswer(answer);
    } catch (error) {
      // The request was dispatched, so the conservative charge stays even though the answer is unusable.
      settle(task, held, tokens);
      throw error;
    }
    let actual;
    try {
      actual = usageTokens(answer);
    } catch {
      actual = undefined;
    }
    // A reported count above the conservative bound is not trusted; keep the reservation instead.
    if (actual !== undefined && actual > tokens) actual = undefined;
    settle(task, held, actual === undefined || actual === 0 ? tokens : actual);
    return result;
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
    classify,
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
      tiers: DIFFICULTY_TIERS,
      difficulty: difficulty !== null,
      policy: Object.freeze(Object.fromEntries(TASK_CLASSES.map((taskClass) => [
        taskClass,
        Object.freeze(policy[taskClass].map((route) => Object.freeze({
          provider: route.provider,
          model: route.model,
          maxOutputTokens: route.maxOutputTokens,
          tiers: route.tiers,
        }))),
      ]))),
      budgets,
    }),
  });
}
