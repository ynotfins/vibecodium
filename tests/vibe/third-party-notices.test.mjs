import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LICENSE_TEXT_PREFIX,
  MAX_DOCUMENT_BYTES,
  MAX_LICENSES,
  NOTICES_DOCUMENT_OWNER,
  NOTICES_DOCUMENT_PATH,
  NoticeError,
  buildThirdPartyNotices,
  collectThirdPartyComponents,
  digestLicenseText,
  loadNoticesLedger,
  loadNoticesLedgerFile,
  validateNoticesLedger,
} from '../../src/stable/runtime/third-party-notices.mjs';
import { loadSidecarManifestFile } from '../../src/stable/runtime/sidecar.mjs';
import { loadCatalogFile } from '../../src/stable/runtime/model-downloader.mjs';
import { checkNotices } from '../../vibe/tools/notices.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LEDGER = path.join(ROOT, 'vibe', 'notices.json');
const SIDECARS = path.join(ROOT, 'vibe', 'sidecars.json');
const CATALOG = path.join(ROOT, 'vibe', 'models', 'catalog.json');
const DOCUMENT = path.join(ROOT, NOTICES_DOCUMENT_PATH);

const ledger = loadNoticesLedgerFile(LEDGER);
const sidecars = loadSidecarManifestFile(SIDECARS);
const catalog = loadCatalogFile(CATALOG);

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function texts() {
  const out = {};
  for (const license of ledger.licenses) out[license.id] = readFileSync(path.join(ROOT, license.text), 'utf8');
  return out;
}

