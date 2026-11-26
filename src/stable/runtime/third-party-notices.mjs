// Third-party notices for the pinned runtime components (M3, B1).
//
// The module is dependency-free and has no I/O of its own: a caller loads the ledger
// (`vibe/notices.json`), the pinned components (`vibe/sidecars.json`, `vibe/models/catalog.json`) and
// the verbatim license texts (files under `vibe/licenses/`), and receives the rendered notice
// document. `vibe/tools/notices.mjs` is that caller and `node vibe/tools/verify.mjs` runs it, so a
// pinned component whose license has no text, a text whose digest drifted from the ledger, or a
// checked-in document that no longer matches the generator all fail the repository checks.
//
// Design note: docs/vibe/design/m3-third-party-notices.md. Ledger validation reads own data
// descriptors once, so an accessor is rejected without being invoked, a Proxy cannot run a get trap
// and a polluted prototype cannot contribute a key.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const NOTICES_MODULE_VERSION = 1;
export const NOTICES_LEDGER_VERSION = 1;
export const MAX_LICENSES = 16;
export const MAX_COMPONENTS = 64;
export const MAX_NAME_CHARS = 96;
export const MAX_ID_CHARS = 64;
export const MAX_URL_CHARS = 2048;
export const MAX_TEXT_PATH_CHARS = 256;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const LICENSE_TEXT_PREFIX = 'vibe/licenses/';
export const NOTICES_LEDGER_PATH = 'vibe/notices.json';
export const NOTICES_DOCUMENT_PATH = 'docs/vibe/legal/THIRD-PARTY-NOTICES.md';
export const NOTICES_DOCUMENT_OWNER = 'docs-keeper';

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/;
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEGAL_FENCE = '```';

const LEDGER_KEYS = new Set(['version', 'reviewed', 'licenses']);
const LICENSE_KEYS = new Set(['id', 'name', 'url', 'text', 'sha256']);
const COMPONENT_KEYS = new Set(['name', 'version', 'source', 'licenses', 'kind']);
const COMPONENT_KINDS = Object.freeze(['binary', 'model']);

export class NoticeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NoticeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new NoticeError(code, message);
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype;
  } catch {
    return false;
  }
}

function readOwnData(value, label, allowed, code = 'invalid-ledger') {
  if (!isPlainObject(value)) fail(code, label + ' must be a plain object');
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    fail(code, label + ' cannot be enumerated');
  }
  if (keys.length > allowed.size) fail(code, label + ' has too many keys');
  const out = Object.create(null);
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) fail(code, label + ' has a reserved key');
    if (!allowed.has(key)) fail(code, label + ' has an unknown key');
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(code, label + ' has an unsafe property');
    }
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      fail(code, label + ' must contain data properties only');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function readArray(value, label, max, code) {
  if (!Array.isArray(value)) fail(code, label + ' must be an array');
  let length;
  try {
    length = value.length;
  } catch {
    fail(code, label + ' cannot be read');
  }
  if (!Number.isInteger(length) || length < 1) fail(code, label + ' must not be empty');
  if (length > max) fail(code, label + ' has too many entries');
  const out = [];
  for (let index = 0; index < length; index++) {
    let item;
    try {
      item = value[index];
    } catch {
      fail(code, label + ' has an unsafe entry');
    }
    out.push(item);
  }
  return out;
}

function requireText(value, label, max, code) {
  if (typeof value !== 'string') fail(code, label + ' must be a string');
  if (value.length === 0) fail(code, label + ' must not be empty');
  if (value.length > max) fail(code, label + ' is too long');
  if (CONTROL_OR_BIDI.test(value)) fail(code, label + ' has a control or bidi character');
  return value;
}

function isIsoDate(value) {
  return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
}

