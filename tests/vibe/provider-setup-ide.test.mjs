import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { access, mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const appPath = process.env.VIBECODIUM_APP_PATH;
const extensionPath = path.resolve('src/stable/extensions/vibecodium-ai');
const runnerPath = path.resolve('src/stable/extensions/vibecodium-ai/src/provider-setup-ide-runner.test.cjs');
const MAX_REPORT = 8_000;
const SECRET = 'test-only-provider-panel-secret-0001';
const SCANNER_CONTROL = 'test-only-scanner-positive-control-0002';

function tail(text) {
  return text.length > MAX_REPORT ? text.slice(-MAX_REPORT) : text;
}

function scanForSecret(root) {
  const hits = [];
  const skipped = [];
  let files = 0;
  let bytes = 0;
  const needles = [SECRET, SCANNER_CONTROL].map((value) => Buffer.from(value, 'utf8'));
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      skipped.push(directory);
      continue;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile()) {
        files += 1;
        try {
          const content = readFileSync(target);
          bytes += content.byteLength;
          if (needles.some((needle) => content.includes(needle))) hits.push(target);
        } catch {
          skipped.push(target);
        }
      }
    }
  }
  return { hits, skipped, files, bytes };
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

test('the provider setup panel adds, switches, stores a secret and keeps it out of the profile files', {
  skip: appPath ? false : 'set VIBECODIUM_APP_PATH to a built Vibecodium.exe or an installed VS Code Code.exe',
  timeout: 120_000,
}, async () => {
  await access(appPath);
  const appInfo = await stat(appPath);
  assert.ok(appInfo.isFile(), 'VIBECODIUM_APP_PATH must point at an executable file');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vibecodium-provider-host-'));
  const controlPath = path.join(temporary, 'scanner-positive-control.bin');
  writeFileSync(controlPath, Buffer.concat([
    Buffer.from('profile-prefix'),
    Buffer.from(SCANNER_CONTROL),
    Buffer.from('profile-suffix'),
  ]));
  try {
    const result = await runExtensionHost([
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--disable-telemetry',
      '--disable-experiments',
      '--disable-workspace-trust',
      '--disable-extensions',
      '--disable-extension', 'vscode.git',
      '--disable-extension', 'vscode.github-authentication',
      '--disable-extension', 'vscode.github',
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
    assert.match(result.stdout, /PROVIDER_SETUP_IDE_OK/, `extension host did not run the provider setup test\n${tail(result.stdout)}\n${tail(result.stderr)}`);
    assert.ok(!result.stdout.includes(SECRET), 'the extension host output never contains the credential');
    assert.ok(!result.stderr.includes(SECRET), 'the extension host error output never contains the credential');
    const scan = scanForSecret(temporary);
    const stockAskpass = /[\\/]data[\\/]User[\\/]globalStorage[\\/]vscode\.git[\\/]askpass[\\/][^\\/]+$/;
    const unexpected = scan.skipped.filter((file) => !stockAskpass.test(file));
    assert.equal(unexpected.length, 0, 'only stock host ACL files are unreadable: ' + unexpected.join(', '));
    assert.ok(scan.skipped.every((file) => stockAskpass.test(file)), 'no unexpected unreadable profile file');
    assert.ok(scan.hits.includes(controlPath), 'the profile scan detects its planted positive control');
    assert.equal(
      scan.hits.filter((file) => file !== controlPath).length,
      0,
      'no profile file contains the credential: ' + scan.hits.join(', '),
    );
    assert.ok(scan.files > 0, 'the scan covered the throwaway profile');
    assert.ok(scan.bytes > 0, 'the scan read profile bytes');
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
