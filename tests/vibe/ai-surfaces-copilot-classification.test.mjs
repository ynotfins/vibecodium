import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { classifyCopilotExtensions } = require('../../src/stable/extensions/vibecodium-ai/src/copilot-extensions.cjs');

const USER_DIR = path.join('C:', 'Users', 'u', 'profile', 'extensions');
const HOST_DIR = path.join('C:', 'Program Files', 'Microsoft VS Code', 'resources', 'app', 'extensions');
const HOST_COPILOT = path.join(HOST_DIR, 'copilot');

test('a user-installed Copilot extension is reported', () => {
  const result = classifyCopilotExtensions([
    { id: 'GitHub.copilot-chat', extensionPath: path.join(USER_DIR, 'github.copilot-chat-0.63.0'), isActive: false },
    { id: 'vscode.git', extensionPath: path.join(HOST_DIR, 'git'), isActive: true },
  ], USER_DIR);
  assert.deepEqual(result.copilot.map((entry) => entry.id), ['GitHub.copilot-chat']);
  assert.deepEqual(result.userInstalled.map((entry) => entry.id), ['GitHub.copilot-chat']);
  assert.deepEqual(result.active, []);
  assert.deepEqual(result.activeUserInstalled, []);
});

test('a host bundled Copilot extension is tolerated whether inactive or active', () => {
  const result = classifyCopilotExtensions([
    { id: 'GitHub.copilot-chat', extensionPath: HOST_COPILOT, isActive: false },
  ], USER_DIR);
  assert.deepEqual(result.copilot.map((entry) => entry.id), ['GitHub.copilot-chat']);
  assert.deepEqual(result.userInstalled, []);
  assert.deepEqual(result.active, []);
  assert.deepEqual(result.activeUserInstalled, []);
});

test('an active host built-in Copilot extension is tolerated and reported', () => {
  const result = classifyCopilotExtensions([
    { id: 'GitHub.copilot', extensionPath: HOST_COPILOT, isActive: true },
  ], USER_DIR);
  assert.deepEqual(result.userInstalled, []);
  assert.deepEqual(result.active.map((entry) => entry.id), ['GitHub.copilot']);
  assert.deepEqual(result.activeUserInstalled, []);
});

test('without a user extension directory every Copilot extension is treated as user-installed', () => {
  const result = classifyCopilotExtensions([
    { id: 'GitHub.copilot', extensionPath: HOST_COPILOT, isActive: false },
  ], undefined);
  assert.deepEqual(result.userInstalled.map((entry) => entry.id), ['GitHub.copilot']);
});

test('unrelated and malformed entries are ignored or fail closed', () => {
  const result = classifyCopilotExtensions([
    { id: 'vscode.git', extensionPath: path.join(HOST_DIR, 'git'), isActive: true },
    null,
    { id: 'GitHub.copilot-chat', isActive: false },
  ], USER_DIR);
  assert.deepEqual(result.copilot.map((entry) => entry.id), ['GitHub.copilot-chat']);
  assert.deepEqual(result.userInstalled.map((entry) => entry.id), ['GitHub.copilot-chat']);
});