// A license text is placed under a relative, directory-free path inside `vibe/licenses/`.
function validateLicenseTextPath(value) {
  const text = requireText(value, 'licenses[].text', MAX_TEXT_PATH_CHARS, 'invalid-ledger');
  if (text.includes('\\') || text.includes('\0')) fail('invalid-ledger', 'licenses[].text must be a relative POSIX path');
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) fail('invalid-ledger', 'licenses[].text must be relative');
  const segments = text.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') fail('invalid-ledger', 'licenses[].text must not contain empty, "." or ".." segments');
  }
  if (!text.startsWith(LICENSE_TEXT_PREFIX)) fail('invalid-ledger', 'licenses[].text must live under ' + LICENSE_TEXT_PREFIX);
  if (segments.length !== 3) fail('invalid-ledger', 'licenses[].text must name one file directly under ' + LICENSE_TEXT_PREFIX);
  return text;
}

// Only an HTTPS URL without userinfo is accepted, so a notice can never carry a credential.
function validateLicenseUrl(value) {
  const text = requireText(value, 'licenses[].url', MAX_URL_CHARS, 'invalid-ledger');
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('invalid-ledger', 'licenses[].url must be an absolute URL');
  }
  if (url.protocol !== 'https:') fail('invalid-ledger', 'licenses[].url must use https');
  if (url.username || url.password) fail('invalid-ledger', 'licenses[].url must not carry credentials');
  return text;
}

export function digestLicenseText(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function validateNoticesLedger(value) {
  const ledger = readOwnData(value, 'notices ledger', LEDGER_KEYS);
  if (ledger.version !== NOTICES_LEDGER_VERSION) fail('invalid-ledger', 'notices ledger version must be ' + NOTICES_LEDGER_VERSION);
  if (!isIsoDate(ledger.reviewed)) fail('invalid-ledger', 'notices ledger reviewed must be a YYYY-MM-DD date');
  const raw = readArray(ledger.licenses, 'notices ledger licenses', MAX_LICENSES, 'invalid-ledger');
  const seen = new Set();
  const licenses = [];
  for (const entry of raw) {
    const license = readOwnData(entry, 'licenses[]', LICENSE_KEYS);
    const id = requireText(license.id, 'licenses[].id', MAX_ID_CHARS, 'invalid-ledger');
    if (!ID.test(id)) fail('invalid-ledger', 'licenses[].id must be a lowercase identifier');
    if (seen.has(id)) fail('invalid-ledger', 'licenses[].id is duplicated');
    seen.add(id);
    const name = requireText(license.name, 'licenses[].name', MAX_NAME_CHARS, 'invalid-ledger');
    const url = validateLicenseUrl(license.url);
    const textPath = validateLicenseTextPath(license.text);
    const sha256 = requireText(license.sha256, 'licenses[].sha256', 64, 'invalid-ledger');
    if (!DIGEST.test(sha256)) fail('invalid-ledger', 'licenses[].sha256 must be a lowercase SHA-256 hex digest');
    licenses.push(Object.freeze({ id, name, url, text: textPath, sha256 }));
  }
  return Object.freeze({
    version: NOTICES_LEDGER_VERSION,
    reviewed: ledger.reviewed,
    licenses: Object.freeze(licenses),
  });
}

export function loadNoticesLedger(text) {
  if (typeof text !== 'string') fail('invalid-ledger', 'notices ledger must be text');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid-ledger', 'notices ledger is not valid JSON');
  }
  return validateNoticesLedger(parsed);
}

export function loadNoticesLedgerFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    fail('invalid-ledger', 'notices ledger cannot be read');
  }
  return loadNoticesLedger(text);
}

export function findLicense(ledger, id) {
  return ledger.licenses.find((license) => license.id === id) || null;
}

function componentName(value, label, code) {
  const name = requireText(value, label, MAX_NAME_CHARS, code);
  return name;
}

