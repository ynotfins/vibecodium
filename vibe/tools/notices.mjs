#!/usr/bin/env node
// Third-party notices check and generator. See docs/vibe/design/m3-third-party-notices.md.
//
//   node vibe/tools/notices.mjs [--write] [--root <dir>]
//
// Errors: a malformed ledger, a pinned component whose license has no notice text, a license text
// whose SHA-256 differs from the ledger, or a checked-in document that differs from the generator
// output. `--write` regenerates `docs/vibe/legal/THIRD-PARTY-NOTICES.md`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMain, parseArgs, readText, report, rootFrom } from './lib.mjs';
import { loadSidecarManifestFile } from '../../src/stable/runtime/sidecar.mjs';
import { loadCatalogFile } from '../../src/stable/runtime/model-downloader.mjs';
import {
  NOTICES_DOCUMENT_PATH,
  NOTICES_LEDGER_PATH,
  buildThirdPartyNotices,
  collectThirdPartyComponents,
  loadNoticesLedgerFile,
} from '../../src/stable/runtime/third-party-notices.mjs';

export function checkNotices(root, { write = false } = {}) {
  const errors = [];
  let document;
  try {
    const ledger = loadNoticesLedgerFile(path.join(root, NOTICES_LEDGER_PATH));
    const sidecars = loadSidecarManifestFile(path.join(root, 'vibe', 'sidecars.json'));
    const catalog = loadCatalogFile(path.join(root, 'vibe', 'models', 'catalog.json'));
    const components = collectThirdPartyComponents({ sidecars, catalog });
    const texts = Object.create(null);
    for (const license of ledger.licenses) {
      let body;
      try {
        body = readText(path.join(root, license.text));
      } catch {
        throw Object.assign(new Error('license ' + license.id + ' text cannot be read'), { code: 'missing-license-body' });
      }
      texts[license.id] = body;
    }
    document = buildThirdPartyNotices({ ledger, components, texts });
  } catch (error) {
    errors.push((error && error.code ? error.code + ': ' : '') + (error && error.message ? error.message : 'notices check failed'));
    return { errors, document };
  }

  const target = path.join(root, NOTICES_DOCUMENT_PATH);
  if (write) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, document, 'utf8');
  } else if (!existsSync(target)) {
    errors.push(`${NOTICES_DOCUMENT_PATH} is missing; run node vibe/tools/notices.mjs --write`);
  } else if (readFileSync(target, 'utf8') !== document) {
    errors.push(`${NOTICES_DOCUMENT_PATH} is stale; run node vibe/tools/notices.mjs --write`);
  }
  return { errors, document };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const { errors } = checkNotices(rootFrom(args), { write: Boolean(args.write) });
  process.exitCode = report('notices', errors);
}
