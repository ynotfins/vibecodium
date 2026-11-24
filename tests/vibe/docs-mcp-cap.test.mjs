import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_STDIO_MESSAGE_BYTES,
  MAX_STDIO_REQUEST_BYTES,
} from '../../src/stable/docs-mcp/mcp-server.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'stable', 'docs-mcp', 'server.mjs');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'vibe', 'fixtures', 'docs-mcp', 'guides');

test('a near-limit request id cannot make a response line exceed the cap', () => {
  const base = JSON.stringify({ jsonrpc: '2.0', id: '', method: 'missing/method' });
  const id = 'A'.repeat(MAX_STDIO_REQUEST_BYTES - Buffer.byteLength(base, 'utf8'));
  const request = JSON.stringify({ jsonrpc: '2.0', id, method: 'missing/method' });
  assert.equal(Buffer.byteLength(request, 'utf8'), MAX_STDIO_REQUEST_BYTES);

  const child = spawnSync(process.execPath, [
    SERVER_PATH,
    '--root', 'guides=' + FIXTURE_ROOT,
  ], {
    input: request + '\n',
    encoding: 'utf8',
    maxBuffer: 8_000_000,
    timeout: 5_000,
  });

  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.endsWith('\n'));
  const response = child.stdout.slice(0, -1);
  const responseBytes = Buffer.byteLength(response, 'utf8');
  const message = JSON.parse(response);
  assert.equal(message.id, null);
  assert.equal(message.error.code, -32603);
  assert.match(message.error.message, /response exceeds/);
  assert.ok(
    responseBytes <= MAX_STDIO_MESSAGE_BYTES,
    'response line is ' + responseBytes + ' bytes, above the ' + MAX_STDIO_MESSAGE_BYTES + '-byte cap',
  );
});