// Maps the shipped pins to the components a notice must cover. Both manifests are expected to have
// passed their own validators (`loadSidecarManifestFile`, `loadCatalogFile`); this function checks
// only the fields it reads and fails closed with its own codes.
export function collectThirdPartyComponents({ sidecars, catalog } = {}) {
  const components = [];
  if (isPlainObject(sidecars)) {
    const entries = readArray(sidecars.sidecars, 'sidecars', MAX_COMPONENTS, 'invalid-components');
    for (const entry of entries) {
      const sidecar = readOwnData(entry, 'sidecars[]', new Set(['id', 'version', 'licenses', 'publishedAt', 'source', 'targets']), 'invalid-components');
      const licenses = readArray(sidecar.licenses, 'sidecars[].licenses', 4, 'invalid-components');
      const ids = licenses.map((id) => requireText(id, 'sidecars[].licenses[]', MAX_ID_CHARS, 'invalid-components'));
      components.push(Object.freeze({
        name: componentName(sidecar.id, 'sidecars[].id', 'invalid-components'),
        version: requireText(sidecar.version, 'sidecars[].version', 64, 'invalid-components'),
        source: requireText(sidecar.source, 'sidecars[].source', 96, 'invalid-components'),
        licenses: Object.freeze(ids),
        kind: 'binary',
      }));
    }
  } else if (sidecars !== undefined) {
    fail('invalid-components', 'sidecars must be a plain object');
  }
  if (isPlainObject(catalog)) {
    const entries = readArray(catalog.models, 'catalog models', MAX_COMPONENTS, 'invalid-components');
    for (const entry of entries) {
      const model = readOwnData(entry, 'models[]', new Set(['id', 'label', 'repo', 'revision', 'file', 'url', 'sha256', 'sizeBytes', 'license', 'quantization', 'contextTokens', 'role']), 'invalid-components');
      const id = componentName(model.id, 'models[].id', 'invalid-components');
      const revision = requireText(model.revision, 'models[].revision', 96, 'invalid-components');
      const license = requireText(model.license, 'models[].license', MAX_ID_CHARS, 'invalid-components');
      components.push(Object.freeze({
        name: id,
        version: revision.slice(0, 12),
        source: requireText(model.repo, 'models[].repo', 96, 'invalid-components'),
        licenses: Object.freeze([license]),
        kind: 'model',
      }));
    }
  } else if (catalog !== undefined) {
    fail('invalid-components', 'catalog must be a plain object');
  }
  if (components.length === 0) fail('invalid-components', 'no pinned component was supplied');
  if (components.length > MAX_COMPONENTS) fail('invalid-components', 'too many pinned components');
  const seen = new Set();
  for (const component of components) {
    if (seen.has(component.name)) fail('invalid-components', 'a component name is duplicated');
    seen.add(component.name);
    if (!VERSION.test(component.version)) fail('invalid-components', 'a component version is malformed');
    if (!SOURCE.test(component.source)) fail('invalid-components', 'a component source must be owner/repo');
    for (const id of component.licenses) {
      if (!ID.test(id)) fail('invalid-components', 'a component license id is malformed');
    }
  }
  components.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.kind < b.kind ? -1 : 1));
  return Object.freeze(components.map((component) => Object.freeze({ ...component })));
}

function readTexts(texts) {
  if (texts === null || typeof texts !== 'object') fail('missing-license-body', 'license texts must be supplied');
  const out = new Map();
  let keys;
  try {
    keys = Object.keys(texts);
  } catch {
    fail('invalid-license-body', 'license texts cannot be enumerated');
  }
  for (const key of keys) {
    if (!ID.test(key)) fail('invalid-license-body', 'a license text key is malformed');
    let body;
    try {
      body = texts[key];
    } catch {
      fail('invalid-license-body', 'a license text cannot be read');
    }
    if (typeof body !== 'string') fail('invalid-license-body', 'license text ' + key + ' must be a string');
    if (body.length === 0) fail('invalid-license-body', 'license text ' + key + ' is empty');
    if (Buffer.byteLength(body, 'utf8') > MAX_TEXT_BYTES) fail('invalid-license-body', 'license text ' + key + ' is too large');
    out.set(key, body.replace(/\r\n/g, '\n'));
  }
  return out;
}

