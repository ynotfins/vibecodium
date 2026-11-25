import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MAX_MESSAGE_CHARS, createProviderClient } from '../../src/stable/gateway/provider-client.mjs';
import {
  EDIT_FILE_TOOL,
  FAST_APPLY_MODEL,
  FastApplyError,
  MAX_EDIT_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_RESULT_BYTES,
  MAX_SOURCE_BYTES,
  MORPH_FAST_APPLY_VERSION,
  createMorphFastApplyTool,
  describeMorphFastApply,
} from '../../src/stable/gateway/morph-fast-apply.mjs';

const HOST = 'localhost';
const SECRET = ['sk', 'morph', 'acceptance', 'do', 'not', 'leak'].join('-');
const SOURCE = 'export const value = 1;\n';
const MERGED = 'export const value = 2;\n';
const EDIT = '// ... existing code ...\nexport const value = 2;\n// ... existing code ...\n';
const INSTRUCTIONS = 'Bump the value to two.';

function promptFor(instruction, source, edit) {
  return '<instruction>' + instruction + '</instruction>\n<code>' + source + '</code>\n<update>' + edit + '</update>';
}

function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  });
  response.end(body);
}

function chatPayload(content) {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  };
}

async function startMock(t, handler = () => chatPayload(MERGED)) {
  const state = { requests: [] };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    state.requests.push({ url: request.url, headers: request.headers, body });
    const outcome = await handler({ body, state, response, request });
    if (outcome === false) return;
    sendJson(response, outcome ?? chatPayload(MERGED));
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, port: server.address().port };
}

function clientFor(port) {
  return createProviderClient('morph', {
    baseUrl: 'http://' + HOST + ':' + port + '/v1',
    model: FAST_APPLY_MODEL,
    apiKey: SECRET,
    env: {},
    timeoutMs: 5000,
  });
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibe-fast-apply-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, handler) {
  const root = await workspace(t);
  const mock = await startMock(t, handler);
  const tool = createMorphFastApplyTool({ client: clientFor(mock.port), workspaceRoot: root });
  return { root, mock, tool };
}

test('the public definition and describe surface are exact and immutable', () => {
  assert.equal(MORPH_FAST_APPLY_VERSION, 1);
  assert.equal(FAST_APPLY_MODEL, 'morph-v3-fast');
  assert.equal(EDIT_FILE_TOOL.type, 'function');
  assert.equal(EDIT_FILE_TOOL.function.name, 'edit_file');
  assert.deepEqual([...EDIT_FILE_TOOL.function.parameters.required], ['target_file', 'code_edit', 'instructions']);
  assert.equal(EDIT_FILE_TOOL.function.parameters.additionalProperties, false);
  assert.equal(Object.isFrozen(EDIT_FILE_TOOL), true);
  assert.equal(Object.isFrozen(EDIT_FILE_TOOL.function.parameters.properties.target_file), true);
  assert.throws(() => { EDIT_FILE_TOOL.function.name = 'changed'; }, TypeError);
  assert.deepEqual(describeMorphFastApply(), {
    version: MORPH_FAST_APPLY_VERSION,
    name: 'edit_file',
    model: FAST_APPLY_MODEL,
    maxSourceBytes: MAX_SOURCE_BYTES,
    maxEditChars: MAX_EDIT_CHARS,
    maxInstructionChars: MAX_INSTRUCTION_CHARS,
    maxResultBytes: MAX_RESULT_BYTES,
  });
  assert.equal(Object.isFrozen(describeMorphFastApply()), true);
});

test('edit_file reads, sends one Fast Apply request and atomically replaces the file', async (t) => {
  const { root, mock, tool } = await fixture(t);
  const target = path.join(root, 'src', 'value.mjs');
  await writeFile(target, SOURCE, 'utf8');

  const result = await tool.execute({ target_file: 'src/value.mjs', code_edit: EDIT, instructions: INSTRUCTIONS });
  assert.equal((await readFile(target, 'utf8')), MERGED);
  assert.equal(mock.state.requests.length, 1);
  const request = mock.state.requests[0];
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer ' + SECRET);
  assert.equal(request.body.model, FAST_APPLY_MODEL);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.messages.length, 1);
  assert.equal(request.body.messages[0].role, 'user');
  assert.equal(request.body.messages[0].content, promptFor(INSTRUCTIONS, SOURCE, EDIT));
  assert.deepEqual(result, {
    targetFile: 'src/value.mjs',
    changed: true,
    bytesWritten: Buffer.byteLength(MERGED, 'utf8'),
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.usage), true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(SOURCE), false);
  assert.equal(serialized.includes(EDIT), false);
  assert.equal(serialized.includes(INSTRUCTIONS), false);
});

test('an identical merge is unchanged and does not rewrite the file', async (t) => {
  const { root, tool } = await fixture(t, () => chatPayload(SOURCE));
  const target = path.join(root, 'same.mjs');
  await writeFile(target, SOURCE, 'utf8');
  const before = await stat(target);
  const result = await tool.execute({ target_file: 'same.mjs', code_edit: EDIT, instructions: 'No change' });
  assert.equal(result.changed, false);
  assert.equal(result.bytesWritten, 0);
  assert.equal((await readFile(target, 'utf8')), SOURCE);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
});

