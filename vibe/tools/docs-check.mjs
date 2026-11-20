#!/usr/bin/env node
// Documentation suite check for docs/vibe. See docs/vibe/GOVERNANCE.md §1.
//
//   node vibe/tools/docs-check.mjs [--strict] [--root <dir>]
//
// Errors: missing or invalid doc headers, unknown owners, locked-class mismatch with locks.json,
// broken relative links, ADRs missing from the ADR index, docs missing from the docs index,
// missing CHANGELOG [Unreleased], missing STATUS goal state.
// Warnings (errors with --strict): overdue tech radar reviews.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadAgents } from './sync-agents.mjs';
import { loadLocks } from './governance.mjs';
import { isMain, parseArgs, readText, report, rootFrom, today, toPosix, walk } from './lib.mjs';

const HEADER = /^> Doc class: (locked|living|generated|archive) · Owner: ([a-z][a-z-]*) · Last reviewed: (\d{4}-\d{2}-\d{2})\s*$/m;

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

export function checkDocs(root, { strict = false } = {}) {
  const errors = [];
  const warnings = [];
  const docsDir = path.join(root, 'docs', 'vibe');
  if (!existsSync(docsDir)) return { errors: ['docs/vibe does not exist'], warnings };
  if (!existsSync(path.join(root, 'AGENTS.md'))) errors.push('AGENTS.md is missing at the repository root');

  const owners = new Set(loadAgents(root).map((a) => a.name).filter(Boolean));
  let locked = new Set();
  try { locked = new Set((loadLocks(root).locked || []).map((e) => e.path)); } catch { /* reported by governance check */ }

  const docs = walk(docsDir, (f) => f.endsWith('.md'));
  for (const file of docs) {
    const rel = toPosix(path.relative(root, file));
    const text = readText(file);
    const head = text.split('\n').slice(0, 6).join('\n');
    const m = HEADER.exec(head);
    if (!m) { errors.push(`${rel}: missing header "> Doc class: <class> · Owner: <agent> · Last reviewed: <YYYY-MM-DD>"`); continue; }
    const [, cls, owner, reviewed] = m;
    if (!owners.has(owner)) errors.push(`${rel}: owner "${owner}" is not an agent in .vibe/agents/`);
    if (reviewed > today()) errors.push(`${rel}: Last reviewed date ${reviewed} is in the future`);
    if (cls === 'locked' && !locked.has(rel)) errors.push(`${rel}: class is locked but the file is not in .vibe/governance/locks.json`);
    if (cls !== 'locked' && locked.has(rel)) errors.push(`${rel}: listed in locks.json but its class is ${cls}`);
    if (cls === 'archive') continue;
    for (const link of stripCode(text).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = link[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = decodeURIComponent(target.split('#')[0]);
      if (clean && !existsSync(path.resolve(path.dirname(file), clean))) errors.push(`${rel}: broken link ${target}`);
    }
  }

  const index = path.join(docsDir, 'README.md');
  if (existsSync(index)) {
    const text = readText(index);
    for (const file of docs) {
      const rel = toPosix(path.relative(docsDir, file));
      if (rel === 'README.md' || /^adr\/\d{4}-/.test(rel)) continue;
      if (!text.includes(`(${rel})`)) errors.push(`docs/vibe/README.md does not link to ${rel}`);
    }
  } else errors.push('docs/vibe/README.md (docs index) is missing');

  const adrIndex = path.join(docsDir, 'adr', 'README.md');
  if (existsSync(adrIndex)) {
    const text = readText(adrIndex);
    for (const file of walk(path.join(docsDir, 'adr'), (f) => /\d{4}-.*\.md$/.test(f))) {
      if (!text.includes(`(${path.basename(file)})`)) errors.push(`docs/vibe/adr/README.md does not list ${path.basename(file)}`);
    }
  }

  const changelog = path.join(docsDir, 'CHANGELOG.md');
  if (!existsSync(changelog) || !readText(changelog).includes('## [Unreleased]')) errors.push('docs/vibe/CHANGELOG.md must contain "## [Unreleased]"');

  const status = path.join(docsDir, 'STATUS.md');
  if (!existsSync(status) || !/^Goal state: (active|complete|blocked)\s*$/m.test(readText(status))) {
    errors.push('docs/vibe/STATUS.md must contain a line "Goal state: active|complete|blocked"');
  }

  const radar = path.join(docsDir, 'TECH_RADAR.md');
  if (existsSync(radar)) {
    for (const line of readText(radar).split('\n')) {
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      const due = cells[cells.length - 1];
      if (cells.length >= 8 && /^\d{4}-\d{2}-\d{2}$/.test(due) && due < today()) {
        (strict ? errors : warnings).push(`TECH_RADAR.md: review overdue for "${cells[0]}" (due ${due}); run the tech-scout sub-agent`);
      }
    }
  } else errors.push('docs/vibe/TECH_RADAR.md is missing');

  return { errors, warnings };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const { errors, warnings } = checkDocs(rootFrom(args), { strict: Boolean(args.strict) });
  process.exitCode = report('docs', errors, warnings);
}
