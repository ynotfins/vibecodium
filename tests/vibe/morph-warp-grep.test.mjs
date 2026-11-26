import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProviderClient } from '../../src/stable/gateway/provider-client.mjs';
import {
  CODEBASE_SEARCH_TOOL,
  MAX_READ_LINES,
  MAX_SEARCH_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TURNS,
  MORPH_WARP_GREP_VERSION,
  WARP_GREP_MODEL,
  WARP_GREP_TOOLS,
  WarpGrepError,
  createMorphWarpGrepTool,
  describeMorphWarpGrep,
} from '../../src/stable/gateway/morph-warp-grep.mjs';

const HOST = 'localhost';
const SECRET = ['sk', 'morph', 'warp', 'do', 'not', 'leak'].join('-');
const QUERY = 'Where is the needle constant defined?';
const ALPHA = 'export const alpha = 1;\nexport const needle = "alpha";\nexport const omega = 3;\n';

function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  });
  response.end(body);
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

function chatPayload(content, toolCalls, usage = { prompt_tokens: 5, completion_tokens: 5 }) {
  return {
    choices: [{
      message: { role: 'assistant', content: content ?? '', ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls ? 'tool_calls' : 'stop',
    }],
    usage,
  };
}

async function startMock(t, handler) {
  const state = { requests: [] };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    state.requests.push({ url: request.url, headers: request.headers, body });
    const outcome = await handler({ body, state, response, request });
    if (outcome === false) return;
    sendJson(response, outcome ?? chatPayload('done'));
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, port: server.address().port };
}

function clientFor(port) {
  return createProviderClient('morph', {
    baseUrl: 'http://' + HOST + ':' + port + '/v1',
    model: WARP_GREP_MODEL,
    apiKey: SECRET,
    env: {},
    timeoutMs: 5000,
  });
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibe-warp-grep-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, handler) {
  const root = await workspace(t);
  await writeFile(path.join(root, 'src', 'alpha.mjs'), ALPHA, 'utf8');
  const mock = await startMock(t, handler);
  const tool = createMorphWarpGrepTool({ client: clientFor(mock.port), workspaceRoot: root });
  return { root, mock, tool };
}

function scripted(steps) {
  return ({ state }) => {
    const index = state.requests.length - 1;
    const step = steps[Math.min(index, steps.length - 1)];
    return typeof step === 'function' ? step(index) : step;
  };
}

function toolResults(messages) {
  return messages.filter((message) => message.role === 'tool');
}

async function rejection(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof WarpGrepError, true, 'expected a WarpGrepError, got ' + error);
    assert.equal(error.code, code);
    return true;
  });
}

test('the public definition and describe surface are exact and immutable', () => {
  assert.equal(MORPH_WARP_GREP_VERSION, 1);
  assert.equal(WARP_GREP_MODEL, 'morph-warp-grep-v2.1');
  assert.equal(CODEBASE_SEARCH_TOOL.type, 'function');
  assert.equal(CODEBASE_SEARCH_TOOL.function.name, 'codebase_search');
  assert.deepEqual([...CODEBASE_SEARCH_TOOL.function.parameters.required], ['search_string']);
  assert.equal(CODEBASE_SEARCH_TOOL.function.parameters.additionalProperties, false);
  assert.deepEqual([...CODEBASE_SEARCH_TOOL.function.parameters.properties.search_type.enum], ['default', 'node_modules']);
  assert.deepEqual(WARP_GREP_TOOLS.map((tool) => tool.function.name), ['grep_search', 'glob', 'list_directory', 'read', 'finish']);
  assert.equal(Object.isFrozen(WARP_GREP_TOOLS), true);
  for (const tool of WARP_GREP_TOOLS) {
    assert.equal(Object.isFrozen(tool), true);
  }
  assert.equal(Object.isFrozen(CODEBASE_SEARCH_TOOL), true);
  assert.throws(() => { CODEBASE_SEARCH_TOOL.function.name = 'changed'; }, TypeError);
  const described = describeMorphWarpGrep();
  assert.deepEqual(described, {
    version: MORPH_WARP_GREP_VERSION,
    name: 'codebase_search',
    model: WARP_GREP_MODEL,
    maxTurns: MAX_TURNS,
  });
  assert.equal(Object.isFrozen(described), true);
  assert.equal(JSON.stringify(described).includes(SECRET), false);
});