test('provider, empty, malformed and oversized responses fail closed without leaking', async (t) => {
  const cases = [
    ['provider-error', async ({ response }) => { sendJson(response, { error: 'body-secret' }, 500); return false; }],
    ['empty-result', () => chatPayload('')],
    ['invalid-result', () => chatPayload('before\n\u0000after')],
    ['ill-formed-result', () => chatPayload('before\n\ud800after')],
    ['result-too-large', () => chatPayload('x'.repeat(MAX_RESULT_BYTES + 1))],
  ];
  for (const [code, handler] of cases) {
    const root = await workspace(t);
    const mock = await startMock(t, handler);
    const target = path.join(root, 'failure.mjs');
    await writeFile(target, SOURCE, 'utf8');
    const tool = createMorphFastApplyTool({ client: clientFor(mock.port), workspaceRoot: root });
    await assert.rejects(
      tool.execute({ target_file: 'failure.mjs', code_edit: EDIT, instructions: INSTRUCTIONS }),
      (error) => {
        assert.equal(error instanceof FastApplyError, true, code);
        assert.equal(error.code, code);
        const text = String(error.message) + ' ' + JSON.stringify(error);
        for (const forbidden of [SECRET, 'body-secret', SOURCE, EDIT, INSTRUCTIONS]) {
          assert.equal(text.includes(forbidden), false, code + ' leaked ' + forbidden);
        }
        return true;
      },
      code,
    );
    assert.equal(await readFile(target, 'utf8'), SOURCE, code);
  }
});

test('target paths stay inside the workspace and reject symlinks and missing files', async (t) => {
  const { root, mock, tool } = await fixture(t);
  await mkdir(path.join(root, 'folder'), { recursive: true });
  const target = path.join(root, 'inside.mjs');
  await writeFile(target, SOURCE, 'utf8');
  const inputs = [
    path.join(root, 'inside.mjs'),
    'C:\\Windows\\win.ini',
    '\\\\server\\share\\file.mjs',
    '../outside.mjs',
    'folder/../../outside.mjs',
    '%2e%2e%2foutside.mjs',
    'folder',
    'missing.mjs',
    './inside.mjs',
    'folder//inside.mjs',
  ];
  for (const targetFile of inputs) {
    await assert.rejects(
      tool.execute({ target_file: targetFile, code_edit: EDIT, instructions: INSTRUCTIONS }),
      (error) => error instanceof FastApplyError && ['invalid-target', 'target-not-found', 'not-a-file'].includes(error.code),
      targetFile,
    );
  }
  assert.equal(mock.state.requests.length, 0);

  const link = path.join(root, 'link.mjs');
  try {
    await symlink(target, link);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlink creation is not permitted');
    throw error;
  }
  await assert.rejects(
    tool.execute({ target_file: 'link.mjs', code_edit: EDIT, instructions: INSTRUCTIONS }),
    (error) => error instanceof FastApplyError && error.code === 'unsafe-target',
  );
  assert.equal(mock.state.requests.length, 0);
});

test('a file changed while Fast Apply runs is never overwritten', async (t) => {
  const root = await workspace(t);
  const target = path.join(root, 'race.mjs');
  const replacement = 'export const value = 99;\n';
  const mock = await startMock(t, async () => {
    await writeFile(target, replacement, 'utf8');
    return chatPayload(MERGED);
  });
  await writeFile(target, SOURCE, 'utf8');
  const tool = createMorphFastApplyTool({ client: clientFor(mock.port), workspaceRoot: root });
  await assert.rejects(
    tool.execute({ target_file: 'race.mjs', code_edit: EDIT, instructions: INSTRUCTIONS }),
    (error) => error instanceof FastApplyError && error.code === 'file-changed',
  );
  assert.equal(await readFile(target, 'utf8'), replacement);
});

test('a directory junction swapped during the call still writes the validated real target', async (t) => {
  const root = await workspace(t);
  const realDirectory = path.join(root, 'real');
  const alternateDirectory = path.join(root, 'alternate');
  const alias = path.join(root, 'alias');
  const alternateSource = 'export const value = 99;\n';
  await mkdir(realDirectory);
  await mkdir(alternateDirectory);
  await writeFile(path.join(realDirectory, 'value.mjs'), SOURCE, 'utf8');
  await writeFile(path.join(alternateDirectory, 'value.mjs'), alternateSource, 'utf8');
  try {
    await symlink(realDirectory, alias, 'junction');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('directory junction creation is not permitted');
    throw error;
  }
  const mock = await startMock(t, async () => {
    await unlink(alias);
    await symlink(alternateDirectory, alias, 'junction');
    return chatPayload(MERGED);
  });
  const tool = createMorphFastApplyTool({ client: clientFor(mock.port), workspaceRoot: root });
  const result = await tool.execute({ target_file: 'alias/value.mjs', code_edit: EDIT, instructions: INSTRUCTIONS });
  assert.equal(result.targetFile, 'alias/value.mjs');
  assert.equal(result.changed, true);
  assert.equal(await readFile(path.join(realDirectory, 'value.mjs'), 'utf8'), MERGED);
  assert.equal(await readFile(path.join(alternateDirectory, 'value.mjs'), 'utf8'), alternateSource);
});

