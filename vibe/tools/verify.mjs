#!/usr/bin/env node
// Single entry point for every repository check. Must pass before any commit.
//
//   node vibe/tools/verify.mjs [--strict]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DEFAULT_ROOT, walk } from './lib.mjs';

const strict = process.argv.includes('--strict');
const tools = path.join(DEFAULT_ROOT, 'vibe', 'tools');
const tests = walk(path.join(DEFAULT_ROOT, 'tests', 'vibe'), (f) => f.endsWith('.test.mjs'));

const steps = [
  ['governance', [path.join(tools, 'governance.mjs'), 'check']],
  ['agents', [path.join(tools, 'sync-agents.mjs'), '--check']],
  ['docs', [path.join(tools, 'docs-check.mjs'), ...(strict ? ['--strict'] : [])]],
  ['notices', [path.join(tools, 'notices.mjs')]],
  ['tests', ['--test', ...tests]],
];

let failed = 0;
for (const [name, args] of steps) {
  const r = spawnSync(process.execPath, args, { cwd: DEFAULT_ROOT, stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`verify: step "${name}" FAILED`); }
}
console.log(`VERIFY: ${failed ? 'FAIL' : 'PASS'} (${steps.length - failed}/${steps.length} steps passed)`);
process.exitCode = failed ? 1 : 0;
