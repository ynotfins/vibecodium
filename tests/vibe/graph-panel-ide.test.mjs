import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { access, mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const appPath = process.env.VIBECODIUM_APP_PATH;
const extensionPath = path.resolve('src/stable/extensions/vibecodium-ai');
const runnerPath = path.resolve('src/stable/extensions/vibecodium-ai/src/graph-panel-ide-runner.test.cjs');
const MAX_REPORT = 8_000;

function tail(text) {
  return text.length > MAX_REPORT ? text.slice(-MAX_REPORT) : text;
}

function runExtensionHost(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(appPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const capture = (current, chunk) => (current + chunk.toString('utf8')).slice(-200_000);
    child.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk); });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`extension host timed out after ${timeoutMs}ms\n${tail(stdout)}\n${tail(stderr)}`));
    }, timeoutMs);
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, signal, stdout, stderr });
    };
    child.on('exit', finish);
    child.on('close', finish);
  });
}

test('the graph panel renders in a real extension host and opens source', {
  skip: appPath ? false : 'set VIBECODIUM_APP_PATH to a built Vibecodium.exe',
  timeout: 120_000,
}, async () => {
  await access(appPath);
  const appInfo = await stat(appPath);
  assert.ok(appInfo.isFile(), 'VIBECODIUM_APP_PATH must point at an executable file');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vibecodium-graph-host-'));
  try {
    const result = await runExtensionHost([
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--disable-telemetry',
      '--disable-experiments',
      '--disable-workspace-trust',
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-cached-data',
      '--use-inmemory-secretstorage',
      `--extensionTestsPath=${runnerPath}`,
      `--extensionDevelopmentPath=${extensionPath}`,
      `--user-data-dir=${path.join(temporary, 'data')}`,
      `--extensions-dir=${path.join(temporary, 'extensions')}`,
      '--disable-gpu',
    ], 90_000);
    assert.equal(
      result.code,
      0,
      `extension host exited ${result.code} (${result.signal || 'no signal'})\n${tail(result.stdout)}\n${tail(result.stderr)}`,
    );
    assert.match(result.stdout, /GRAPH_PANEL_IDE_OK/, `extension host did not run the graph panel test\n${tail(result.stdout)}\n${tail(result.stderr)}`);
  } finally {
    const temporaryRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(temporary);
    if (resolved.startsWith(temporaryRoot + path.sep)) {
      try {
        rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      } catch {}
    }
  }
});