function ledgerJson(overrides = {}) {
  return {
    version: 1,
    reviewed: '2026-11-26',
    licenses: ledger.licenses.map((license) => ({ ...license })),
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof NoticeError, `expected a NoticeError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('the shipped ledger validates and covers every pinned license', () => {
  assert.equal(ledger.version, 1);
  const components = collectThirdPartyComponents({ sidecars, catalog });
  const used = new Set(components.flatMap((component) => component.licenses));
  for (const id of used) {
    assert.ok(ledger.licenses.some((license) => license.id === id), `no ledger entry for ${id}`);
  }
  for (const license of ledger.licenses) {
    const text = readFileSync(path.join(ROOT, license.text), 'utf8');
    assert.equal(digestLicenseText(text), license.sha256, `${license.id} text does not match its digest`);
    assert.ok(license.text.startsWith(LICENSE_TEXT_PREFIX), `${license.id} text path is outside ${LICENSE_TEXT_PREFIX}`);
  }
});

test('the LLVM/OpenMP notice text is the file the sidecar pin installs', () => {
  const pinned = sidecars.sidecars[0].targets['win32-x64'].files.find((file) => file.path === 'LICENSE-LLVM-OpenMP');
  assert.ok(pinned, 'the pin no longer carries LICENSE-LLVM-OpenMP');
  const license = ledger.licenses.find((entry) => entry.id === 'apache-2.0-with-llvm-exception');
  assert.ok(license, 'the ledger lost the LLVM exception entry');
  const text = readFileSync(path.join(ROOT, license.text), 'utf8');
  assert.equal(Buffer.byteLength(text, 'utf8'), pinned.sizeBytes);
  assert.equal(digestLicenseText(text), pinned.sha256);
  assert.equal(sha256(text), pinned.sha256);
});

test('the component projection follows the shipped pins', () => {
  const components = collectThirdPartyComponents({ sidecars, catalog });
  const names = components.map((component) => component.name);
  assert.deepEqual(names, ['llama-server', 'qwen2.5-coder-1.5b-q4-k-m', 'qwen3-embedding-0.6b-q8-0']);
  assert.deepEqual([...names].sort(), names, 'components are not sorted');
  const llama = components.find((component) => component.name === 'llama-server');
  assert.equal(llama.kind, 'binary');
  assert.equal(llama.version, 'b12426');
  assert.equal(llama.source, 'ggml-org/llama.cpp');
  assert.deepEqual([...llama.licenses], ['mit', 'apache-2.0-with-llvm-exception']);
  const model = components.find((component) => component.name === 'qwen2.5-coder-1.5b-q4-k-m');
  assert.equal(model.kind, 'model');
  assert.deepEqual([...model.licenses], ['apache-2.0']);
  assert.equal(model.version.length, 12);
  assert.ok(catalog.models.some((entry) => entry.id === model.name && entry.revision.startsWith(model.version)));
});

test('the generated document matches the checked-in file and is deterministic', () => {
  const first = buildThirdPartyNotices({ ledger, components: collectThirdPartyComponents({ sidecars, catalog }), texts: texts() });
  const second = buildThirdPartyNotices({ ledger, components: collectThirdPartyComponents({ sidecars, catalog }), texts: texts() });
  assert.equal(first, second);
  assert.equal(readFileSync(DOCUMENT, 'utf8'), first);
  assert.ok(Buffer.byteLength(first, 'utf8') <= MAX_DOCUMENT_BYTES);
  assert.ok(first.startsWith(`> Doc class: generated - Owner: ${NOTICES_DOCUMENT_OWNER} - Last reviewed: 2026-11-26\n`));
  for (const license of ledger.licenses) {
    assert.ok(first.includes(readFileSync(path.join(ROOT, license.text), 'utf8').replace(/\n+$/, '')), `${license.id} text is missing from the document`);
    assert.ok(first.includes('`' + license.sha256 + '`'), `${license.id} digest is missing from the document`);
  }
  assert.ok(!first.includes(ROOT), 'the document leaks an absolute path');
  assert.ok(!first.includes('\r'));
  assert.ok(first.endsWith('\n'));
});

test('the document escapes a table cell and never breaks the row', () => {
  const document = buildThirdPartyNotices({
    ledger,
    components: [{
      name: 'evil|name',
      kind: 'binary',
      version: 'b1',
      source: 'owner/repo',
      licenses: ['mit'],
    }],
    texts: texts(),
  });
  const row = document.split('\n').find((line) => line.includes('evil'));
  assert.ok(row, 'no component row was rendered');
  assert.ok(row.includes('evil\\|name'), row);
  assert.equal(row, '| evil\\|name | binary | b1 | owner/repo | MIT License |');
});

test('a repeated license id is rendered once in the row', () => {
  const document = buildThirdPartyNotices({
    ledger,
    components: [{
      name: 'llama-server',
      kind: 'binary',
      version: 'b1',
      source: 'owner/repo',
      licenses: ['mit', 'mit'],
    }],
    texts: texts(),
  });
  const row = document.split('\n').find((line) => line.startsWith('| llama-server |'));
  assert.ok(row, 'no component row was rendered');
  assert.equal(row, '| llama-server | binary | b1 | owner/repo | MIT License |');
  assert.equal((document.match(/^### MIT License$/gm) || []).length, 1);
});

test('an HTML or link payload in a component cell is neutralised', () => {
  const document = buildThirdPartyNotices({
    ledger,
    components: [{
      name: '<script>alert(1)</script>',
      kind: 'binary',
      version: 'b1',
      source: 'owner/repo',
      licenses: ['mit'],
    }],
    texts: texts(),
  });
  assert.ok(!document.includes('<script>'));
  const row = document.split('\n').find((line) => line.includes('script'));
  assert.ok(row.includes('\\<script\\>alert(1)\\</script\\>'), row);
  const name = buildThirdPartyNotices({
    ledger,
    components: [{
      name: '](javascript:alert(1))',
      kind: 'binary',
      version: 'b1',
      source: 'owner/repo',
      licenses: ['mit'],
    }],
    texts: texts(),
  }).split('\n').find((line) => line.includes('javascript'));
  assert.ok(name.includes('\\](javascript:alert(1))'), name);
});

test('a ledger URL is serialized so it cannot break out of its autolink', () => {
  const hostile = ledgerJson({ licenses: [{ ...ledger.licenses[0], url: 'https://a.test/x><img src=y>' }] });
  const valid = validateNoticesLedger(hostile);
  assert.ok(!valid.licenses[0].url.includes('>'));
  assert.ok(!valid.licenses[0].url.includes('<'));
  assert.ok(valid.licenses[0].url.startsWith('https://a.test/'));
});

test('checkNotices passes on the real repository root', () => {
  const { errors, document } = checkNotices(ROOT);
  assert.deepEqual(errors, []);
  assert.equal(document, readFileSync(DOCUMENT, 'utf8'));
});

test('checkNotices rejects a missing and a stale document', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-notices-'));
  try {
    cpSync(path.join(ROOT, 'vibe'), path.join(dir, 'vibe'), { recursive: true });
    mkdirSync(path.join(dir, 'docs', 'vibe', 'legal'), { recursive: true });
    const missing = checkNotices(dir);
    assert.equal(missing.errors.length, 1);
    assert.match(missing.errors[0], /is missing; run node vibe\/tools\/notices\.mjs --write/);

    const target = path.join(dir, NOTICES_DOCUMENT_PATH);
    writeFileSync(target, 'stale\n');
    const stale = checkNotices(dir);
    assert.equal(stale.errors.length, 1);
    assert.match(stale.errors[0], /is stale; run node vibe\/tools\/notices\.mjs --write/);

    assert.deepEqual(checkNotices(dir, { write: true }).errors, []);
    const written = readFileSync(target, 'utf8');
    assert.deepEqual(checkNotices(dir).errors, []);
    assert.deepEqual(checkNotices(dir, { write: true }).errors, []);
    assert.equal(readFileSync(target, 'utf8'), written, 'a second --write is not idempotent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ledger accessor is rejected without being invoked', () => {
  let invoked = false;
  const hostile = ledgerJson();
  Object.defineProperty(hostile.licenses[0], 'name', {
    enumerable: true,
    get() { invoked = true; return 'MIT License'; },
  });
  expectCode(() => validateNoticesLedger(hostile), 'invalid-ledger');
  assert.equal(invoked, false);
});

test('a ledger Proxy is rejected', () => {
  const trapped = new Proxy(ledgerJson(), { ownKeys() { throw new Error('trap'); } });
  expectCode(() => validateNoticesLedger(trapped), 'invalid-ledger');
  const revoked = Proxy.revocable(ledgerJson(), {});
  revoked.revoke();
  expectCode(() => validateNoticesLedger(revoked.proxy), 'invalid-ledger');
});

test('malformed ledger fields fail closed', () => {
  expectCode(() => validateNoticesLedger([]), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(null), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ version: 2 })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ reviewed: '2026-13-01' })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ reviewed: '26-11-2026' })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ extra: true })), 'invalid-ledger');
  const reserved = ledgerJson();
  Object.defineProperty(reserved, '__proto__', { enumerable: true, value: {} });
  expectCode(() => validateNoticesLedger(reserved), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [] })), 'invalid-ledger');
  const duplicated = ledgerJson();
  duplicated.licenses[1] = { ...duplicated.licenses[0] };
  expectCode(() => validateNoticesLedger(duplicated), 'invalid-ledger');
  const many = ledgerJson({ licenses: Array.from({ length: MAX_LICENSES + 1 }, (_, index) => ({ ...ledger.licenses[0], id: 'lic-' + index })) });
  expectCode(() => validateNoticesLedger(many), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ reviewed: '2026-02-31' })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ reviewed: '2999-12-31' })), 'invalid-ledger');
});

test('a malformed license entry fails closed', () => {
  const cases = [
    ['ID', 'invalid-ledger'],
    ['Mit', 'invalid-ledger'],
    ['mit license', 'invalid-ledger'],
    ['mit\n', 'invalid-ledger'],
  ];
  for (const [id, code] of cases) {
    expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], id }] })), code);
  }
  expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], name: '' }] })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], name: 'MIT\u202eLicense' }] })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], url: 'http://example.com/l' }] })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], url: 'https://user:pass@example.com/l' }] })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], url: 'not a url' }] })), 'invalid-ledger');
  for (const unsafe of [
    '/etc/passwd',
    'C:/licenses/mit.txt',
    'vibe\\licenses\\mit.txt',
    'vibe/licenses/../mit.txt',
    'vibe/licenses/./mit.txt',
    'docs/vibe/licenses/mit.txt',
    'vibe/licenses/nested/mit.txt',
    'vibe/licenses/',
    '',
  ]) {
    expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], text: unsafe }] })), 'invalid-ledger');
  }
  expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], sha256: 'ABC' }] })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], sha256: ledger.licenses[0].sha256.toUpperCase() }] })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ licenses: [{ ...ledger.licenses[0], sha256: 42 }] })), 'invalid-ledger');
  const missing = ledgerJson();
  delete missing.licenses[0].url;
  expectCode(() => validateNoticesLedger(missing), 'invalid-ledger');
});

test('loadNoticesLedger rejects unreadable text', () => {
  expectCode(() => loadNoticesLedger('{'), 'invalid-ledger');
  expectCode(() => loadNoticesLedger('null'), 'invalid-ledger');
  expectCode(() => loadNoticesLedger(42), 'invalid-ledger');
  expectCode(() => loadNoticesLedgerFile(path.join(ROOT, 'vibe', 'missing-notices.json')), 'invalid-ledger');
});

test('a pinned license without a ledger entry fails the build', () => {
  const components = [{ name: 'llama-server', kind: 'binary', version: 'b12426', source: 'ggml-org/llama.cpp', licenses: ['mpl-2.0'] }];
  expectCode(() => buildThirdPartyNotices({ ledger, components, texts: texts() }), 'missing-license-text');
});

test('a license text that drifted fails the build', () => {
  const components = collectThirdPartyComponents({ sidecars, catalog });
  const bodies = texts();
  bodies.mit = bodies.mit.replace('MIT License', 'MIT Licence');
  expectCode(() => buildThirdPartyNotices({ ledger, components, texts: bodies }), 'license-digest-mismatch');
});

test('an unused ledger row with a drifted text still fails the build', () => {
  const unused = { id: 'isc', name: 'ISC License', url: 'https://example.com/isc', text: 'vibe/licenses/isc.txt', sha256: 'a'.repeat(64) };
  const withUnused = validateNoticesLedger(ledgerJson({ licenses: [...ledger.licenses.map((entry) => ({ ...entry })), unused] }));
  const components = [{ name: 'llama-server', kind: 'binary', version: 'b12426', source: 'ggml-org/llama.cpp', licenses: ['mit'] }];
  expectCode(
    () => buildThirdPartyNotices({ ledger: withUnused, components, texts: { ...texts(), isc: 'ISC License text' } }),
    'license-digest-mismatch',
  );
});

test('a body that carries the render fence fails the build', () => {
  const components = [{ name: 'llama-server', kind: 'binary', version: 'b12426', source: 'ggml-org/llama.cpp', licenses: ['mit'] }];
  expectCode(
    () => buildThirdPartyNotices({ ledger, components, texts: { ...texts(), mit: 'MIT License\n```\n# Injected\n' } }),
    'invalid-license-body',
  );
});