test('a scripted grep, read and finish loop returns the finished spans and bounded content', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle' })]),
    chatPayload('', [toolCall('call-2', 'read', { path: 'src/alpha.mjs', lines: '2-2' })]),
    chatPayload('', [toolCall('call-3', 'finish', { files: 'src/alpha.mjs:2-2' })]),
  ]));

  const result = await tool.execute({ search_string: QUERY });

  assert.deepEqual(result.files, [{ path: 'src/alpha.mjs', ranges: [[2, 2]], content: 'export const needle = "alpha";' }]);
  assert.equal(result.turns, 3);
  assert.equal(result.searchType, 'default');
  assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 15, totalTokens: 30 });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.files), true);
  assert.equal(Object.isFrozen(result.files[0]), true);
  assert.equal(Object.isFrozen(result.files[0].ranges), true);
  assert.equal(Object.isFrozen(result.files[0].ranges[0]), true);
  assert.equal(Object.isFrozen(result.usage), true);
  assert.equal(Object.isFrozen(WARP_GREP_TOOLS[0].function.parameters), true);

  assert.equal(mock.state.requests.length, 3);
  for (const request of mock.state.requests) {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer ' + SECRET);
    assert.equal(request.body.model, WARP_GREP_MODEL);
    assert.equal(request.body.stream, false);
    assert.deepEqual(request.body.tools.map((entry) => entry.function.name), ['grep_search', 'glob', 'list_directory', 'read', 'finish']);
  }
  const first = mock.state.requests[0].body.messages;
  assert.equal(first[0].role, 'system');
  assert.equal(first[1].role, 'user');
  assert.equal(first[1].content.includes(QUERY), true);
  assert.equal(first[1].content.includes('<repo_structure>'), true);
  assert.equal(first[1].content.includes('<search_string>'), true);
  const grepResult = toolResults(mock.state.requests[1].body.messages);
  assert.equal(grepResult.length, 1);
  assert.match(grepResult[0].content, /src\/alpha\.mjs:2:/);
  const readResult = toolResults(mock.state.requests[2].body.messages);
  assert.match(readResult[1].content, /2\| export const needle = "alpha";/);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(QUERY), false);
  assert.equal(JSON.stringify(describeMorphWarpGrep()).includes('client'), false);
});

test('a finish without a range returns the whole file and an empty range list is rejected', async (t) => {
  const { tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src/alpha.mjs:*' })]),
  ]));
  const result = await tool.execute({ search_string: QUERY });
  assert.deepEqual(result.files[0].ranges, []);
  assert.equal(result.files[0].content, ALPHA.trimEnd());

  const { tool: empty } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: '   ' })]),
  ]));
  await rejection(empty.execute({ search_string: QUERY }), 'invalid-finish');
});

test('grep excludes .git and node_modules by default and includes node_modules on request', async (t) => {
  const first = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle' })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs' })]),
  ]));
  await mkdir(path.join(first.root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(first.root, 'node_modules', 'pkg', 'index.mjs'), 'export const needle = "dep";\n', 'utf8');
  await mkdir(path.join(first.root, '.git'), { recursive: true });
  await writeFile(path.join(first.root, '.git', 'config'), 'needle = "git"\n', 'utf8');
  await first.tool.execute({ search_string: QUERY });
  const defaultHit = toolResults(first.mock.state.requests[1].body.messages)[0].content;
  assert.match(defaultHit, /src\/alpha\.mjs/);
  assert.equal(defaultHit.includes('node_modules'), false);
  assert.equal(defaultHit.includes('.git'), false);

  const second = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle' })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs' })]),
  ]));
  await mkdir(path.join(second.root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(second.root, 'node_modules', 'pkg', 'index.mjs'), 'export const needle = "dep";\n', 'utf8');
  await second.tool.execute({ search_string: QUERY, search_type: 'node_modules' });
  const included = toolResults(second.mock.state.requests[1].body.messages)[0].content;
  assert.match(included, /node_modules\/pkg\/index\.mjs/);
});

test('grep cannot reach .git or node_modules through an explicit path by default', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle', path: '.git' })]),
    chatPayload('', [toolCall('call-2', 'grep_search', { pattern: 'needle', path: 'node_modules' })]),
    chatPayload('', [toolCall('call-3', 'finish', { files: 'src/alpha.mjs' })]),
  ]));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, '.git', 'config'), 'needle in git\n', 'utf8');
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.mjs'), 'needle in dep\n', 'utf8');

  await tool.execute({ search_string: QUERY });

  const gitOutput = toolResults(mock.state.requests[1].body.messages)[0].content;
  const depOutput = toolResults(mock.state.requests[2].body.messages)[1].content;
  assert.equal(gitOutput.includes('needle in git'), false);
  assert.equal(depOutput.includes('needle in dep'), false);
  assert.match(gitOutput, /^error: |^no matches$/);
  assert.match(depOutput, /^error: |^no matches$/);
});

test('an escaping or symlinked read is reported to the model and a finish outside the workspace fails closed', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'read', { path: '../outside.txt' })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs' })]),
  ]));
  await writeFile(path.join(root, '..', 'outside-warp-grep.txt'), 'TOP SECRET OUTSIDE\n', 'utf8');
  t.after(() => rm(path.join(root, '..', 'outside-warp-grep.txt'), { force: true }));
  await tool.execute({ search_string: QUERY });
  const escaped = toolResults(mock.state.requests[1].body.messages)[0].content;
  assert.match(escaped, /^error: /);
  assert.equal(escaped.includes('TOP SECRET OUTSIDE'), false);

  const { root: second, tool: secondTool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src/../../outside-warp-grep.txt' })]),
  ]));
  await writeFile(path.join(second, '..', 'outside-warp-grep.txt'), 'TOP SECRET OUTSIDE\n', 'utf8');
  t.after(() => rm(path.join(second, '..', 'outside-warp-grep.txt'), { force: true }));
  await rejection(secondTool.execute({ search_string: QUERY }), 'invalid-finish');

  const { root: third, tool: thirdTool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src/link.mjs' })]),
  ]));
  let linked = true;
  await symlink(path.join(third, 'src', 'alpha.mjs'), path.join(third, 'src', 'link.mjs'), 'file').catch(() => { linked = false; });
  await rejection(thirdTool.execute({ search_string: QUERY }), 'invalid-finish');
  assert.equal(linked, true, 'the symlink fixture must be created so the rejection is not a missing-file case');
});

