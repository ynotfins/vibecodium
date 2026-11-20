import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { checkDocs } from '../../vibe/tools/docs-check.mjs';
import { renderCodex, sync } from '../../vibe/tools/sync-agents.mjs';

let root;
const dirs = [];
const HDR = (cls, owner = 'docs-keeper') => `> Doc class: ${cls} · Owner: ${owner} · Last reviewed: 2026-01-01\n`;

function write(rel, text) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

const AGENT = '---\nname: docs-keeper\ndescription: Keeps docs "accurate".\nsandbox: workspace-write\nreasoning: medium\nruns: always\n---\n# docs-keeper\n\nDo the work.\n';

function minimalDocs() {
  write('AGENTS.md', '# rules\n');
  write('.vibe/agents/docs-keeper.md', AGENT);
  write('docs/vibe/README.md', `# Index\n${HDR('living')}\n[s](STATUS.md) [c](CHANGELOG.md) [r](TECH_RADAR.md) [a](adr/README.md)\n`);
  write('docs/vibe/STATUS.md', `# Status\n${HDR('living')}\nGoal state: active\n`);
  write('docs/vibe/CHANGELOG.md', `# Changelog\n${HDR('living')}\n## [Unreleased]\n`);
  write('docs/vibe/TECH_RADAR.md', `# Radar\n${HDR('living')}\n| C | Choice | V | L | Ch | Alt | Ring | Next |\n|---|---|---|---|---|---|---|---|\n| Node | node | 1 | 1 | 2026-01-01 | — | adopt | 2999-01-01 |\n`);
  write('docs/vibe/adr/README.md', `# ADRs\n${HDR('living')}\n[0001](0001-x.md)\n`);
  write('docs/vibe/adr/0001-x.md', `# ADR\n${HDR('living')}\n`);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'vibe-docs-'));
  dirs.push(root);
});
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('renderCodex escapes the description and keeps instructions verbatim', () => {
  const toml = renderCodex({ name: 'a', description: 'say "hi" \\ ok', sandbox: 'read-only', reasoning: 'low', body: 'line `x`' });
  assert.match(toml, /^description = "say \\"hi\\" \\\\ ok"$/m);
  assert.match(toml, /developer_instructions = '''\nline `x`\n'''/);
});

test('sync writes Codex agents and --check passes, then detects drift', () => {
  write('.vibe/agents/docs-keeper.md', AGENT);
  assert.deepEqual(sync(root, { checkOnly: false }), []);
  assert.deepEqual(sync(root, { checkOnly: true }), []);
  write('.vibe/agents/docs-keeper.md', AGENT.replace('Do the work.', 'Do more work.'));
  assert.ok(sync(root, { checkOnly: true }).some((e) => /stale/.test(e)));
  write('.codex/agents/orphan.toml', 'name = "orphan"\n');
  assert.ok(sync(root, { checkOnly: true }).some((e) => /orphan.toml has no source/.test(e)));
});

test('agent definitions are validated', () => {
  write('.vibe/agents/bad.md', '---\nname: other\nsandbox: everything\nreasoning: max\n---\nbody\n');
  const errors = sync(root, { checkOnly: true });
  assert.ok(errors.some((e) => /must match the file name/.test(e)));
  assert.ok(errors.some((e) => /sandbox must be one of/.test(e)));
  assert.ok(errors.some((e) => /missing front matter field "description"/.test(e)));
});

test('minimal docs suite passes', () => {
  minimalDocs();
  assert.deepEqual(checkDocs(root).errors, []);
});

test('missing header, unknown owner and broken link are errors', () => {
  minimalDocs();
  write('docs/vibe/NOHEADER.md', '# x\n');
  write('docs/vibe/OWNER.md', `# x\n${HDR('living', 'nobody')}\n`);
  write('docs/vibe/LINK.md', `# x\n${HDR('living')}\n[gone](missing.md)\n`);
  const { errors } = checkDocs(root);
  assert.ok(errors.some((e) => /NOHEADER.md: missing header/.test(e)));
  assert.ok(errors.some((e) => /owner "nobody"/.test(e)));
  assert.ok(errors.some((e) => /broken link missing.md/.test(e)));
  assert.ok(errors.some((e) => /README.md does not link to LINK.md/.test(e)));
});

test('locked class must match locks.json', () => {
  minimalDocs();
  write('docs/vibe/VISION.md', `# v\n${HDR('locked')}\n`);
  assert.ok(checkDocs(root).errors.some((e) => /class is locked but the file is not in/.test(e)));
});

test('overdue radar row warns, and fails with --strict', () => {
  minimalDocs();
  const radar = path.join(root, 'docs/vibe/TECH_RADAR.md');
  writeFileSync(radar, readFileSync(radar, 'utf8').replace('2999-01-01', '2000-01-01'));
  assert.equal(checkDocs(root).warnings.length, 1);
  assert.ok(checkDocs(root, { strict: true }).errors.some((e) => /review overdue/.test(e)));
});

test('ADR missing from the index is an error', () => {
  minimalDocs();
  write('docs/vibe/adr/0002-y.md', `# ADR\n${HDR('living')}\n`);
  assert.ok(checkDocs(root).errors.some((e) => /does not list 0002-y.md/.test(e)));
});
