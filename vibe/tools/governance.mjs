#!/usr/bin/env node
// Governance lock for Vibecodium's governing documents. See docs/vibe/GOVERNANCE.md.
//
//   node vibe/tools/governance.mjs check
//   node vibe/tools/governance.mjs status
//   node vibe/tools/governance.mjs hash --path <file>
//   node vibe/tools/governance.mjs genesis [--proposal <file>] --path <file> [--path ...]   (only when no records exist)
//   node vibe/tools/governance.mjs approve --slug <slug> --proposal <file> --path <file> [--path ...]
//
// All commands accept --root <dir> (defaults to the repository root).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hashFile, isMain, list, parseArgs, readText, report, rootFrom, today, toPosix } from './lib.mjs';

const VERIFIER = 'governance-verifier';
const SHA = /^[0-9a-f]{64}$/;

export function paths(root) {
  const gov = path.join(root, '.vibe', 'governance');
  return { gov, locks: path.join(gov, 'locks.json'), approvals: path.join(gov, 'approvals') };
}

export function loadRecords(root) {
  const dir = paths(root).approvals;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-[a-z0-9-]+\.md$/.test(f))
    .sort()
    .map((file) => {
      const fields = {};
      const locks = [];
      for (const line of readText(path.join(dir, file)).split('\n')) {
        const lock = /^lock:\s+(\S+)\s+(\S+)\s+->\s+(\S+)\s*$/.exec(line);
        if (lock) { locks.push({ path: lock[1], old: lock[2], next: lock[3] }); continue; }
        const kv = /^(verifier|verdict|date|proposal):\s+(.+?)\s*$/.exec(line);
        if (kv) fields[kv[1]] = kv[2];
      }
      return { file, id: Number(file.slice(0, 4)), ...fields, locks };
    });
}

export function loadLocks(root) {
  const file = paths(root).locks;
  if (!existsSync(file)) return { version: 1, locked: [] };
  return JSON.parse(readText(file));
}

function chain(root, records, errors) {
  const latest = new Map();
  let expectedId = 0;
  for (const r of records) {
    const where = `approvals/${r.file}`;
    if (r.id !== expectedId) errors.push(`${where}: record ids must be consecutive (expected ${String(expectedId).padStart(4, '0')})`);
    expectedId = r.id + 1;
    if (r.verifier !== VERIFIER) errors.push(`${where}: verifier must be ${VERIFIER}`);
    if (r.verdict !== 'PASS') errors.push(`${where}: verdict must be PASS`);
    if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) errors.push(`${where}: missing or invalid date`);
    if (!r.proposal) errors.push(`${where}: missing proposal`);
    else if (r.proposal !== 'genesis' && !existsSync(path.join(root, r.proposal))) errors.push(`${where}: proposal ${r.proposal} does not exist`);
    if (r.locks.length === 0) errors.push(`${where}: no lock lines`);
    for (const l of r.locks) {
      if (!SHA.test(l.next)) { errors.push(`${where}: invalid new hash for ${l.path}`); continue; }
      if (l.old === '-') {
        if (latest.has(l.path)) errors.push(`${where}: ${l.path} is already locked; use its current hash as the old hash`);
      } else if (latest.get(l.path) !== l.old) {
        errors.push(`${where}: old hash for ${l.path} does not match the previous approved hash`);
      }
      latest.set(l.path, l.next);
    }
  }
  return latest;
}

export function check(root) {
  const errors = [];
  const records = loadRecords(root);
  const approved = chain(root, records, errors);
  let locks;
  try { locks = loadLocks(root); } catch (e) { errors.push(`locks.json is not valid JSON: ${e.message}`); return errors; }
  const listed = new Map((locks.locked || []).map((e) => [e.path, e.sha256]));
  for (const [p, sha] of listed) {
    if (!approved.has(p)) errors.push(`locks.json lists ${p} but no approval record locks it`);
    else if (approved.get(p) !== sha) errors.push(`locks.json hash for ${p} does not match the approval chain`);
  }
  for (const [p, sha] of approved) {
    if (!listed.has(p)) errors.push(`${p} is locked by the approval chain but missing from locks.json`);
    const file = path.join(root, p);
    if (!existsSync(file)) { errors.push(`locked file ${p} is missing`); continue; }
    if (hashFile(file) !== sha) {
      errors.push(`locked file ${p} changed without a governance-verifier approval. Write a proposal in .vibe/governance/proposals/ and run the governance-verifier sub-agent (docs/vibe/GOVERNANCE.md §3)`);
    }
  }
  return errors;
}

