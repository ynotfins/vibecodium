// M2 B1 provider request client.
//
// A dependency-free client for the two transports Vibecodium uses: OpenAI Chat Completions and
// OpenAI Responses. Every request is gated by the M1 deny-by-default endpoint policy before the
// fetch call, so a remote provider is unreachable until the caller opts in with an exact host or
// category switch. Credentials are read once by `createProviderClient` and never returned,
// serialized or echoed in an error. Streaming responses are parsed incrementally with byte,
// event and tool-call caps, and a provider error never carries a response body.

import {
  AIEndpointPolicyError,
  assertAIEndpointAllowed,
  evaluateAIEndpointRequest,
} from '../security/ai-endpoint-policy.mjs';
import {
  MAX_BASE_URL_CHARS,
  MAX_MODEL_CHARS,
  MAX_RESPONSE_BYTES,
  MIN_RESPONSE_BYTES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  getProviderPreset,
  validateProviderBaseUrl,
  validateProviderModel,
} from './provider-presets.mjs';

export const PROVIDER_CLIENT_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGES = 200;
export const MAX_MESSAGE_CHARS = 1_000_000;
export const MAX_TOOLS = 128;
export const MAX_TOOL_NAME_CHARS = 128;
export const MAX_TOOL_CALLS = 32;
export const MAX_ARGUMENT_CHARS = 1_000_000;
export const MAX_OUTPUT_TOKENS = 1_000_000;
export const MAX_SSE_EVENTS = 10_000;
export const MAX_SSE_EVENT_CHARS = 512 * 1024;
export const MAX_EMBEDDING_INPUTS = 256;
export const MAX_EMBEDDING_DIMENSIONS = 16_384;
export const MAX_API_KEY_CHARS = 4096;

const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_CONTENT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export class ProviderClientError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ProviderClientError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function fail(code, message, extra) {
  throw new ProviderClientError(code, message, extra);
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

// Reads one environment variable without invoking an accessor or walking a polluted prototype.
function readEnvironment(env, name) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    fail('invalid-options', 'env must be an object');
  }
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(env, name);
  } catch {
    fail('invalid-options', 'env cannot be read');
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) fail('invalid-options', 'env must contain data properties only');
  return descriptor.value;
}

function validateInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail('invalid-options', name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return value;
}

function validateText(value, name, maximum) {
  if (typeof value !== 'string' || value.length > maximum || CONTROL_OR_BIDI.test(value)) {
    fail('invalid-options', name + ' is invalid');
  }
  return value;
}

function validateContent(value, name, maximum) {
  if (typeof value !== 'string' || value.length > maximum || UNSAFE_CONTENT.test(value)) {
    fail('invalid-options', name + ' is invalid');
  }
  return value;
}

function validateApiKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_API_KEY_CHARS ||
      CONTROL_OR_BIDI.test(value)) {
    fail('invalid-api-key', 'the provider API key is invalid');
  }
  return value;
}

function joinPath(baseUrl, pathname) {
  return baseUrl.replace(/\/+$/, '') + pathname;
}

// A caller who opts into external providers opts into the host they configured, but only when the
// M1 policy classifies that endpoint as an external provider or an unknown third-party host. A
// Copilot, telemetry, GitHub or metadata endpoint keeps its own category switch or hard deny.
function resolveRequestPolicy(config) {
  const policy = config.policy;
  if (policy.allowExternalProviders !== true) return policy;
  let url;
  try {
    url = new URL(config.baseUrl).href;
  } catch {
    return policy;
  }
  const decision = evaluateAIEndpointRequest(url, policy);
  if (decision.allowed) return policy;
  if (decision.code === 'forbidden-endpoint') assertAIEndpointAllowed(url, policy);
  if (decision.category !== 'external-provider' && decision.category !== 'unknown') {
    assertAIEndpointAllowed(url, policy);
  }
  const host = decision.host;
  if (typeof host !== 'string' || host.length === 0) return policy;
  const existing = Array.isArray(policy.allowHosts) ? policy.allowHosts : [];
  if (existing.includes(host)) return policy;
  const scoped = Object.freeze({ ...policy, allowHosts: Object.freeze([...existing, host]) });
  assertAIEndpointAllowed(url, scoped);
  return scoped;
}