function cell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

// Deterministic by construction: the order comes from the sorted components and the ledger, and the
// date comes from the ledger, so regenerating the same inputs produces byte-identical output.
export function buildThirdPartyNotices({ ledger, components, texts } = {}) {
  const valid = validateNoticesLedger(ledger);
  const list = Array.isArray(components) ? components : [];
  if (list.length === 0) fail('invalid-components', 'no component was supplied');
  if (list.length > MAX_COMPONENTS) fail('invalid-components', 'too many components');
  const bodies = readTexts(texts);
  const used = new Set();
  for (const component of list) {
    for (const id of component.licenses || []) used.add(id);
    if (!Array.isArray(component.licenses) || component.licenses.length === 0) fail('invalid-components', 'a component has no license');
  }
  const usedIds = [...used].sort();
  for (const id of usedIds) {
    const license = findLicense(valid, id);
    if (!license) fail('missing-license-text', 'license ' + id + ' is used by a pinned component but missing from the ledger');
    if (!bodies.has(id)) fail('missing-license-body', 'license ' + id + ' has no text');
    const actual = digestLicenseText(bodies.get(id));
    if (actual !== license.sha256) fail('license-digest-mismatch', 'license ' + id + ' text does not match the ledger digest');
  }

  const lines = [];
  lines.push('> Doc class: generated - Owner: ' + NOTICES_DOCUMENT_OWNER + ' - Last reviewed: ' + valid.reviewed);
  lines.push('');
  lines.push('# Third-party notices');
  lines.push('');
  lines.push('Generated by `node vibe/tools/notices.mjs --write` from `vibe/notices.json`,');
  lines.push('`vibe/sidecars.json` and `vibe/models/catalog.json`. Do not edit it by hand:');
  lines.push('`node vibe/tools/verify.mjs` fails when this document differs from the generator output.');
  lines.push('');
  lines.push('Vibecodium installs the pinned `llama-server` sidecar from its upstream release and downloads');
  lines.push('the pinned GGUF models from their upstream repositories. This file records those components,');
  lines.push('the licenses they carry and the verbatim license texts, each pinned by SHA-256 in');
  lines.push('`vibe/notices.json`. The text of every license below is the upstream file, unchanged.');
  lines.push('');
  lines.push('## Components');
  lines.push('');
  lines.push('| Component | Kind | Version | Source | Licenses |');
  lines.push('|---|---|---|---|---|');
  for (const component of list) {
    const names = component.licenses
      .map((id) => (findLicense(valid, id) || { name: id }).name)
      .map((name) => cell(name))
      .join(', ');
    lines.push('| ' + cell(component.name) + ' | ' + cell(component.kind) + ' | ' + cell(component.version)
      + ' | ' + cell(component.source) + ' | ' + names + ' |');
  }
  lines.push('');
  lines.push('## License texts');
  for (const id of usedIds) {
    const license = findLicense(valid, id);
    lines.push('');
    lines.push('### ' + cell(license.name));
    lines.push('');
    lines.push('- Identifier: `' + license.id + '`');
    lines.push('- Source: <' + license.url + '>');
    lines.push('- Text: `' + license.text + '`');
    lines.push('- SHA-256: `' + license.sha256 + '`');
    lines.push('');
    lines.push(LEGAL_FENCE + 'text');
    lines.push(bodies.get(id).replace(/\n+$/, ''));
    lines.push(LEGAL_FENCE);
  }
  lines.push('');
  const document = lines.join('\n');
  if (Buffer.byteLength(document, 'utf8') > MAX_DOCUMENT_BYTES) fail('document-too-large', 'notice document is too large');
  return document;
}

export const COMPONENT_KIND_LIST = COMPONENT_KINDS;