function writeLocks(root, approved) {
  const locked = [...approved].sort(([a], [b]) => a.localeCompare(b)).map(([p, sha256]) => ({ path: p, sha256 }));
  writeFileSync(paths(root).locks, `${JSON.stringify({ version: 1, locked }, null, 2)}\n`);
}

function writeRecord(root, { slug, proposal, files, title }) {
  const { approvals } = paths(root);
  mkdirSync(approvals, { recursive: true });
  const records = loadRecords(root);
  const errors = [];
  const approved = chain(root, records, errors);
  if (errors.length) throw new Error(`approval chain is invalid; fix it first:\n${errors.join('\n')}`);
  const id = records.length;
  const lines = files.map((f) => {
    const rel = toPosix(path.relative(root, path.resolve(root, f)));
    if (!existsSync(path.join(root, rel))) throw new Error(`file not found: ${rel}`);
    return `lock: ${rel} ${approved.get(rel) || '-'} -> ${hashFile(path.join(root, rel))}`;
  });
  const name = `${String(id).padStart(4, '0')}-${slug}.md`;
  const body = [
    `# Governance approval ${String(id).padStart(4, '0')}: ${title || slug}`,
    '',
    `verifier: ${VERIFIER}`,
    'verdict: PASS',
    `date: ${today()}`,
    `proposal: ${proposal}`,
    '',
    ...lines,
    '',
  ].join('\n');
  writeFileSync(path.join(approvals, name), body);
  const after = chain(root, loadRecords(root), []);
  writeLocks(root, after);
  return name;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = rootFrom(args);
  const cmd = args._[0] || 'check';
  if (cmd === 'check') return report('governance', check(root));
  if (cmd === 'status') {
    const approved = chain(root, loadRecords(root), []);
    for (const [p, sha] of approved) {
      const file = path.join(root, p);
      const state = !existsSync(file) ? 'MISSING' : hashFile(file) === sha ? 'ok' : 'CHANGED';
      console.log(`${state.padEnd(8)} ${p}`);
    }
    return 0;
  }
  if (cmd === 'hash') {
    for (const p of list(args.path)) console.log(`${hashFile(path.resolve(root, p))}  ${p}`);
    return 0;
  }
  if (cmd === 'genesis') {
    if (loadRecords(root).length) { console.error('genesis refused: approval records already exist'); return 1; }
    let proposal = 'genesis';
    if (typeof args.proposal === 'string') {
      proposal = toPosix(path.relative(root, path.resolve(root, args.proposal)));
      if (!existsSync(path.join(root, proposal))) { console.error(`proposal not found: ${proposal}`); return 1; }
    }
    const name = writeRecord(root, { slug: 'genesis', proposal, files: list(args.path), title: 'genesis lock of governing documents' });
    console.log(`wrote .vibe/governance/approvals/${name}`);
    return 0;
  }
  if (cmd === 'approve') {
    const slug = args.slug;
    const proposal = args.proposal;
    if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) { console.error('--slug <lowercase-slug> is required'); return 1; }
    if (typeof proposal !== 'string') { console.error('--proposal <path> is required'); return 1; }
    const rel = toPosix(path.relative(root, path.resolve(root, proposal)));
    if (!existsSync(path.join(root, rel))) { console.error(`proposal not found: ${rel}`); return 1; }
    const files = list(args.path);
    if (!files.length) { console.error('at least one --path is required'); return 1; }
    const name = writeRecord(root, { slug, proposal: rel, files });
    console.log(`wrote .vibe/governance/approvals/${name}`);
    return report('governance', check(root));
  }
  console.error(`unknown command: ${cmd}`);
  return 1;
}

if (isMain(import.meta.url)) process.exitCode = main();