test('a symlinked directory cannot escape the workspace for read, grep or finish', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'read', { path: 'src/alias/secret.txt' })]),
    chatPayload('', [toolCall('call-2', 'grep_search', { pattern: 'needle', path: 'src/alias' })]),
    chatPayload('', [toolCall('call-3', 'finish', { files: 'src/alias/secret.txt' })]),
  ]));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vibe-warp-grep-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET needle\n', 'utf8');
  await symlink(outside, path.join(root, 'src', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');

  await rejection(tool.execute({ search_string: QUERY }), 'invalid-finish');

  const readOutput = toolResults(mock.state.requests[1].body.messages)[0].content;
  const grepOutput = toolResults(mock.state.requests[2].body.messages)[1].content;
  assert.match(readOutput, /^error: /);
  assert.match(grepOutput, /^error: /);
  assert.equal(readOutput.includes('OUTSIDE-SECRET'), false);
  assert.equal(grepOutput.includes('OUTSIDE-SECRET'), false);
});

test('absolute, drive, UNC, encoded and oversized paths are refused for read and finish', async (t) => {
  const reads = [
    '/etc/passwd',
    'C:/Windows/win.ini',
    '\\\\server\\share\\x',
    'src/%2e%2e/leak.txt',
    'a'.repeat(1100),
  ];
  const { mock, tool } = await fixture(t, scripted([
    ...reads.map((value, index) => chatPayload('', [toolCall('call-' + index, 'read', { path: value })])),
    chatPayload('', [toolCall('call-finish', 'finish', { files: 'C:/Windows/win.ini' })]),
  ]));

  await rejection(tool.execute({ search_string: QUERY }), 'invalid-finish');

  const outputs = toolResults(mock.state.requests[5].body.messages);
  assert.equal(outputs.length, reads.length);
  for (const output of outputs) assert.match(output.content, /^error: /);

  for (const files of ['/etc/passwd', 'C:/Windows/win.ini', '\\\\server\\share\\x', 'src/%2e%2e/leak.txt', '../leak.txt']) {
    const { tool: finishTool } = await fixture(t, scripted([
      chatPayload('', [toolCall('call-1', 'finish', { files })]),
    ]));
    await rejection(finishTool.execute({ search_string: QUERY }), 'invalid-finish');
  }
});

test('binary, directory, missing and oversized finish targets fail closed', async (t) => {
  const { root, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src/binary.bin' })]),
  ]));
  await writeFile(path.join(root, 'src', 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]), { flag: 'w' });
  await rejection(tool.execute({ search_string: QUERY }), 'invalid-finish');

  const { tool: directoryTool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src' })]),
  ]));
  await rejection(directoryTool.execute({ search_string: QUERY }), 'invalid-finish');

  const { tool: missingTool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src/missing.mjs' })]),
  ]));
  await rejection(missingTool.execute({ search_string: QUERY }), 'invalid-finish');

  const { root: bigRoot, tool: bigTool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src/big.mjs' })]),
  ]));
  await writeFile(path.join(bigRoot, 'src', 'big.mjs'), 'x'.repeat(1024 * 1024 + 1), 'utf8');
  await rejection(bigTool.execute({ search_string: QUERY }), 'invalid-finish');
});

test('a text-only answer, no files, a malformed finish and too many files fail closed', async (t) => {
  const { tool: textOnly } = await fixture(t, scripted([chatPayload('I think it is here.')]));
  await rejection(textOnly.execute({ search_string: QUERY }), 'no-tool-calls');

  const { tool: emptyFiles } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: '' })]),
  ]));
  await rejection(emptyFiles.execute({ search_string: QUERY }), 'invalid-finish');

  const { tool: malformed } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', '{not json')]),
  ]));
  await rejection(malformed.execute({ search_string: QUERY }), 'invalid-finish');

  const many = Array.from({ length: 40 }, () => 'src/alpha.mjs').join(' ');
  const { root: manyRoot, tool: manyTool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: many })]),
  ]));
  await writeFile(path.join(manyRoot, 'src', 'many.mjs'), ALPHA, 'utf8');
  await rejection(manyTool.execute({ search_string: QUERY }), 'invalid-finish');
});

test('a malformed provider answer fails closed as invalid-response', async (t) => {
  const root = await workspace(t);
  for (const value of [null, {}, { text: '', toolCalls: 'nope' }, { text: 7, toolCalls: [] }]) {
    const tool = createMorphWarpGrepTool({
      client: { chat: async () => value },
      workspaceRoot: root,
    });
    await rejection(tool.execute({ search_string: QUERY }), 'invalid-response');
  }
});