test('malformed creation and execution inputs fail closed without invoking accessors', async (t) => {
  const { root, mock, tool } = await fixture(t);
  const target = path.join(root, 'bad.mjs');
  await writeFile(target, SOURCE, 'utf8');
  const base = { target_file: 'bad.mjs', code_edit: EDIT, instructions: INSTRUCTIONS };
  let touched = false;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'code_edit', { enumerable: true, get() { touched = true; return EDIT; } });
  const sparse = { ...base, extra: [] };
  const sparseArray = [];
  sparseArray[3] = base;

  for (const input of [undefined, null, [], sparseArray, { ...base, extra: true }, sparse, accessor]) {
    await assert.rejects(
      tool.execute(input),
      (error) => error instanceof FastApplyError && /^invalid-/.test(error.code),
    );
  }
  for (const overrides of [
    { target_file: '' }, { target_file: 'a\0b' }, { target_file: 'a\nb' },
    { code_edit: '' }, { code_edit: 'x\u0000y' }, { code_edit: 'x'.repeat(MAX_EDIT_CHARS + 1) },
    { instructions: '' }, { instructions: 'x'.repeat(MAX_INSTRUCTION_CHARS + 1) },
    { target_file: 7 }, { code_edit: null }, { instructions: {} },
  ]) {
    await assert.rejects(
      tool.execute({ ...base, ...overrides }),
      (error) => error instanceof FastApplyError && /^invalid-/.test(error.code),
    );
  }
  assert.equal(touched, false);

  const badOptions = [
    undefined,
    null,
    { client: clientFor(mock.port), workspaceRoot: root, extra: true },
    { client: clientFor(mock.port), workspaceRoot: 'relative' },
  ];
  for (const options of badOptions) assert.throws(() => createMorphFastApplyTool(options), FastApplyError);
  let optionTouched = false;
  const optionAccessor = { client: clientFor(mock.port) };
  Object.defineProperty(optionAccessor, 'workspaceRoot', { enumerable: true, get() { optionTouched = true; return root; } });
  assert.throws(() => createMorphFastApplyTool(optionAccessor), FastApplyError);
  assert.equal(optionTouched, false);

  await writeFile(target, Buffer.from([0x76, 0x61, 0x6c, 0x75, 0x65, 0x00, 0x0a]));
  await assert.rejects(
    tool.execute({ target_file: 'bad.mjs', code_edit: EDIT, instructions: INSTRUCTIONS }),
    (error) => error instanceof FastApplyError && error.code === 'binary-source',
  );
  await writeFile(target, Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61));
  await assert.rejects(
    tool.execute({ target_file: 'bad.mjs', code_edit: EDIT, instructions: INSTRUCTIONS }),
    (error) => error instanceof FastApplyError && error.code === 'source-too-large',
  );
  assert.equal(mock.state.requests.length, 0);
});

test('an assembled prompt above the provider message cap fails as a bounded input error', async (t) => {
  const { root, mock, tool } = await fixture(t);
  const target = path.join(root, 'big.mjs');
  const source = 'a'.repeat(MAX_MESSAGE_CHARS - 10000) + '\n';
  const edit = 'b'.repeat(20000);
  await writeFile(target, source, 'utf8');
  await assert.rejects(
    tool.execute({ target_file: 'big.mjs', code_edit: edit, instructions: INSTRUCTIONS }),
    (error) => error instanceof FastApplyError && error.code === 'prompt-too-large',
  );
  assert.equal(mock.state.requests.length, 0);
  assert.equal(await readFile(target, 'utf8'), source);
});

test('a malformed client answer fails closed as invalid-response without writing', async (t) => {
  const root = await workspace(t);
  const target = path.join(root, 'malformed-answer.mjs');
  await writeFile(target, SOURCE, 'utf8');
  for (const answer of [null, {}, { text: 7 }, { text: null }]) {
    let calls = 0;
    const client = { chat: async () => { calls += 1; return answer; } };
    const tool = createMorphFastApplyTool({ client, workspaceRoot: root });
    await assert.rejects(
      tool.execute({ target_file: 'malformed-answer.mjs', code_edit: EDIT, instructions: INSTRUCTIONS }),
      (error) => {
        assert.equal(error instanceof FastApplyError, true);
        assert.equal(error.code, 'invalid-response');
        const text = String(error.message) + ' ' + JSON.stringify(error);
        for (const forbidden of [SECRET, SOURCE, EDIT, INSTRUCTIONS]) {
          assert.equal(text.includes(forbidden), false, 'invalid-response leaked ' + forbidden);
        }
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(await readFile(target, 'utf8'), SOURCE);
  }
});