test('a missing, empty, oversized or non-text body fails the build', () => {
  const components = collectThirdPartyComponents({ sidecars, catalog });
  const bodies = texts();
  delete bodies.mit;
  expectCode(() => buildThirdPartyNotices({ ledger, components, texts: bodies }), 'missing-license-body');
  expectCode(() => buildThirdPartyNotices({ ledger, components, texts: { ...texts(), mit: '' } }), 'invalid-license-body');
  expectCode(() => buildThirdPartyNotices({ ledger, components, texts: { ...texts(), mit: 12 } }), 'invalid-license-body');
  expectCode(() => buildThirdPartyNotices({ ledger, components, texts: { ...texts(), mit: 'x'.repeat(300 * 1024) } }), 'invalid-license-body');
  expectCode(() => buildThirdPartyNotices({ ledger, components, texts: null }), 'missing-license-body');
});

test('a CRLF checkout still matches the pinned digest', () => {
  const components = collectThirdPartyComponents({ sidecars, catalog });
  const bodies = texts();
  bodies.mit = bodies.mit.replace(/\n/g, '\r\n');
  const document = buildThirdPartyNotices({ ledger, components, texts: bodies });
  assert.ok(!document.includes('\r'));
});

test('invalid component input fails closed', () => {
  expectCode(() => collectThirdPartyComponents({}), 'invalid-components');
  expectCode(() => collectThirdPartyComponents({ sidecars: [] }), 'invalid-components');
  expectCode(() => collectThirdPartyComponents({ sidecars: { sidecars: [] } }), 'invalid-components');
  expectCode(() => buildThirdPartyNotices({ ledger, components: [], texts: texts() }), 'invalid-components');
  expectCode(() => buildThirdPartyNotices({ ledger, components: [{ name: 'x' }], texts: texts() }), 'invalid-components');
  const duplicated = collectThirdPartyComponents({ sidecars, catalog });
  expectCode(() => collectThirdPartyComponents({
    sidecars: { sidecars: [sidecars.sidecars[0], sidecars.sidecars[0]] },
  }), 'invalid-components');
  assert.equal(new Set(duplicated.map((component) => component.name)).size, duplicated.length);
});