test('a sparse or null tool-call entry fails closed instead of throwing a raw error', async (t) => {
  const root = await workspace(t);
  for (const toolCalls of [new Array(2), [null]]) {
    const tool = createMorphWarpGrepTool({
      client: { chat: async () => ({ text: '', toolCalls, usage: {} }) },
      workspaceRoot: root,
    });
    await rejection(tool.execute({ search_string: QUERY }), 'invalid-response');
  }
});

test('an oversized result fails closed instead of truncating silently', async (t) => {
  const { root, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src/large.mjs:*' })]),
  ]));
  await writeFile(path.join(root, 'src', 'large.mjs'), 'y'.repeat(300 * 1024), 'utf8');
  await assert.rejects(tool.execute({ search_string: QUERY }), (error) => {
    assert.equal(error.code, 'result-too-large');
    assert.equal(error.message.includes('yyyy'), false);
    return true;
  });

  const parts = Array.from({ length: 9 }, (_, index) => 'src/part-' + index + '.mjs');
  const { root: manyRoot, tool: manyTool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: parts.join(' ') })]),
  ]));
  for (const part of parts) {
    await writeFile(path.join(manyRoot, part), 'z'.repeat(32768), 'utf8');
  }
  await rejection(manyTool.execute({ search_string: QUERY }), 'result-too-large');
});

test('a server error is reported as provider-error with only the status', async (t) => {
  const root = await workspace(t);
  const server = http.createServer((request, response) => {
    request.resume();
    sendJson(response, { error: 'nope' }, 503);
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const tool = createMorphWarpGrepTool({
    client: createProviderClient('morph', {
      baseUrl: 'http://' + HOST + ':' + server.address().port + '/v1',
      model: WARP_GREP_MODEL,
      apiKey: SECRET,
      env: {},
      timeoutMs: 5000,
    }),
    workspaceRoot: root,
  });
  await assert.rejects(tool.execute({ search_string: QUERY }), (error) => {
    assert.equal(error.code, 'provider-error');
    assert.equal(error.status, 503);
    assert.equal(error.message.includes(QUERY), false);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes('nope'), false);
    assert.equal(error.message.includes(HOST), false);
    return true;
  });
});

test('the loop stops at the turn limit and caps tool calls per turn', async (t) => {
  const { mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-x', 'grep_search', { pattern: 'needle' })]),
  ]));
  await rejection(tool.execute({ search_string: QUERY }), 'turn-limit');
  assert.equal(mock.state.requests.length, MAX_TURNS);

  const { tool: manyCalls } = await fixture(t, scripted([
    chatPayload('', Array.from({ length: 9 }, (_, index) => toolCall('call-' + index, 'grep_search', { pattern: 'needle' }))),
  ]));
  await rejection(manyCalls.execute({ search_string: QUERY }), 'too-many-tool-calls');
});

test('the total tool-call cap fails closed across turns', async (t) => {
  const { mock, tool } = await fixture(t, scripted([
    chatPayload('', Array.from({ length: 5 }, (_, index) => toolCall('call-' + index, 'grep_search', { pattern: 'needle' }))),
  ]));
  await rejection(tool.execute({ search_string: QUERY }), 'too-many-tool-calls');
  assert.equal(mock.state.requests.length, 5);
});

test('repo_path must resolve to the configured workspace root', async (t) => {
  const { root, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src/alpha.mjs:1-1' })]),
  ]));
  const accepted = await tool.execute({ search_string: QUERY, repo_path: root });
  assert.equal(accepted.files[0].path, 'src/alpha.mjs');
  await rejection(tool.execute({ search_string: QUERY, repo_path: path.dirname(root) }), 'outside-workspace');
  await rejection(tool.execute({ search_string: QUERY, repo_path: 'relative/path' }), 'invalid-input');
});

test('options and input fail closed without invoking an accessor', async (t) => {
  const { mock, tool } = await fixture(t, () => chatPayload('unused'));
  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, 'search_string', { enumerable: true, get() { invoked = true; return QUERY; } });
  await rejection(tool.execute(accessor), 'invalid-input');
  assert.equal(invoked, false);

  await rejection(tool.execute({ search_string: QUERY, extra: true }), 'invalid-input');
  await rejection(tool.execute({}), 'invalid-input');
  await rejection(tool.execute({ search_string: '' }), 'invalid-input');
  await rejection(tool.execute({ search_string: 'z'.repeat(MAX_SEARCH_CHARS + 1) }), 'invalid-input');
  await rejection(tool.execute({ search_string: QUERY, search_type: 'everything' }), 'invalid-input');
  await rejection(tool.execute({ search_string: QUERY, repo_path: 7 }), 'invalid-input');
  await rejection(tool.execute([QUERY]), 'invalid-input');
  assert.equal(mock.state.requests.length, 0);

  const options = {};
  Object.defineProperty(options, 'client', { enumerable: true, get() { invoked = true; return {}; } });
  assert.throws(() => createMorphWarpGrepTool(options), (error) => error instanceof WarpGrepError);
  assert.equal(invoked, false);
  await assert.rejects(Promise.resolve().then(() => createMorphWarpGrepTool({ client: {}, workspaceRoot: os.tmpdir() })));
  await assert.rejects(Promise.resolve().then(() => createMorphWarpGrepTool({ client: { chat() {} }, workspaceRoot: 'relative' })));
  await assert.rejects(Promise.resolve().then(() => createMorphWarpGrepTool({ client: { chat() {} }, workspaceRoot: os.tmpdir(), extra: 1 })));
});

