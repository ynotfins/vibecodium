// Shared helpers for Vibecodium repo tooling. Node >= 20, no dependencies.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? true : (i++, next);
    if (out[key] === undefined) out[key] = value;
    else out[key] = [].concat(out[key], value);
  }
  return out;
}

export function list(v) {
  return v === undefined ? [] : [].concat(v);
}

export function rootFrom(args) {
  return path.resolve(typeof args.root === 'string' ? args.root : DEFAULT_ROOT);
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function readText(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

// SHA-256 of LF-normalized UTF-8 content, so hashes match across autocrlf checkouts.
export function hashFile(file) {
  return createHash('sha256').update(readText(file), 'utf8').digest('hex');
}

export function walk(dir, filter = () => true) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out.sort();
}

// Minimal front matter: a leading '---' block of `key: value` lines.
export function parseFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: text.slice(m[0].length) };
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function report(name, errors, warnings = []) {
  for (const w of warnings) console.log(`WARN  ${name}: ${w}`);
  for (const e of errors) console.log(`FAIL  ${name}: ${e}`);
  console.log(`${name}: ${errors.length ? 'FAIL' : 'PASS'} (${errors.length} errors, ${warnings.length} warnings)`);
  return errors.length ? 1 : 0;
}

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(path.resolve(process.argv[1])) === norm(fileURLToPath(metaUrl));
}