test('the components are frozen and a caller cannot mutate the projection', () => {
  const components = collectThirdPartyComponents({ sidecars, catalog });
  assert.ok(Object.isFrozen(components));
  for (const component of components) {
    assert.ok(Object.isFrozen(component));
    assert.ok(Object.isFrozen(component.licenses));
  }
});

test('the ledger and its entries are frozen', () => {
  assert.ok(Object.isFrozen(ledger));
  assert.ok(Object.isFrozen(ledger.licenses));
  for (const license of ledger.licenses) assert.ok(Object.isFrozen(license));
});

test('the tool fails closed on an unreadable license text', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-notices-missing-'));
  try {
    cpSync(path.join(ROOT, 'vibe'), path.join(dir, 'vibe'), { recursive: true });
    rmSync(path.join(dir, 'vibe', 'licenses', 'mit.txt'));
    const { errors } = checkNotices(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^missing-license-body: license mit text cannot be read$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tool reports a ledger error without a document', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-notices-ledger-'));
  try {
    cpSync(path.join(ROOT, 'vibe'), path.join(dir, 'vibe'), { recursive: true });
    writeFileSync(path.join(dir, 'vibe', 'notices.json'), '{}\n');
    const { errors, document } = checkNotices(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^invalid-ledger: /);
    assert.equal(document, undefined);
    assert.ok(!existsSync(path.join(dir, NOTICES_DOCUMENT_PATH)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each used license is rendered exactly once and none is dropped', () => {
  const components = collectThirdPartyComponents({ sidecars, catalog });
  const document = buildThirdPartyNotices({ ledger, components, texts: texts() });
  const used = [...new Set(components.flatMap((component) => [...component.licenses]))].sort();
  assert.equal((document.match(/^### /gm) || []).length, used.length, 'a license section is repeated or dropped');
  for (const id of used) {
    const license = ledger.licenses.find((entry) => entry.id === id);
    const body = readFileSync(path.join(ROOT, license.text), 'utf8').replace(/\n+$/, '');
    assert.equal(document.split(body).length - 1, 1, `${id} text is rendered more than once`);
    assert.ok(document.includes('`' + license.sha256 + '`'), `${id} digest is missing`);
  }
});

test('the review date is checked against the real current date', () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(validateNoticesLedger(ledgerJson({ reviewed: today })).reviewed, today);
  expectCode(() => validateNoticesLedger(ledgerJson({ reviewed: tomorrow })), 'invalid-ledger');
  expectCode(() => validateNoticesLedger(ledgerJson({ reviewed: '2999-12-31' })), 'invalid-ledger');
});

test('the tool fails when a shipped pin license has no ledger row', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-notices-coverage-'));
  try {
    cpSync(path.join(ROOT, 'vibe'), path.join(dir, 'vibe'), { recursive: true });
    mkdirSync(path.join(dir, 'docs', 'vibe', 'legal'), { recursive: true });
    const ledgerPath = path.join(dir, 'vibe', 'notices.json');
    const json = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    json.licenses = json.licenses.filter((license) => license.id !== 'apache-2.0');
    writeFileSync(ledgerPath, JSON.stringify(json, null, 2) + '\n');
    const { errors, document } = checkNotices(dir);
    assert.equal(document, undefined);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^missing-license-text: license apache-2\.0 is used by a pinned component but missing from the ledger$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