test('a network failure is reported without the endpoint, query or key', async (t) => {
  const root = await workspace(t);
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, HOST, resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const tool = createMorphWarpGrepTool({
    client: createProviderClient('morph', {
      baseUrl: 'http://' + HOST + ':' + port + '/v1',
      model: WARP_GREP_MODEL,
      apiKey: SECRET,
      env: {},
      timeoutMs: 5000,
    }),
    workspaceRoot: root,
  });
  await assert.rejects(tool.execute({ search_string: QUERY }), (error) => {
    assert.equal(error.code, 'provider-error');
    assert.equal(error.message.includes(QUERY), false);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes(String(port)), false);
    assert.equal(error.message.includes(HOST), false);
    return true;
  });
});
test('a multi-range read renders the true line numbers and a glob limits grep', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'read', { path: 'src/alpha.mjs', lines: '1-1,3-3' })]),
    chatPayload('', [toolCall('call-2', 'grep_search', { pattern: 'needle', glob: 'src/**/*.mjs' })]),
    chatPayload('', [toolCall('call-3', 'finish', { files: 'src/alpha.mjs:1-1' })]),
  ]));
  await writeFile(path.join(root, 'notes.txt'), 'needle in notes\n', 'utf8');
  await tool.execute({ search_string: QUERY });
  const readOutput = toolResults(mock.state.requests[1].body.messages)[0].content;
  assert.equal(readOutput, '1| export const alpha = 1;\n3| export const omega = 3;');
  const grepOutput = toolResults(mock.state.requests[2].body.messages)[1].content;
  assert.match(grepOutput, /src\/alpha\.mjs:2:/);
  assert.equal(grepOutput.includes('notes.txt'), false);
});

test('grep rejects a file path and reports no matches without failing the loop', async (t) => {
  const { mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle', path: 'src/alpha.mjs' })]),
    chatPayload('', [toolCall('call-2', 'grep_search', { pattern: 'absent-term' })]),
    chatPayload('', [toolCall('call-3', 'finish', { files: 'src/alpha.mjs:2-2' })]),
  ]));
  const result = await tool.execute({ search_string: QUERY });
  const first = toolResults(mock.state.requests[1].body.messages)[0].content;
  assert.match(first, /^error: /);
  const second = toolResults(mock.state.requests[2].body.messages)[1].content;
  assert.equal(second, 'no matches');
  assert.equal(result.files[0].path, 'src/alpha.mjs');
});

test('a dot path searches from the root and a leading dot-slash is accepted', async (t) => {
  const { mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle', path: '.' })]),
    chatPayload('', [toolCall('call-2', 'read', { path: './src/alpha.mjs', lines: '2-2' })]),
    chatPayload('', [toolCall('call-3', 'finish', { files: './src/alpha.mjs:2-2' })]),
  ]));
  const result = await tool.execute({ search_string: QUERY });
  assert.match(toolResults(mock.state.requests[1].body.messages)[0].content, /src\/alpha\.mjs:2:/);
  assert.match(toolResults(mock.state.requests[2].body.messages)[1].content, /2\| export const needle/);
  assert.equal(result.files[0].path, 'src/alpha.mjs');
});

test('oversized tool arguments and a secret-looking finish payload fail closed or are refused', async (t) => {
  const { mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle', glob: 'x'.repeat(300) })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs' })]),
  ]));
  const result = await tool.execute({ search_string: QUERY });
  assert.match(toolResults(mock.state.requests[1].body.messages)[0].content, /^error: /);
  assert.equal(result.files[0].path, 'src/alpha.mjs');

  const { tool: bigFinish } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', '{"files":"' + 'a'.repeat(70000) + '"}')]),
  ]));
  await rejection(bigFinish.execute({ search_string: QUERY }), 'invalid-finish');
});

test('a pathological glob is matched in linear time and a build folder is not readable', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle', glob: '*a*a*a*a*a*X' })]),
    chatPayload('', [toolCall('call-2', 'read', { path: 'dist/out.js' })]),
    chatPayload('', [toolCall('call-3', 'finish', { files: 'src/alpha.mjs' })]),
  ]));
  await writeFile(path.join(root, 'src', 'b' + 'a'.repeat(60) + '.mjs'), 'needle long name\n', 'utf8');
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'out.js'), 'needle build\n', 'utf8');
  const started = globalThis.Date.now();
  const result = await tool.execute({ search_string: QUERY });
  const elapsed = globalThis.Date.now() - started;
  assert.equal(elapsed < 2000, true, 'glob matching must stay linear: ' + elapsed + 'ms');
  assert.match(toolResults(mock.state.requests[1].body.messages)[0].content, /^no matches$|^error: /);
  assert.match(toolResults(mock.state.requests[2].body.messages)[1].content, /^error: /);
  assert.equal(result.files[0].path, 'src/alpha.mjs');
});