export function resolveProviderConfig(id, options = {}) {
  if (!isPlainObject(options)) fail('invalid-options', 'options must be an object');
  const env = options.env ?? process.env;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) fail('invalid-options', 'env must be an object');
  const preset = getProviderPreset(id, options.settings);
  const configuredBaseUrl = preset.baseUrl ?? (preset.baseUrlEnv === undefined ? undefined : readEnvironment(env, preset.baseUrlEnv));
  const rawBaseUrl = options.baseUrl ?? configuredBaseUrl;
  if (rawBaseUrl === undefined) {
    fail('missing-base-url', 'provider ' + id + ' needs a base URL');
  }
  const baseUrl = validateProviderBaseUrl(rawBaseUrl);
  if (baseUrl.length > MAX_BASE_URL_CHARS) fail('invalid-base-url', 'baseUrl is too long');
  const modelInput = options.model ?? preset.defaultModel;
  if (modelInput === undefined || modelInput === '') fail('missing-model', 'provider ' + id + ' needs a model');
  const model = validateProviderModel(modelInput);
  if (model.length > MAX_MODEL_CHARS) fail('invalid-model', 'model is too long');
  const timeoutMs = validateInteger('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxResponseBytes = validateInteger(
    'maxResponseBytes',
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    MIN_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
  );
  const policy = options.policy ?? {};
  if (!isPlainObject(policy)) fail('invalid-options', 'policy must be a plain object');
  return Object.freeze({
    version: PROVIDER_CLIENT_VERSION,
    id: preset.id,
    label: preset.label,
    transport: preset.transport,
    baseUrl,
    model,
    auth: preset.auth,
    apiKeyEnv: preset.apiKeyEnv,
    apiKeyRequired: preset.apiKeyRequired,
    capabilities: preset.capabilities,
    timeoutMs,
    maxResponseBytes,
    policy,
  });
}

function normalizeUsage(usage) {
  if (usage === undefined || usage === null) {
    return Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  }
  if (!isPlainObject(usage)) fail('invalid-response', 'provider usage is invalid');
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? undefined;
  if (!Number.isInteger(input) || input < 0 || !Number.isInteger(output) || output < 0 ||
      (total !== undefined && (!Number.isInteger(total) || total < 0))) {
    fail('invalid-response', 'provider usage is invalid');
  }
  return Object.freeze({ inputTokens: input, outputTokens: output, totalTokens: total ?? input + output });
}

function normalizeToolCall(id, name, args) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 512 || CONTROL_OR_BIDI.test(id)) {
    fail('invalid-response', 'provider tool call id is invalid');
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME_CHARS || CONTROL_OR_BIDI.test(name)) {
    fail('invalid-response', 'provider tool call name is invalid');
  }
  if (!TOOL_NAME.test(name)) fail('invalid-response', 'provider tool call name is invalid');
  const text = args ?? '';
  if (typeof text !== 'string' || text.length > MAX_ARGUMENT_CHARS || UNSAFE_CONTENT.test(text)) {
    fail('invalid-response', 'provider tool call arguments are invalid');
  }
  return Object.freeze({ id, name, arguments: text });
}

function validateMessage(message) {
  if (!isPlainObject(message)) fail('invalid-message', 'messages must be plain objects');
  if (!MESSAGE_ROLES.has(message.role)) fail('invalid-message', 'unknown message role');
  if (typeof message.content !== 'string' || message.content.length > MAX_MESSAGE_CHARS ||
      UNSAFE_CONTENT.test(message.content)) {
    fail('invalid-message', 'message content is invalid');
  }
  const out = { role: message.role, content: message.content };
  if (message.tool_call_id !== undefined) {
    if (typeof message.tool_call_id !== 'string' || message.tool_call_id.length > 512 ||
        CONTROL_OR_BIDI.test(message.tool_call_id)) {
      fail('invalid-message', 'tool_call_id is invalid');
    }
    out.tool_call_id = message.tool_call_id;
  }
  if (message.name !== undefined) {
    if (typeof message.name !== 'string' || message.name.length > MAX_TOOL_NAME_CHARS ||
        CONTROL_OR_BIDI.test(message.name)) {
      fail('invalid-message', 'message name is invalid');
    }
    out.name = message.name;
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > MAX_TOOL_CALLS) {
      fail('invalid-message', 'tool_calls is invalid');
    }
    out.tool_calls = message.tool_calls.map((call) => {
      if (!isPlainObject(call) || !isPlainObject(call.function)) fail('invalid-message', 'tool call is invalid');
      return {
        id: validateText(call.id ?? '', 'tool call id', 512),
        type: 'function',
        function: {
          name: validateText(call.function.name, 'tool name', MAX_TOOL_NAME_CHARS),
          arguments: validateText(call.function.arguments ?? '{}', 'tool arguments', MAX_ARGUMENT_CHARS),
        },
      };
    });
  }
  return out;
}

function validateTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) fail('invalid-tools', 'tools is invalid');
  return tools.map((tool) => {
    if (!isPlainObject(tool) || tool.type !== 'function' || !isPlainObject(tool.function)) {
      fail('invalid-tools', 'tools must be OpenAI function tools');
    }
    const name = validateText(tool.function.name, 'tool name', MAX_TOOL_NAME_CHARS);
    if (!TOOL_NAME.test(name)) fail('invalid-tools', 'tool name is invalid');
    const description = tool.function.description === undefined
      ? undefined
      : validateContent(tool.function.description, 'tool description', 4096);
    const parameters = tool.function.parameters === undefined ? undefined : tool.function.parameters;
    if (parameters !== undefined && !isPlainObject(parameters)) fail('invalid-tools', 'tool parameters must be an object');
    return {
      type: 'function',
      function: {
        name,
        ...(description === undefined ? {} : { description }),
        ...(parameters === undefined ? {} : { parameters }),
      },
    };
  });
}

function toResponsesInput(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { type: 'function_call_output', call_id: message.tool_call_id, output: message.content };
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      return { role: 'assistant', content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

function toResponsesTools(tools) {
  if (tools === undefined) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
    ...(tool.function.parameters === undefined ? {} : { parameters: tool.function.parameters }),
  }));
}

async function readBoundedText(response, maximum) {
  if (response === null || typeof response !== 'object') fail('invalid-response', 'provider response is invalid');
  let header;
  try {
    header = response.headers?.get?.('content-length');
  } catch {
    fail('invalid-response', 'provider response headers are invalid');
  }
  if (header !== null && header !== undefined) {
    const length = Number(header);
    if (!Number.isFinite(length) || length < 0) fail('invalid-response', 'provider response headers are invalid');
    if (length > maximum) fail('response-too-large', 'provider response exceeded the size limit');
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    fail('invalid-response', 'provider response has no body');
  }
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximum) fail('response-too-large', 'provider response exceeded the size limit');
    text += decoder.decode(buffer, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function* streamEvents(response, maximum) {
  if (response === null || typeof response !== 'object' || !response.body ||
      typeof response.body[Symbol.asyncIterator] !== 'function') {
    fail('invalid-response', 'provider stream has no body');
  }
  const decoder = new TextDecoder();
  let pending = '';
  let bytes = 0;
  let events = 0;
  for await (const chunk of response.body) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximum) fail('response-too-large', 'provider response exceeded the size limit');
    pending += decoder.decode(buffer, { stream: true });
    if (pending.length > MAX_SSE_EVENT_CHARS) fail('response-too-large', 'provider event exceeded the size limit');
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending)) !== null) {
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      events += 1;
      if (events > MAX_SSE_EVENTS) fail('response-too-large', 'provider stream emitted too many events');
      const event = parseSseBlock(block);
      if (event !== undefined) yield event;
    }
  }
  pending += decoder.decode();
  if (pending.trim().length > 0) {
    events += 1;
    if (events > MAX_SSE_EVENTS) fail('response-too-large', 'provider stream emitted too many events');
    const event = parseSseBlock(pending);
    if (event !== undefined) yield event;
  }
}

function parseSseBlock(block) {
  const dataLines = [];
  let name;
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith('event:')) name = rawLine.slice(6).trim();
    else if (rawLine.startsWith('data:')) dataLines.push(rawLine.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return undefined;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    fail('invalid-response', 'provider stream event is not valid JSON');
  }
  if (!isPlainObject(payload)) fail('invalid-response', 'provider stream event is invalid');
  return name === undefined ? payload : { ...payload, ...(payload.type === undefined ? { type: name } : {}) };
}

