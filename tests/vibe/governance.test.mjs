import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../../vibe/tools/governance.mjs';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vibe/tools/governance.mjs');
let root;
const dirs = [];

function run(...args) {
  return spawnSync(process.execPath, [TOOL, ...args, '--root', root], { encoding: 'utf8' });
}
function write(rel, text) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'vibe-gov-'));
  dirs.push(root);
  write('docs/VISION.md', 'vision v1\n');
  write('docs/SPEC.md', 'spec v1\n');
});
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('empty repository passes', () => {
  assert.deepEqual(check(root), []);
});

test('genesis locks files and check passes', () => {
  assert.equal(run('genesis', '--path', 'docs/VISION.md', '--path', 'docs/SPEC.md').status, 0);
  assert.deepEqual(check(root), []);
  const locks = JSON.parse(readFileSync(path.join(root, '.vibe/governance/locks.json'), 'utf8'));
  assert.equal(locks.locked.length, 2);
});

test('genesis is refused once records exist', () => {
  run('genesis', '--path', 'docs/VISION.md');
  assert.notEqual(run('genesis', '--path', 'docs/SPEC.md').status, 0);
});

test('editing a locked file without approval fails', () => {
  run('genesis', '--path', 'docs/VISION.md');
  write('docs/VISION.md', 'vision v2\n');
  const errors = check(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /changed without a governance-verifier approval/);
});

test('CRLF-only change does not count as a change', () => {
  run('genesis', '--path', 'docs/VISION.md');
  write('docs/VISION.md', 'vision v1\r\n');
  assert.deepEqual(check(root), []);
});

test('approve with a proposal records the change and passes', () => {
  run('genesis', '--path', 'docs/VISION.md');
  write('docs/VISION.md', 'vision v2\n');
  write('.vibe/governance/proposals/2026-11-20-v2.md', 'proposal\n');
  const r = run('approve', '--slug', 'vision-v2', '--proposal', '.vibe/governance/proposals/2026-11-20-v2.md', '--path', 'docs/VISION.md');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(check(root), []);
  assert.deepEqual(readdirSync(path.join(root, '.vibe/governance/approvals')), ['0000-genesis.md', '0001-vision-v2.md']);
});

test('approve without an existing proposal is refused', () => {
  run('genesis', '--path', 'docs/VISION.md');
  write('docs/VISION.md', 'vision v2\n');
  assert.notEqual(run('approve', '--slug', 'x', '--proposal', 'missing.md', '--path', 'docs/VISION.md').status, 0);
});

test('editing locks.json directly is detected', () => {
  run('genesis', '--path', 'docs/VISION.md');
  write('docs/VISION.md', 'vision v2\n');
  const lockFile = path.join(root, '.vibe/governance/locks.json');
  const locks = JSON.parse(readFileSync(lockFile, 'utf8'));
  locks.locked[0].sha256 = 'f'.repeat(64);
  writeFileSync(lockFile, JSON.stringify(locks));
  assert.ok(check(root).some((e) => /does not match the approval chain/.test(e)));
});

test('a record with a FAIL verdict or another verifier is rejected', () => {
  run('genesis', '--path', 'docs/VISION.md');
  const rec = path.join(root, '.vibe/governance/approvals/0000-genesis.md');
  const text = readFileSync(rec, 'utf8');
  writeFileSync(rec, text.replace('verdict: PASS', 'verdict: FAIL').replace('verifier: governance-verifier', 'verifier: someone-else'));
  const errors = check(root);
  assert.ok(errors.some((e) => /verdict must be PASS/.test(e)));
  assert.ok(errors.some((e) => /verifier must be governance-verifier/.test(e)));
});

test('a broken hash chain is rejected', () => {
  run('genesis', '--path', 'docs/VISION.md');
  write('.vibe/governance/approvals/0001-forged.md', [
    'verifier: governance-verifier', 'verdict: PASS', 'date: 2026-11-20', 'proposal: genesis',
    `lock: docs/VISION.md ${'a'.repeat(64)} -> ${'b'.repeat(64)}`, '',
  ].join('\n'));
  assert.ok(check(root).some((e) => /old hash for docs\/VISION.md does not match/.test(e)));
});

test('a deleted locked file is reported', () => {
  run('genesis', '--path', 'docs/VISION.md');
  rmSync(path.join(root, 'docs/VISION.md'));
  assert.ok(check(root).some((e) => /locked file docs\/VISION.md is missing/.test(e)));
});