test('read and finish cannot reach .git, node_modules or build folders through an explicit path', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'read', { path: '.git/config' })]),
    chatPayload('', [toolCall('call-2', 'read', { path: 'node_modules/pkg/index.mjs' })]),
    chatPayload('', [toolCall('call-3', 'read', { path: 'dist/out.js' })]),
    chatPayload('', [toolCall('call-4', 'finish', { files: 'src/alpha.mjs:1-1' })]),
  ]));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, '.git', 'config'), 'GIT-SECRET\n', 'utf8');
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.mjs'), 'DEP-SECRET\n', 'utf8');
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'out.js'), 'DIST-SECRET\n', 'utf8');

  await tool.execute({ search_string: QUERY });
  const reads = toolResults(mock.state.requests[3].body.messages);
  assert.equal(reads.length, 3);
  for (const output of reads) {
    assert.match(output.content, /^error: /);
    assert.equal(/GIT-SECRET|DEP-SECRET|DIST-SECRET/.test(output.content), false);
  }

  const excluded = [
    ['.git/config', ['.git', 'config'], 'GIT-SECRET\n'],
    ['node_modules/pkg/index.mjs', ['node_modules', 'pkg', 'index.mjs'], 'DEP-SECRET\n'],
    ['dist/out.js', ['dist', 'out.js'], 'DIST-SECRET\n'],
  ];
  for (const [files, segments, body] of excluded) {
    const { root: finishRoot, tool: finishTool } = await fixture(t, scripted([
      chatPayload('', [toolCall('call-finish', 'finish', { files })]),
    ]));
    const target = path.join(finishRoot, ...segments);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, 'utf8');
    await rejection(finishTool.execute({ search_string: QUERY }), 'invalid-finish');
  }

  const { root: allowedRoot, tool: allowedTool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'node_modules/pkg/index.mjs' })]),
  ]));
  await mkdir(path.join(allowedRoot, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(allowedRoot, 'node_modules', 'pkg', 'index.mjs'), 'DEP-OK\n', 'utf8');
  const allowed = await allowedTool.execute({ search_string: QUERY, search_type: 'node_modules' });
  assert.equal(allowed.files[0].path, 'node_modules/pkg/index.mjs');
});

test('a read renders within its line cap and marks the output truncated', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'read', { path: 'src/long.txt' })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs:1-1' })]),
  ]));
  const lines = Array.from({ length: MAX_READ_LINES + 50 }, (_, index) => 'line ' + (index + 1));
  await writeFile(path.join(root, 'src', 'long.txt'), lines.join('\n') + '\n', 'utf8');

  await tool.execute({ search_string: QUERY });
  const output = toolResults(mock.state.requests[1].body.messages)[0].content;
  assert.equal(output.endsWith('\n(truncated)'), true);
  assert.equal(output.split('\n').filter((line) => /^\d+\| /.test(line)).length, MAX_READ_LINES);
});

test('a grep stops after 8 MiB of decoded text and marks the output truncated', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle', path: 'big' })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs:1-1' })]),
  ]));
  await mkdir(path.join(root, 'big'), { recursive: true });
  for (let index = 0; index < 9; index += 1) {
    await writeFile(path.join(root, 'big', 'part' + index + '.txt'), 'needle line\n' + 'x'.repeat(950000), 'utf8');
  }

  await tool.execute({ search_string: QUERY });
  const output = toolResults(mock.state.requests[1].body.messages)[0].content;
  assert.equal(output.endsWith('(truncated)'), true);
  assert.equal(output.includes('big/part0.txt:1: needle line'), true);
});

test('an unknown tool name returns a fixed message without failing the loop', async (t) => {
  const { mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'remove_file', { path: 'src/alpha.mjs' })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs:1-1' })]),
  ]));

  const result = await tool.execute({ search_string: QUERY });
  const output = toolResults(mock.state.requests[1].body.messages)[0].content;
  assert.equal(output, 'error: unknown tool');
  assert.equal(result.files[0].path, 'src/alpha.mjs');
});

test('a file named like an excluded folder is not searched by the walk', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle' })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs' })]),
  ]));
  const names = ['.git', 'node_modules', 'dist', 'build', 'out', '.next'];
  for (const name of names) {
    await writeFile(path.join(root, name), 'needle in a file named ' + name + '\n', 'utf8');
  }
  await tool.execute({ search_string: QUERY });
  const hit = toolResults(mock.state.requests[1].body.messages)[0].content;
  assert.match(hit, /src\/alpha\.mjs/);
  assert.equal(hit.includes('a file named'), false);
});

test('a finish with repeated ranges over a one-line file fails closed as result-too-large', async (t) => {
  const ranges = Array.from({ length: 60 }, () => '1-1').join(',');
  const { root, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'finish', { files: 'src/one.mjs:' + ranges })]),
  ]));
  await writeFile(path.join(root, 'src', 'one.mjs'), 'z'.repeat(1024 * 1024), 'utf8');
  const started = globalThis.Date.now();
  await rejection(tool.execute({ search_string: QUERY }), 'result-too-large');
  assert.equal(globalThis.Date.now() - started < 2000, true, 'the finish must stop at its budget');
});