function chatRequest(body, model, stream, tools, maxTokens) {
  return {
    model,
    messages: body.messages,
    stream,
    ...(tools === undefined ? {} : { tools, tool_choice: 'auto' }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  };
}

function responsesRequest(body, model, stream, tools, maxTokens) {
  return {
    model,
    input: toResponsesInput(body.messages),
    stream,
    ...(tools === undefined ? {} : { tools: toResponsesTools(tools), tool_choice: 'auto' }),
    ...(maxTokens === undefined ? {} : { max_output_tokens: maxTokens }),
  };
}

function parseChatResponse(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    fail('invalid-response', 'provider chat response is invalid');
  }
  const choice = payload.choices[0];
  if (!isPlainObject(choice) || !isPlainObject(choice.message)) fail('invalid-response', 'provider chat message is invalid');
  const content = choice.message.content;
  if (content !== null && typeof content !== 'string') fail('invalid-response', 'provider chat content is invalid');
  const calls = choice.message.tool_calls;
  // OpenAI-compatible servers send `tool_calls: null` when a message carries none (DeepInfra
  // does, verified live 2026-11-28), exactly as they send `content: null` for a tool-only turn, so
  // null means "absent", never "invalid".
  if (calls !== undefined && calls !== null && (!Array.isArray(calls) || calls.length > MAX_TOOL_CALLS)) {
    fail('invalid-response', 'provider tool calls are invalid');
  }
  const toolCalls = (calls ?? []).map((call) => {
    if (!isPlainObject(call) || !isPlainObject(call.function)) fail('invalid-response', 'provider tool call is invalid');
    return normalizeToolCall(call.id, call.function.name, call.function.arguments);
  });
  return Object.freeze({
    text: content ?? '',
    toolCalls: Object.freeze(toolCalls),
    usage: normalizeUsage(payload.usage),
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
  });
}

function parseChatStream(payload, state) {
  if (!isPlainObject(payload)) fail('invalid-response', 'provider stream event is invalid');
  if (payload.usage !== undefined) state.usage = normalizeUsage(payload.usage);
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) return;
  const choice = payload.choices[0];
  if (!isPlainObject(choice)) fail('invalid-response', 'provider stream choice is invalid');
  if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;
  const delta = choice.delta;
  if (delta === undefined) return;
  if (!isPlainObject(delta)) fail('invalid-response', 'provider stream delta is invalid');
  if (typeof delta.content === 'string') {
    state.text += delta.content;
    if (state.text.length > MAX_MESSAGE_CHARS) fail('response-too-large', 'provider content exceeded the size limit');
  }
  // A streamed delta carries `tool_calls: null` on every chunk that is not a tool call (DeepInfra
  // sends it on each reasoning and content delta, verified live 2026-11-28); only an actual array
  // is a tool-call delta.
  if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
    if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > MAX_TOOL_CALLS) {
      fail('invalid-response', 'provider stream tool calls are invalid');
    }
    for (const piece of delta.tool_calls) {
      if (!isPlainObject(piece) || !Number.isInteger(piece.index) || piece.index < 0 || piece.index >= MAX_TOOL_CALLS) {
        fail('invalid-response', 'provider stream tool call is invalid');
      }
      const entry = state.toolCalls.get(piece.index) ?? { id: '', name: '', arguments: '' };
      if (piece.id !== undefined) entry.id = validateText(piece.id, 'tool call id', 512);
      if (isPlainObject(piece.function)) {
        if (piece.function.name !== undefined) entry.name = validateText(piece.function.name, 'tool name', MAX_TOOL_NAME_CHARS);
        if (piece.function.arguments !== undefined) {
          entry.arguments += validateText(piece.function.arguments, 'tool arguments', MAX_ARGUMENT_CHARS);
          if (entry.arguments.length > MAX_ARGUMENT_CHARS) fail('response-too-large', 'provider tool arguments exceeded the size limit');
        }
      }
      state.toolCalls.set(piece.index, entry);
    }
  }
}

function parseResponsesResponse(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.output)) {
    fail('invalid-response', 'provider responses payload is invalid');
  }
  let text = '';
  const toolCalls = [];
  for (const item of payload.output) {
    if (!isPlainObject(item)) fail('invalid-response', 'provider response item is invalid');
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isPlainObject(part)) fail('invalid-response', 'provider message part is invalid');
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
      }
    }
    if (item.type === 'function_call') {
      toolCalls.push(normalizeToolCall(item.call_id ?? item.id, item.name, item.arguments));
    }
  }
  if (toolCalls.length > MAX_TOOL_CALLS) fail('invalid-response', 'too many provider tool calls');
  return Object.freeze({
    text,
    toolCalls: Object.freeze(toolCalls),
    usage: normalizeUsage(payload.usage),
  });
}

