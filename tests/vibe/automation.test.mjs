import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const PWSH = has('pwsh');
// On Windows use Git Bash explicitly; a bare "bash" may resolve to WSL.
const GIT_BASH = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const BASH_CMD = process.platform === 'win32' ? GIT_BASH : 'bash';
const BASH = process.platform === 'win32' ? existsSync(GIT_BASH) : has('bash');
const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

test('CI workflow: no default permissions, actions pinned by SHA, no persisted credentials', () => {
  const wf = read('.github/workflows/vibe-governance.yml');
  assert.match(wf, /^permissions: \{\}$/m);
  const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} must be pinned to a commit SHA`);
  assert.match(wf, /persist-credentials: false/);
  assert.match(wf, /node vibe\/tools\/verify\.mjs/);
});

test('goal runner: sandboxed, secrets removed, governance-gated, no raw event logs', () => {
  const s = read('vibe/goal/run-goal.ps1');
  assert.match(s, /'-s', 'workspace-write'/);
  assert.doesNotMatch(s, /danger-full-access/);
  assert.doesNotMatch(s, /'--json'/);
  assert.match(s, /sandbox_workspace_write\.writable_roots=/);
  assert.match(s, /Remove-Item -LiteralPath "Env:/);
  assert.ok(s.indexOf('governance.mjs') < s.indexOf('$p = Start-Process'), 'governance check must run before Codex starts');
  assert.match(s, /AddDays\(-14\)/);
});

test('task registration: hidden, headless, low priority, validates the checkout', () => {
  const s = read('vibe/goal/Register-GoalRunner.ps1');
  for (const needle of ['--headless', '-WindowStyle Hidden', '-NonInteractive', 'New-ScheduledTaskSettingsSet -Hidden', '-Priority 7', 'ynotfins/vibecodium', "-ne 'vibe/main'", 'governance.mjs']) {
    assert.ok(s.includes(needle), `missing: ${needle}`);
  }
});

test('PowerShell scripts parse without errors', { skip: !PWSH && 'pwsh not available' }, () => {
  for (const rel of ['vibe/goal/run-goal.ps1', 'vibe/goal/Register-GoalRunner.ps1', '.codex/validate.ps1']) {
    const file = path.join(ROOT, rel);
    const cmd = `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$null,[ref]$e); $e.Count`;
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '0', `${rel}: ${r.stdout}${r.stderr}`);
  }
});

test('goal runner dry run removes secrets and confines writes', { skip: (process.platform !== 'win32' || !PWSH) && 'Windows + pwsh only' }, () => {
  const fx = mkdtempSync(path.join(tmpdir(), 'vibe-runner-'));
  cleanup.push(fx, `${fx}.worktrees`);
  for (const rel of ['vibe/tools', 'vibe/goal', '.vibe/governance', '.vibe/agents']) cpSync(path.join(ROOT, rel), path.join(fx, rel), { recursive: true });
  for (const rel of ['AGENTS.md', 'docs/vibe/VISION.md', 'docs/vibe/PRODUCT_SPEC.md', 'docs/vibe/ARCHITECTURE.md', 'docs/vibe/GOVERNANCE.md', '.github/workflows/vibe-governance.yml']) {
    mkdirSync(path.dirname(path.join(fx, rel)), { recursive: true });
    cpSync(path.join(ROOT, rel), path.join(fx, rel));
  }
  writeFileSync(path.join(fx, 'docs/vibe/STATUS.md'), 'Goal state: active\n');
  const logs = path.join(fx, 'logs');
  const env = { ...process.env, FAKE_TEST_API_KEY: 'not-a-real-secret-123', VIBECODIUM_GH_TOKEN: 'scoped-test-token-456' };
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(fx, 'vibe/goal/run-goal.ps1'), '-Root', fx, '-LogDir', logs, '-Codex', 'codex-not-started', '-DryRun'], { encoding: 'utf8', env });
  const out = r.stdout + r.stderr;
  assert.match(out, /DRYRUN args=.*-s workspace-write/, out);
  assert.ok(out.includes(`${fx.replace(/\\/g, '/')}.worktrees`), 'task worktree folder must be a writable root');
  assert.match(out, /secret_vars_left=0 /);
  assert.match(out, /gh_token_scoped=True/);
  assert.doesNotMatch(out, /not-a-real-secret-123|scoped-test-token-456/);
});

test('build preflight reports every tool and an overall verdict', { skip: !BASH && 'bash not available' }, () => {
  const r = spawnSync(BASH_CMD, [path.join(ROOT, 'vibe/dev/preflight.sh')], { encoding: 'utf8' });
  for (const tool of ['node', 'python', 'jq', 'git', 'cargo', '7z']) assert.match(r.stdout, new RegExp(`^(PASS|FAIL)\\s+${tool}\\s`, 'm'));
  assert.match(r.stdout, /^PREFLIGHT: (PASS|FAIL)$/m);
});