test('a provider answer with a throwing accessor fails closed as invalid-response', async () => {
  const answer = {};
  Object.defineProperty(answer, 'text', { enumerable: true, get() { throw new Error('GETTER_BOOM'); } });
  Object.defineProperty(answer, 'toolCalls', { enumerable: true, value: [] });
  const custom = createMorphWarpGrepTool({
    client: { chat: async () => answer },
    workspaceRoot: os.tmpdir(),
  });
  await assert.rejects(custom.execute({ search_string: QUERY }), (error) => {
    assert.equal(error.code, 'invalid-response');
    assert.equal(error.message.includes('GETTER_BOOM'), false);
    return true;
  });
});

test('a grep that stops before any match reports no matches (truncated)', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'grep_search', { pattern: 'needle', path: 'big' })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs:1-1' })]),
  ]));
  await mkdir(path.join(root, 'big'), { recursive: true });
  for (let index = 0; index < 9; index += 1) {
    await writeFile(path.join(root, 'big', 'part' + index + '.txt'), 'x'.repeat(950000), 'utf8');
  }

  await tool.execute({ search_string: QUERY });
  const output = toolResults(mock.state.requests[1].body.messages)[0].content;
  assert.equal(output, 'no matches (truncated)');
});

test('read returns the head of a single over-long line instead of only (truncated)', async (t) => {
  const { root, mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('call-1', 'read', { path: 'src/wide.txt' })]),
    chatPayload('', [toolCall('call-2', 'finish', { files: 'src/alpha.mjs:1-1' })]),
  ]));
  await writeFile(path.join(root, 'src', 'wide.txt'), 'w'.repeat(40000), 'utf8');

  await tool.execute({ search_string: QUERY });
  const output = toolResults(mock.state.requests[1].body.messages)[0].content;
  assert.equal(output.startsWith('1| ' + 'w'.repeat(10)), true, 'the head of the long line must be returned');
  assert.equal(output.endsWith('\n(truncated)'), true);
  assert.equal(output.length, MAX_TOOL_OUTPUT_CHARS + '\n(truncated)'.length);
});

function scriptClient(steps) {
  const state = { requests: [] };
  const client = {
    chat: async (input) => {
      state.requests.push(input);
      const step = steps[Math.min(state.requests.length - 1, steps.length - 1)];
      const payload = typeof step === 'function' ? step(input) : step;
      const message = payload.choices[0].message;
      return {
        text: message.content ?? '',
        toolCalls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
        usage: { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens },
      };
    },
  };
  return { state: state, client: client };
}

test('glob, directory listing, repo structure and the turn counter follow the trained loop', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'src', 'alpha.mjs'), ALPHA, 'utf8');
  const { state, client } = scriptClient([
    chatPayload('', [toolCall('c1', 'glob', { pattern: 'src/**/*.mjs', limit: 10 })]),
    chatPayload('', [toolCall('c2', 'list_directory', { path: '.' })]),
    chatPayload('', [toolCall('c3', 'finish', { files: 'src/alpha.mjs:2-2' })]),
  ]);
  const tool = createMorphWarpGrepTool({ client, workspaceRoot: root });
  const result = await tool.execute({ search_string: QUERY });
  const firstUser = state.requests[0].messages[1].content;
  assert.equal(firstUser.includes('<repo_structure>'), true);
  assert.equal(firstUser.includes(root), false);
  assert.equal(firstUser.includes('src/'), true);
  assert.equal(firstUser.includes(QUERY), true);
  const globResult = toolResults(state.requests[1].messages)[0].content;
  assert.match(globResult, /src\/alpha\.mjs/);
  const listResult = toolResults(state.requests[2].messages)[1].content;
  assert.match(listResult, /src\//);
  const counted = state.requests[1].messages.some((message) => message.role === 'user' &&
    /You have used 1 turn\(s\) and have 5 turn\(s\) remaining\./.test(message.content));
  assert.equal(counted, true);
  assert.equal(result.files[0].path, 'src/alpha.mjs');
});

test('an absolute finish path inside the workspace is accepted and alternation matches', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'src', 'alpha.mjs'), ALPHA, 'utf8');
  const absolute = path.join(root, 'src', 'alpha.mjs');
  const { state, client } = scriptClient([
    chatPayload('', [toolCall('c1', 'grep_search', { pattern: 'needle|absent', output_lines: 20 })]),
    chatPayload('', [toolCall('c2', 'finish', { files: absolute + ':2-2' })]),
  ]);
  const tool = createMorphWarpGrepTool({ client, workspaceRoot: root });
  const result = await tool.execute({ search_string: QUERY });
  const grepResult = toolResults(state.requests[1].messages)[0].content;
  assert.match(grepResult, /src\/alpha\.mjs:2:/);
  assert.equal(result.files[0].path, 'src/alpha.mjs');

  const outside = path.join(root, '..', 'outside-absolute.mjs');
  const second = scriptClient([chatPayload('', [toolCall('c1', 'finish', { files: outside })])]);
  const outsideTool = createMorphWarpGrepTool({ client: second.client, workspaceRoot: root });
  await rejection(outsideTool.execute({ search_string: QUERY }), 'invalid-finish');
});