function parseResponsesStream(payload, state) {
  if (!isPlainObject(payload)) fail('invalid-response', 'provider stream event is invalid');
  const type = payload.type;
  if (type === 'response.output_text.delta') {
    if (typeof payload.delta !== 'string') fail('invalid-response', 'provider text delta is invalid');
    state.text += payload.delta;
    if (state.text.length > MAX_MESSAGE_CHARS) fail('response-too-large', 'provider content exceeded the size limit');
    return;
  }
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = payload.item;
    if (isPlainObject(item) && item.type === 'function_call') {
      const key = item.id ?? item.call_id;
      if (typeof key !== 'string') fail('invalid-response', 'provider function call item is invalid');
      const entry = state.toolCalls.get(key) ?? { id: item.call_id ?? item.id, name: item.name ?? '', arguments: '' };
      if (typeof item.name === 'string') entry.name = validateText(item.name, 'tool name', MAX_TOOL_NAME_CHARS);
      if (item.arguments !== undefined) entry.arguments = validateText(item.arguments, 'tool arguments', MAX_ARGUMENT_CHARS);
      state.toolCalls.set(key, entry);
    }
    return;
  }
  if (type === 'response.function_call_arguments.delta') {
    const key = payload.item_id;
    if (typeof key !== 'string' || typeof payload.delta !== 'string') {
      fail('invalid-response', 'provider function argument delta is invalid');
    }
    const entry = state.toolCalls.get(key) ?? { id: key, name: '', arguments: '' };
    entry.arguments += payload.delta;
    if (entry.arguments.length > MAX_ARGUMENT_CHARS) fail('response-too-large', 'provider tool arguments exceeded the size limit');
    state.toolCalls.set(key, entry);
    return;
  }
  if (type === 'response.completed') {
    if (isPlainObject(payload.response)) state.usage = normalizeUsage(payload.response.usage);
    return;
  }
  if (type === 'response.failed' || type === 'error') {
    fail('provider-error', 'the provider reported a failed response');
  }
}

function finalizeStream(state) {
  const toolCalls = [];
  for (const entry of [...state.toolCalls.values()]) {
    if (entry.id === '' || entry.name === '') fail('invalid-response', 'provider returned an incomplete tool call');
    toolCalls.push(normalizeToolCall(entry.id, entry.name, entry.arguments));
  }
  if (toolCalls.length > MAX_TOOL_CALLS) fail('invalid-response', 'too many provider tool calls');
  return Object.freeze({
    text: state.text,
    toolCalls: Object.freeze(toolCalls),
    usage: state.usage,
    ...(state.finishReason === undefined ? {} : { finishReason: state.finishReason }),
  });
}

function normalizeEmbeddings(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
    fail('invalid-response', 'provider embeddings response is invalid');
  }
  const vectors = payload.data.map((item) => {
    if (!isPlainObject(item) || !Array.isArray(item.embedding) || item.embedding.length === 0 ||
        item.embedding.length > MAX_EMBEDDING_DIMENSIONS) {
      fail('invalid-response', 'provider embedding vector is invalid');
    }
    return Object.freeze(item.embedding.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid-response', 'provider embedding value is invalid');
      return value;
    }));
  });
  return Object.freeze({ vectors: Object.freeze(vectors), usage: normalizeUsage(payload.usage) });
}

