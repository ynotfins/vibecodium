#!/usr/bin/env node
// Applies the Vibecodium AI-surface product transform to a prepared checkout.
//
//   node vibe/tools/apply-ai-surfaces.mjs [--product vscode/product.json] [--check]
//
// The transform is idempotent and never mutates its input object. --check
// reports whether the file would change and exits 1 when it would.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { applyAISurfaces, findCopilotReferences } from '../../src/stable/security/ai-surfaces.mjs';
import { isMain, parseArgs } from './lib.mjs';

export function applyToFile(file, { check = false } = {}) {
  const absolute = path.resolve(file);
  const original = readFileSync(absolute, 'utf8');
  const before = JSON.parse(original);
  const after = applyAISurfaces(before);
  const text = `${JSON.stringify(after, null, 2)}\n`;
  const changed = text !== original.replace(/\r\n/g, '\n');
  if (changed && !check) writeFileSync(absolute, text);
  return { file: absolute, changed, copilotReferences: findCopilotReferences(after) };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const file = typeof args.product === 'string' ? args.product : 'product.json';
  try {
    const result = applyToFile(file, { check: args.check === true });
    const action = args.check ? (result.changed ? 'would change' : 'unchanged') : (result.changed ? 'updated' : 'unchanged');
    console.log(`apply-ai-surfaces: ${action} ${path.basename(result.file)}`);
    if (result.copilotReferences.length) {
      for (const hit of result.copilotReferences) console.log(`FAIL GitHub Copilot reference: ${hit}`);
      process.exitCode = 1;
    } else if (args.check && result.changed) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`apply-ai-surfaces: ${error.message}`);
    process.exitCode = 1;
  }
}