test('the penultimate turn tells the model to finish', async (t) => {
  const { mock, tool } = await fixture(t, scripted([
    chatPayload('', [toolCall('c1', 'grep_search', { pattern: 'needle' })]),
  ]));
  await rejection(tool.execute({ search_string: QUERY }), 'turn-limit');
  const lastRound = mock.state.requests[MAX_TURNS - 1].body.messages;
  const lastUser = lastRound[lastRound.length - 1];
  assert.equal(lastUser.role, 'user');
  assert.match(lastUser.content, /MUST call the finish tool now/);
});

test('a string case_sensitive is accepted and unknown read arguments are ignored', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'src', 'alpha.mjs'), ALPHA, 'utf8');
  const { state, client } = scriptClient([
    chatPayload('', [toolCall('c1', 'grep_search', { pattern: 'NEEDLE', case_sensitive: 'false' })]),
    chatPayload('', [toolCall('c2', 'grep_search', { pattern: 'NEEDLE', case_sensitive: 'true' })]),
    chatPayload('', [toolCall('c3', 'grep_search', { pattern: 'needle', case_sensitive: 'maybe' })]),
    chatPayload('', [toolCall('c4', 'read', { path: 'src/alpha.mjs', lines: '2-2', offset: 9, include_meta: true })]),
    chatPayload('', [toolCall('c5', 'finish', { files: 'src/alpha.mjs:2-2' })]),
  ]);
  const tool = createMorphWarpGrepTool({ client, workspaceRoot: root });
  const result = await tool.execute({ search_string: QUERY });
  assert.match(toolResults(state.requests[1].messages)[0].content, /src\/alpha\.mjs:2:/);
  assert.equal(toolResults(state.requests[2].messages)[1].content, 'no matches');
  assert.equal(toolResults(state.requests[3].messages)[2].content, 'error: grep_search case_sensitive is invalid');
  assert.equal(toolResults(state.requests[4].messages)[3].content, '2| export const needle = "alpha";');
  assert.equal(result.files[0].path, 'src/alpha.mjs');
});

test('credential-shaped files are never searched, read or finished', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, '.env'), 'needle=' + 'SECRETVALUE' + '\n', 'utf8');
  await writeFile(path.join(root, 'server.pem'), 'needle PEM CONTENT\n', 'utf8');
  await writeFile(path.join(root, 'src', 'alpha.mjs'), ALPHA, 'utf8');
  const { state, client } = scriptClient([
    chatPayload('', [toolCall('c1', 'grep_search', { pattern: 'needle' })]),
    chatPayload('', [toolCall('c2', 'read', { path: '.env' })]),
    chatPayload('', [toolCall('c3', 'finish', { files: '.env' })]),
  ]);
  const tool = createMorphWarpGrepTool({ client, workspaceRoot: root });
  await rejection(tool.execute({ search_string: QUERY }), 'invalid-finish');
  const grepResult = toolResults(state.requests[1].messages)[0].content;
  assert.equal(grepResult.includes('SECRETVALUE'), false);
  assert.equal(grepResult.includes('PEM CONTENT'), false);
  const readResult = toolResults(state.requests[2].messages)[1].content;
  assert.match(readResult, /^error: /);
});

test('a case-variant of an excluded name is excluded on a case-insensitive filesystem', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, '.GIT'), { recursive: true });
  await writeFile(path.join(root, '.GIT', 'config'), 'needle REMOTETOKEN\n', 'utf8');
  await writeFile(path.join(root, 'DIST'), 'needle BUILD\n', 'utf8');
  await writeFile(path.join(root, 'src', 'alpha.mjs'), ALPHA, 'utf8');
  const { state, client } = scriptClient([
    chatPayload('', [toolCall('c1', 'grep_search', { pattern: 'needle' })]),
    chatPayload('', [toolCall('c2', 'read', { path: '.GIT/config' })]),
    chatPayload('', [toolCall('c3', 'list_directory', { path: '.' })]),
    chatPayload('', [toolCall('c3b', 'glob', { pattern: '**/*' })]),
    chatPayload('', [toolCall('c4', 'finish', { files: 'src/alpha.mjs' })]),
    chatPayload('', [toolCall('c5', 'finish', { files: 'src/alpha.mjs' })]),
  ]);
  const tool = createMorphWarpGrepTool({ client, workspaceRoot: root });
  const result = await tool.execute({ search_string: QUERY });
  const grepResult = toolResults(state.requests[1].messages)[0].content;
  assert.equal(grepResult.includes('REMOTETOKEN'), false);
  assert.equal(grepResult.includes('needle BUILD'), false);
  const readResult = toolResults(state.requests[2].messages)[1].content;
  assert.match(readResult, /^error: /);
  const listing = toolResults(state.requests[3].messages)[2].content;
  assert.equal(listing.includes('.GIT'), false);
  assert.equal(listing.includes('DIST'), false);
  const globbed = toolResults(state.requests[4].messages)[3].content;
  assert.equal(globbed.includes('.GIT'), false);
  assert.equal(globbed.includes('DIST'), false);
  const { client: strictClient } = scriptClient([chatPayload('', [toolCall('f1', 'finish', { files: '.GIT/config' })])]);
  const strictTool = createMorphWarpGrepTool({ client: strictClient, workspaceRoot: root });
  await rejection(strictTool.execute({ search_string: QUERY }), 'invalid-finish');
  assert.equal(result.files[0].path, 'src/alpha.mjs');
});