export function createProviderClient(id, options = {}) {
  if (!isPlainObject(options)) fail('invalid-options', 'options must be an object');
  const config = resolveProviderConfig(id, options);
  const requestPolicy = resolveRequestPolicy(config);
  const env = options.env ?? process.env;
  const supplied = options.apiKey ?? (config.apiKeyEnv === undefined ? undefined : readEnvironment(env, config.apiKeyEnv));
  const apiKey = supplied === undefined ? undefined : validateApiKey(supplied);
  if (config.apiKeyRequired && apiKey === undefined) {
    fail('missing-api-key', 'provider ' + id + ' requires an API key');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('missing-fetch', 'no fetch implementation is available');

  async function request(pathname, body, { stream }) {
    const url = joinPath(config.baseUrl, pathname);
    assertAIEndpointAllowed(url, requestPolicy);
    const headers = {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
    };
    if (config.auth === 'bearer' && apiKey !== undefined) headers.authorization = 'Bearer ' + apiKey;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, config.timeoutMs);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', abort);
    };
    if (options.signal !== undefined) {
      if (typeof options.signal.addEventListener !== 'function') {
        release();
        fail('invalid-options', 'signal is invalid');
      }
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      release();
      if (timedOut) fail('timeout', 'the provider request timed out');
      if (controller.signal.aborted) fail('aborted', 'the provider request was aborted');
      fail('network-error', 'the provider request failed');
    }
    if (response === null || typeof response !== 'object') {
      release();
      fail('invalid-response', 'provider response is invalid');
    }
    if (response.status !== undefined && response.ok === false) {
      release();
      fail('http-status', 'the provider request failed with HTTP ' + response.status, { status: response.status });
    }
    return { response, release, signal: controller.signal, timedOut: () => timedOut };
  }

  async function chat(input = {}) {
    if (!isPlainObject(input)) fail('invalid-options', 'chat input must be an object');
    if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > MAX_MESSAGES) {
      fail('invalid-messages', 'messages must be a non-empty bounded array');
    }
    const messages = input.messages.map(validateMessage);
    const tools = validateTools(input.tools);
    const model = validateProviderModel(input.model ?? config.model);
    const stream = input.stream === true;
    if (input.stream !== undefined && typeof input.stream !== 'boolean') fail('invalid-options', 'stream must be a boolean');
    const maxTokens = input.maxTokens === undefined
      ? undefined
      : validateInteger('maxTokens', input.maxTokens, 1, MAX_OUTPUT_TOKENS);
    const body = config.transport === 'openai-chat'
      ? chatRequest({ messages }, model, stream, tools, maxTokens)
      : responsesRequest({ messages }, model, stream, tools, maxTokens);
    const pathname = config.transport === 'openai-chat' ? '/chat/completions' : '/responses';
    const { response, release, signal, timedOut } = await request(pathname, body, { stream });
    try {
      if (!stream) {
        const text = await readBoundedText(response, config.maxResponseBytes);
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          fail('invalid-response', 'provider response is not valid JSON');
        }
        return config.transport === 'openai-chat' ? parseChatResponse(payload) : parseResponsesResponse(payload);
      }
      const state = {
        text: '',
        toolCalls: new Map(),
        usage: normalizeUsage(undefined),
        finishReason: undefined,
      };
      for await (const event of streamEvents(response, config.maxResponseBytes)) {
        if (config.transport === 'openai-chat') parseChatStream(event, state);
        else parseResponsesStream(event, state);
      }
      return finalizeStream(state);
    } catch (error) {
      if (timedOut()) fail('timeout', 'the provider request timed out');
      if (signal.aborted) fail('aborted', 'the provider request was aborted');
      throw error;
    } finally {
      release();
    }
  }

  async function embeddings(input = {}) {
    if (config.transport !== 'openai-chat' || !config.capabilities.includes('embeddings')) {
      fail('unsupported-transport', 'this provider does not expose embeddings');
    }
    if (!Array.isArray(input.input)) {
      if (typeof input.input !== 'string') fail('invalid-options', 'embeddings input must be a string or string array');
      input = { ...input, input: [input.input] };
    }
    if (input.input.length === 0 || input.input.length > MAX_EMBEDDING_INPUTS) {
      fail('invalid-options', 'embeddings input is too large');
    }
    for (const item of input.input) validateContent(item, 'embedding input', MAX_MESSAGE_CHARS);
    const model = validateProviderModel(input.model ?? config.model);
    const { response, release, signal, timedOut } = await request('/embeddings', { model, input: input.input }, { stream: false });
    try {
      const text = await readBoundedText(response, config.maxResponseBytes);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        fail('invalid-response', 'provider response is not valid JSON');
      }
      return normalizeEmbeddings(payload);
    } catch (error) {
      if (timedOut()) fail('timeout', 'the provider request timed out');
      if (signal.aborted) fail('aborted', 'the provider request was aborted');
      throw error;
    } finally {
      release();
    }
  }

  return Object.freeze({
    config,
    chat,
    embeddings,
    describe: () => Object.freeze({ ...config, policy: undefined }),
  });
}

export function isEndpointPolicyError(error) {
  return error instanceof AIEndpointPolicyError;
}

export function describeEndpointDecision(url, policy) {
  return evaluateAIEndpointRequest(url, policy);
}
