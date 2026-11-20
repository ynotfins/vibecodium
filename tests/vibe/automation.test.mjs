import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const WIN_PWSH = (process.platform !== 'win32' || !PWSH) && 'Windows + pwsh only';
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

test('goal runner: OpenCode on our models, isolated config, secrets removed, governance-gated', () => {
  const s = read('vibe/goal/run-goal.ps1');
  assert.ok(s.includes("'--agent', 'vibe-overseer'"), 'must start OpenCode with the overseer agent');
  assert.ok(!/codex/i.test(s), 'the build loop must not use Codex');
  assert.ok(s.includes('$env:XDG_CONFIG_HOME') && s.includes('$env:XDG_DATA_HOME'), 'OpenCode must use its own config and data folders');
  assert.ok(s.includes('Remove-Item -LiteralPath "Env:'), 'secret env vars must be removed');
  assert.ok(s.includes("$AllowedProviderKeys = @('OMNIROUTE_API_KEY', 'MORPH_API_KEY', 'DEEPINFRA_API_KEY')"));
  assert.ok(s.includes("'git push --force*'") && s.includes("'gh release create*'") && s.includes("'gh auth*'"), 'hard-stop commands must be denied');
  assert.ok(s.indexOf('governance.mjs') < s.indexOf('$p = Start-Process'), 'governance check must run before the session starts');
  assert.match(s, /while \(-not \$p\.WaitForExit\(30000\)\) \{\n\s+Set-TreeBelowNormal \$p\.Id/, 'session tree must be kept below normal priority');
  assert.match(s, /Get-FileHash -LiteralPath \$PSCommandPath\)\.Hash -ne \$selfHash/, 'runner must exit when its script changes');
  assert.match(s, /AddDays\(-14\)/);
});

test('model routing: OmniRoute first, Morph second, every class mapped, only allowed keys', () => {
  const m = JSON.parse(read('vibe/goal/models.json'));
  assert.deepEqual(m.order.slice(0, 2), ['omniroute', 'morph']);
  for (const name of m.order) {
    const p = m.providers[name];
    assert.ok(['OMNIROUTE_API_KEY', 'MORPH_API_KEY', 'DEEPINFRA_API_KEY'].includes(p.keyEnv), `${name} key`);
    for (const c of ['strong', 'standard', 'review', 'cheap']) assert.ok(p.classes[c], `${name} must map ${c}`);
  }
  assert.match(m.morphMcpVersion, /^\d+\.\d+\.\d+$/);
});

test('task registration: hidden, headless, low priority, validates the checkout', () => {
  const s = read('vibe/goal/Register-GoalRunner.ps1');
  for (const needle of ['--headless', '-WindowStyle Hidden', '-NonInteractive', 'New-ScheduledTaskSettingsSet -Hidden', '-Priority 7', 'ynotfins/vibecodium', "-ne 'vibe/main'", 'governance.mjs']) {
    assert.ok(s.includes(needle), `missing: ${needle}`);
  }
});

test('PowerShell scripts parse without errors', { skip: !PWSH && 'pwsh not available' }, () => {
  for (const rel of ['vibe/goal/run-goal.ps1', 'vibe/goal/Register-GoalRunner.ps1']) {
    const file = path.join(ROOT, rel);
    const cmd = `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$null,[ref]$e); $e.Count`;
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '0', `${rel}: ${r.stdout}${r.stderr}`);
  }
});

// A throwaway trunk with its own genesis lock over the runner, so these tests exercise the runner
// itself and do not depend on the repository's current lock state.
function runnerFixture() {
  const fx = mkdtempSync(path.join(tmpdir(), 'vibe-runner-'));
  cleanup.push(fx);
  for (const rel of ['vibe/tools', 'vibe/goal', '.vibe/agents']) cpSync(path.join(ROOT, rel), path.join(fx, rel), { recursive: true });
  mkdirSync(path.join(fx, 'docs/vibe'), { recursive: true });
  writeFileSync(path.join(fx, 'docs/vibe/STATUS.md'), 'Goal state: active\n');
  const g = spawnSync(process.execPath, [path.join(fx, 'vibe/tools/governance.mjs'), 'genesis', '--root', fx, '--path', 'vibe/goal/run-goal.ps1', '--path', 'vibe/goal/continue.prompt.md'], { encoding: 'utf8' });
  assert.equal(g.status, 0, g.stdout + g.stderr);
  return { fx, logs: path.join(fx, 'logs') };
}

function dryRun({ fx, logs }) {
  const env = { ...process.env, FAKE_TEST_API_KEY: 'not-a-real-secret-123', VIBECODIUM_GH_TOKEN: 'scoped-test-token-456', MORPH_API_KEY: 'morph-test-key-789' };
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(fx, 'vibe/goal/run-goal.ps1'), '-Root', fx, '-LogDir', logs, '-OpenCode', 'opencode-not-started', '-Provider', 'morph', '-DryRun'], { encoding: 'utf8', env });
  return r.stdout + r.stderr;
}

test('goal runner refuses to start when its lock fails', { skip: WIN_PWSH }, () => {
  const f = runnerFixture();
  writeFileSync(path.join(f.fx, 'vibe/goal/continue.prompt.md'), 'tampered prompt\n');
  const out = dryRun(f);
  assert.doesNotMatch(out, /DRYRUN/);
  const log = readFileSync(path.join(f.logs, readdirSync(f.logs).find((n) => n.startsWith('run-'))), 'utf8');
  assert.match(log, /governance check failed on trunk; refusing to start a session/);
});

test('goal runner dry run: own models per agent, Morph tools, deny rules, secrets removed', { skip: WIN_PWSH }, () => {
  const f = runnerFixture();
  const out = dryRun(f);
  assert.match(out, /DRYRUN provider=morph /, out);
  assert.match(out, /DRYRUN args=run "Follow the attached file exactly\.[^"]*" --agent vibe-overseer -m morph\/morph-glm53-744b --dir \S+ -f \S+continue\.prompt\.md\s*$/m, 'the message must come before -f');
  assert.match(out, /secret_vars_left=0 gh_token_source=VIBECODIUM_GH_TOKEN/);
  assert.doesNotMatch(out, /not-a-real-secret-123|scoped-test-token-456|morph-test-key-789/);
  const cfg = JSON.parse(readFileSync(out.match(/config=(\S+)/)[1], 'utf8'));
  assert.equal(cfg.agent['governance-verifier'].model, 'morph/morph-kimik31');
  assert.equal(cfg.agent['docs-keeper'].model, 'morph/morph-dsv41flash');
  assert.equal(cfg.provider.morph.options.apiKey, '{env:MORPH_API_KEY}');
  assert.ok(cfg.mcp.morph.command.join(' ').includes('@morphllm/morphmcp@'));
  assert.equal(cfg.permission.bash['git push --force*'], 'deny');
  assert.equal(cfg.permission.bash['*'], 'allow');
});

test('build preflight reports every tool and an overall verdict', { skip: !BASH && 'bash not available' }, () => {
  const r = spawnSync(BASH_CMD, [path.join(ROOT, 'vibe/dev/preflight.sh')], { encoding: 'utf8' });
  for (const tool of ['node', 'python', 'jq', 'git', 'cargo', '7z']) assert.match(r.stdout, new RegExp(`^(PASS|FAIL)\\s+${tool}\\s`, 'm'));
  assert.match(r.stdout, /^PREFLIGHT: (PASS|FAIL)$/m);
});
