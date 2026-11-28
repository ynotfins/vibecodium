import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installSidecar,
  loadSidecarManifest,
  loadSidecarManifestFile,
  findSidecar,
  resolveSidecarTarget,
  verifySidecarInstall,
  validateSidecarManifest,
  SidecarError,
} from '../../src/stable/runtime/sidecar.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHIPPED = path.join(ROOT, 'vibe', 'sidecars.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-sidecar-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Builds a plain ZIP with stored and deflated entries; sizes are overridable so a corrupted
// archive can be exercised without generating gigabytes of data.
function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const declaredMethod = entry.declaredMethod ?? method;
    const declaredCompressed = entry.declaredCompressed ?? body.length;
    const declaredSize = entry.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(declaredMethod, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(declaredCompressed, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(declaredMethod, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(declaredCompressed, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

function fileEntry(entryPath, bytes, overrides = {}) {
  return { path: entryPath, sha256: sha256(bytes), sizeBytes: bytes.length, ...overrides };
}

function makeSidecar({ url, archive, files, executable = 'llama-server.exe', overrides = {}, targetOverrides = {} }) {
  return validateSidecarManifest({
    version: 1,
    sidecars: [{
      id: 'llama-server',
      version: 'b12426',
      licenses: ['mit', 'apache-2.0-with-llvm-exception'],
      publishedAt: '2026-11-15',
      source: 'ggml-org/llama.cpp',
      targets: {
        'win32-x64': {
          url,
          sha256: sha256(archive),
          sizeBytes: archive.length,
          executable,
          files,
          ...targetOverrides,
        },
      },
      ...overrides,
    }],
  }).sidecars[0];
}

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = 'http://' + ['127', '0', '0', '1'].join('.') + ':' + port + '/';
  try {
    return await run(base, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runtimeFiles(marker = 'one') {
  const exe = Buffer.from('MZ fake server ' + marker);
  const dll = Buffer.from('fake runtime dll ' + marker);
  return [
    { name: 'llama-server.exe', path: 'llama-server.exe', data: exe },
    { name: 'llama.dll', path: 'llama.dll', data: dll },
    { name: 'LICENSE-LLVM-OpenMP', path: 'LICENSE-LLVM-OpenMP', data: 'license text' },
  ];
}

function targetManifest(entries, url) {
  const archive = makeZip(entries);
  const files = entries.map((entry) => {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    return fileEntry(entry.name, data);
  });
  return { archive, files, sidecar: makeSidecar({ url, archive, files }) };
}

function plainSidecar(overrides = {}) {
  return {
    id: 'llama-server',
    version: 'b12426',
    licenses: ['mit', 'apache-2.0-with-llvm-exception'],
    publishedAt: '2026-11-15',
    source: 'ggml-org/llama.cpp',
    targets: { 'win32-x64': plainTarget() },
    ...overrides,
  };
}

function plainTarget(overrides = {}) {
  return {
    url: 'https://example.com/llama.zip',
    sha256: 'a'.repeat(64),
    sizeBytes: 10,
    executable: 'llama-server.exe',
    files: [{ path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 1 }],
    ...overrides,
  };
}

function plainManifest(sidecar = plainSidecar()) {
  return { version: 1, sidecars: [sidecar] };
}

function rejects(value, label) {
  assert.throws(() => validateSidecarManifest(value), (error) => {
    assert.ok(error instanceof SidecarError, label + ': expected a SidecarError');
    assert.equal(error.code, 'invalid-manifest', label + ': expected invalid-manifest');
    return true;
  }, label);
}

test('the shipped manifest pins the llama-server archive and its allowlisted files', () => {
  const manifest = loadSidecarManifestFile(SHIPPED);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.sidecars.length, 1);
  const sidecar = manifest.sidecars[0];
  assert.equal(sidecar.id, 'llama-server');
  assert.equal(sidecar.version, 'b12426');
  assert.deepEqual(sidecar.licenses, ['mit', 'apache-2.0-with-llvm-exception']);
  assert.equal(sidecar.publishedAt, '2026-11-15');
  assert.equal(sidecar.source, 'ggml-org/llama.cpp');
  const target = sidecar.targets['win32-x64'];
  assert.equal(target.url, 'https://github.com/ggml-org/llama.cpp/releases/download/b12426/llama-b12426-bin-win-cpu-x64.zip');
  assert.equal(target.sha256, '61145645c26cf8d7b3ed76435812192ae42f51c4c51e895936adc61dc1eb0410');
  assert.equal(target.sizeBytes, 25209516);
  assert.equal(target.executable, 'llama-server.exe');
  assert.equal(target.files.length, 23);
  const paths = target.files.map((file) => file.path);
  assert.ok(paths.includes('llama-server.exe'));
  assert.ok(paths.includes('llama-server-impl.dll'));
  assert.ok(paths.includes('llama-common.dll'));
  assert.ok(paths.includes('llama.dll'));
  assert.ok(paths.includes('ggml-base.dll'));
  assert.ok(paths.includes('ggml-cpu-x64.dll'));
  assert.ok(paths.includes('libomp.dll'));
  assert.ok(paths.includes('LICENSE-LLVM-OpenMP'));
  for (const file of target.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0);
  }
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.sidecars));
  assert.ok(Object.isFrozen(target));
  assert.ok(Object.isFrozen(target.files));
});

test('the shipped manifest parses from text and finds the sidecar by id', () => {
  const text = readFileSync(SHIPPED, 'utf8');
  const manifest = loadSidecarManifest(text);
  const sidecar = findSidecar(manifest, 'llama-server');
  assert.equal(sidecar.id, 'llama-server');
  assert.throws(() => findSidecar(manifest, 'missing'), (error) => error.code === 'unknown-sidecar');
  assert.throws(() => findSidecar(manifest, 7), (error) => error.code === 'unknown-sidecar');
});

test('the shipped manifest resolves the win32-x64 target and rejects other platforms', () => {
  const sidecar = loadSidecarManifestFile(SHIPPED).sidecars[0];
  const resolved = resolveSidecarTarget(sidecar, 'win32-x64');
  assert.equal(resolved.platformKey, 'win32-x64');
  assert.equal(resolved.target.executable, 'llama-server.exe');
  assert.ok(Object.isFrozen(resolved));
  assert.throws(() => resolveSidecarTarget(sidecar, 'linux-x64'), (error) => error.code === 'unsupported-platform');
  assert.throws(() => resolveSidecarTarget(sidecar, 'win32-ia32'), (error) => error.code === 'unsupported-platform');
  assert.throws(() => resolveSidecarTarget(sidecar, 42), (error) => error.code === 'unsupported-platform');
});

test('manifest input is rejected unless it is a plain data object', () => {
  rejects(null, 'null');
  rejects([], 'array');
  rejects('text', 'text');
  rejects(new (class Manifest {})(), 'class instance');
  rejects(Object.assign(Object.create(null), plainManifest()), 'null prototype');
  rejects({ version: 2, sidecars: plainManifest().sidecars }, 'unknown version');
  rejects({ version: 1 }, 'missing sidecars');
  rejects({ version: 1, sidecars: [], extra: true }, 'unknown key');
  rejects({ version: 1, sidecars: [] }, 'empty sidecars');
  const reserved = JSON.parse('{"version":1,"sidecars":[],"__proto__":{}}');
  rejects(reserved, 'reserved key');
});

test('manifest readers never invoke an accessor or a Proxy get trap', () => {
  let invoked = 0;
  const sidecar = plainSidecar();
  Object.defineProperty(sidecar, 'version', {
    enumerable: true,
    configurable: true,
    get() {
      invoked += 1;
      throw new Error('getter ran');
    },
  });
  rejects({ version: 1, sidecars: [sidecar] }, 'accessor');
  assert.equal(invoked, 0);

  let getHits = 0;
  const proxied = new Proxy(plainManifest(), {
    get() {
      getHits += 1;
      throw new Error('get trap ran');
    },
  });
  const accepted = validateSidecarManifest(proxied);
  assert.equal(accepted.sidecars.length, 1);
  assert.equal(getHits, 0);

  const { proxy, revoke } = Proxy.revocable(plainManifest(), {});
  revoke();
  rejects(proxy, 'revoked proxy');
});

test('sidecar fields, licenses, dates and sources are validated', () => {
  rejects(plainManifest(plainSidecar({ id: 'LLama' })), 'uppercase id');
  rejects(plainManifest(plainSidecar({ id: '..' })), 'relative id');
  rejects(plainManifest(plainSidecar({ version: '' })), 'empty version');
  rejects(plainManifest(plainSidecar({ version: 'b12426 extra' })), 'spaced version');
  rejects(plainManifest(plainSidecar({ licenses: ['cc-by-nc-4.0'] })), 'non-permissive license');
  rejects(plainManifest(plainSidecar({ licenses: ['MPL-2.0'] })), 'weak-copyleft license');
  rejects(plainManifest(plainSidecar({ licenses: [] })), 'empty licenses');
  rejects(plainManifest(plainSidecar({ licenses: ['mit', 'mit'] })), 'duplicate licenses');
  rejects(plainManifest(plainSidecar({ licenses: ['mit', 'mit', 'isc', 'bsd-2-clause', 'bsd-3-clause'] })), 'too many licenses');
  rejects(plainManifest(plainSidecar({ licenses: ["mit"].map(() => 'MIT') })), 'uppercase license');
  rejects(plainManifest(plainSidecar({ licenses: ['mit'], license: 'mit' })), 'removed license field');
  rejects(plainManifest(plainSidecar({ publishedAt: '2026-02-30' })), 'impossible date');
  rejects(plainManifest(plainSidecar({ publishedAt: '2026-1-1' })), 'short date');
  rejects(plainManifest(plainSidecar({ source: 'llama.cpp' })), 'source without owner');
  rejects(plainManifest(plainSidecar({ source: 'owner/name/extra' })), 'source with extra segment');
  rejects(plainManifest(plainSidecar({ targets: {} })), 'empty targets');
  const { targets, ...missingTargets } = plainSidecar();
  rejects(plainManifest(missingTargets), 'missing targets');
});

test('digests are normalised and sizes are bounded', () => {
  const upper = plainTarget({ sha256: 'A'.repeat(64) });
  const manifest = validateSidecarManifest(plainManifest(plainSidecar({ targets: { 'win32-x64': upper } })));
  assert.equal(manifest.sidecars[0].targets['win32-x64'].sha256, 'a'.repeat(64));
  const upperFile = plainTarget({ files: [{ path: 'llama-server.exe', sha256: 'C'.repeat(64), sizeBytes: 1 }] });
  const fileManifest = validateSidecarManifest(plainManifest(plainSidecar({ targets: { 'win32-x64': upperFile } })));
  assert.equal(fileManifest.sidecars[0].targets['win32-x64'].files[0].sha256, 'c'.repeat(64));
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ sha256: 'a'.repeat(63) }) } })), 'short digest');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ sha256: 'z'.repeat(64) }) } })), 'non-hex digest');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ sizeBytes: 0 }) } })), 'zero archive');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ sizeBytes: 64 * 1024 * 1024 + 1 }) } })), 'oversized archive');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ sizeBytes: 1.5 }) } })), 'fractional archive');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ files: [{ path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 0 }] }) } })), 'zero file');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ files: [{ path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 256 * 1024 * 1024 + 1 }] }) } })), 'oversized file');
});

test('file paths reject traversal, absolute and Win32-unsafe names', () => {
  const badPaths = [
    '../llama-server.exe',
    '..\\llama-server.exe',
    '/llama-server.exe',
    '\\llama-server.exe',
    'C:/llama-server.exe',
    'C:\\llama-server.exe',
    'folder//llama-server.exe',
    'folder/./llama-server.exe',
    'folder/../llama-server.exe',
    'folder\\llama-server.exe',
    'CON',
    'folder/NUL.dll',
    'folder/llama-server.exe.',
    'folder/llama-server.exe ',
    'folder/llama-server.exe\u0000',
    'folder/llama-server.exe\u202E',
    '',
  ];
  for (const bad of badPaths) {
    const target = plainTarget({ files: [{ path: bad, sha256: 'b'.repeat(64), sizeBytes: 1 }], executable: bad });
    rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': target } })), 'path ' + JSON.stringify(bad));
  }
  const long = 'a'.repeat(129) + '.dll';
  rejects(plainManifest(plainSidecar({
    targets: { 'win32-x64': plainTarget({ files: [{ path: long, sha256: 'b'.repeat(64), sizeBytes: 1 }], executable: long }) },
  })), 'long segment');
});

test('target keys, executable membership and file lists are validated', () => {
  rejects(plainManifest(plainSidecar({ targets: { 'android-x64': plainTarget() } })), 'unknown platform');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-ia32': plainTarget() } })), 'unknown arch');
  rejects(plainManifest(plainSidecar({
    targets: { 'win32-x64': plainTarget({ executable: 'other.exe' }) },
  })), 'executable outside the file list');
  rejects(plainManifest(plainSidecar({
    targets: { 'win32-x64': plainTarget({ executable: 'llama-server.dll', files: [{ path: 'llama-server.dll', sha256: 'b'.repeat(64), sizeBytes: 1 }] }) },
  })), 'windows executable extension');
  rejects(plainManifest(plainSidecar({
    targets: { 'win32-x64': plainTarget({ files: [] }) },
  })), 'empty file list');
  rejects(plainManifest(plainSidecar({
    targets: { 'win32-x64': plainTarget({
      files: [
        { path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 1 },
        { path: 'LLAMA-SERVER.EXE', sha256: 'c'.repeat(64), sizeBytes: 1 },
      ],
    }) },
  })), 'duplicate folded path');
  const many = [];
  for (let index = 0; index < 65; index += 1) {
    many.push({ path: 'file-' + index + '.dll', sha256: 'b'.repeat(64), sizeBytes: 1 });
  }
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ files: many, executable: 'file-0.dll' }) } })), 'too many files');
  const heavy = [];
  for (let index = 0; index < 5; index += 1) {
    heavy.push({ path: 'file-' + index + '.dll', sha256: 'b'.repeat(64), sizeBytes: 256 * 1024 * 1024 });
  }
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ files: heavy, executable: 'file-0.dll' }) } })), 'total size cap');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ executable: 'llama-server.exe', files: [{}] }) } })), 'missing file fields');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ executable: 'llama-server.exe', files: [{ path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 1, extra: true }] }) } })), 'unknown file field');
});

test('dense arrays and data descriptors are required', () => {
  const sparse = [];
  sparse[1] = { path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 1 };
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ files: sparse }) } })), 'sparse files');
  rejects({ version: 1, sidecars: new Array(2) }, 'sparse sidecars');
  const accessorFile = { path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 1 };
  Object.defineProperty(accessorFile, 'path', {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error('getter ran');
    },
  });
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ files: [accessorFile] }) } })), 'accessor file');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': Object.assign(Object.create(null), plainTarget()) } })), 'null-prototype target');
  rejects({ version: 1, sidecars: [Object.assign(Object.create(null), plainSidecar())] }, 'null-prototype sidecar');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ url: 'ftp://example.com/x' }) } })), 'ftp url');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ url: 'http://example.com/x' }) } })), 'plain http url');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ url: 'https://user:pass@example.com/x' }) } })), 'credential url');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ url: 'https://example.com/x?token=1' }) } })), 'query url');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ url: 'https://example.com/x#frag' }) } })), 'fragment url');
  const loopback = plainTarget({ url: 'http://' + ['127', '0', '0', '1'].join('.') + ':8080/x.zip' });
  assert.equal(validateSidecarManifest(plainManifest(plainSidecar({ targets: { 'win32-x64': loopback } }))).sidecars[0].targets['win32-x64'].url, loopback.url);
});

test('JSON loaders reject malformed text and unreadable files', () => {
  assert.throws(() => loadSidecarManifest('{'), (error) => error.code === 'invalid-manifest');
  assert.throws(() => loadSidecarManifest(''), (error) => error.code === 'invalid-manifest');
  assert.throws(() => loadSidecarManifest(42), (error) => error.code === 'invalid-manifest');
  assert.throws(() => loadSidecarManifestFile(path.join(ROOT, 'vibe', 'missing-sidecars.json')), (error) => error.code === 'invalid-manifest');
});

function writeRuntimeFiles(dir, entries) {
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    writeFileSync(path.join(dir, entry.name), Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data));
  }
}

function manifestForFiles(entries, url = 'http://' + ['127', '0', '0', '1'].join('.') + ':9/x.zip') {
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(
    entry.name,
    Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? ''),
  ));
  return { archive, files, sidecar: makeSidecar({ url, archive, files }) };
}

test('verifySidecarInstall reports missing, size, checksum and unsafe paths without network', async (t) => {
  const base = tempDir(t);
  const files = runtimeFiles('verify');
  const sidecar = manifestForFiles(files).sidecar;
  const empty = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', targetDir: path.join(base, 'empty') });
  assert.deepEqual(empty, Object.freeze({ verified: false, reason: 'missing', version: 'b12426' }));

  const dir = path.join(base, 'installed');
  writeRuntimeFiles(dir, files);
  const verified = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', targetDir: dir });
  assert.equal(verified.verified, true);
  assert.equal(verified.version, 'b12426');
  assert.equal(verified.executablePath, path.join(dir, 'llama-server.exe'));
  assert.equal(verified.sizeBytes, files.reduce((total, entry) => total + Buffer.from(entry.data).length, 0));
  assert.ok(Object.isFrozen(verified));
  assert.ok(Object.isFrozen(verified.files));
  assert.ok(verified.files.every((file) => Object.isFrozen(file)));

  writeFileSync(path.join(dir, 'llama.dll'), Buffer.from('short'));
  const sized = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', targetDir: dir });
  assert.equal(sized.reason, 'size');

  writeFileSync(path.join(dir, 'llama.dll'), Buffer.from('fake runtime dll verifX'));
  const digest = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', targetDir: dir });
  assert.equal(digest.reason, 'checksum');
});

test('verifySidecarInstall refuses a symbolic link where the host allows creating one', async (t) => {
  const base = tempDir(t);
  const files = runtimeFiles('symlink');
  const sidecar = manifestForFiles(files).sidecar;
  const dir = path.join(base, 'linked');
  writeRuntimeFiles(dir, files.slice(1));
  const target = path.join(dir, 'llama-server.exe');
  const outside = path.join(base, 'outside.exe');
  writeFileSync(outside, Buffer.from(files[0].data));
  try {
    symlinkSync(outside, target);
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('this host cannot create a file symlink without elevation');
      return;
    }
    throw error;
  }
  assert.ok(lstatSync(target).isSymbolicLink());
  const result = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', targetDir: dir });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'unsafe-path');
});

test('installSidecar downloads, verifies, extracts only the allowlist and skips a verified install', async (t) => {
  const entries = runtimeFiles('e2e');
  const extra = { name: 'README.txt', data: 'not part of the allowlist' };
  const archive = makeZip([...entries, extra]);
  let requests = 0;
  await withServer((request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': archive.length });
    response.end(archive);
  }, async (base) => {
    const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
    const sidecar = makeSidecar({ url: base + 'llama.zip', archive, files });
    const dir = path.join(tempDir(t), 'runtime');
    const progress = [];
    const result = await installSidecar(sidecar, { platformKey: 'win32-x64',
      targetDir: dir,
      onProgress: (event) => progress.push(event),
    });
    assert.equal(requests, 1);
    assert.equal(result.verified, true);
    assert.equal(result.installed, true);
    assert.equal(result.skipped, false);
    assert.equal(result.executablePath, path.join(dir, 'llama-server.exe'));
    assert.equal(result.version, 'b12426');
    assert.ok(Object.isFrozen(result));
    for (const entry of entries) {
      assert.deepEqual(readFileSync(path.join(dir, entry.name)), Buffer.from(entry.data));
    }
    assert.equal(lstatSync(path.join(dir, 'README.txt'), { throwIfNoEntry: false }), undefined);
    assert.ok(progress.length >= 2);
    assert.ok(progress.every((event) => Object.isFrozen(event)));
    assert.equal(progress[progress.length - 1].received, archive.length);
    assert.equal(progress[progress.length - 1].total, archive.length);

    const second = await installSidecar(sidecar, { platformKey: 'win32-x64',
      targetDir: dir,
      fetchImpl: () => {
        throw new Error('the second install must not open a socket');
      },
    });
    assert.equal(requests, 1);
    assert.equal(second.verified, true);
    assert.equal(second.installed, false);
    assert.equal(second.skipped, true);

    const verified = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', targetDir: dir });
    assert.equal(verified.verified, true);
    assert.equal(verified.executablePath, result.executablePath);
  });
});

test('installSidecar installs from an injected fetch without a socket', async (t) => {
  const entries = runtimeFiles('injected');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({
    url: 'https://example.com/llama.zip',
    archive,
    files,
  });
  const dir = path.join(tempDir(t), 'runtime');
  let calls = 0;
  const result = await installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url, 'https://example.com/llama.zip');
      return {
        status: 200,
        url: 'https://release-assets.example/llama.zip?sp=r&sig=abc123',
        headers: { get: () => String(archive.length) },
        body: (async function* body() {
          yield archive.subarray(0, 7);
          yield archive.subarray(7);
        })(),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.installed, true);
  assert.deepEqual(readFileSync(path.join(dir, 'llama-server.exe')), Buffer.from(entries[0].data));
});

function archiveResponse(archive, url = 'https://example.com/llama.zip') {
  return {
    status: 200,
    url,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(archive.length) : null) },
    body: (async function* body() {
      yield archive;
    })(),
  };
}

async function expectFailure(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof SidecarError, 'expected a SidecarError for ' + code);
    assert.equal(error.code, code);
    return true;
  });
}

function assertNoInstalledFiles(dir, allowed = []) {
  const info = lstatSync(dir, { throwIfNoEntry: false });
  if (!info) return;
  const present = readdirSync(dir).filter((name) => !allowed.includes(name));
  assert.deepEqual(present, []);
}

test('a corrupt archive digest installs nothing', async (t) => {
  const entries = runtimeFiles('digest');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({
    url: 'https://example.com/llama.zip',
    archive,
    files,
    targetOverrides: { sha256: '0'.repeat(64) },
  });
  const dir = path.join(tempDir(t), 'runtime');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  }), 'checksum-mismatch');
  assertNoInstalledFiles(dir);
});

test('a pinned entry with a wrong digest or size fails before anything is installed', async (t) => {
  const entries = runtimeFiles('entry');
  const archive = makeZip(entries);
  const badDigest = entries.map((entry, index) => fileEntry(
    entry.name,
    Buffer.from(entry.data),
    index === 1 ? { sha256: '0'.repeat(64) } : {},
  ));
  const digestSidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files: badDigest });
  const dirOne = path.join(tempDir(t), 'digest');
  await expectFailure(installSidecar(digestSidecar, { platformKey: 'win32-x64',
    targetDir: dirOne,
    fetchImpl: async () => archiveResponse(archive),
  }), 'entry-checksum');
  assertNoInstalledFiles(dirOne);

  const badSize = entries.map((entry, index) => fileEntry(
    entry.name,
    Buffer.from(entry.data),
    index === 1 ? { sizeBytes: Buffer.from(entry.data).length + 1 } : {},
  ));
  const sizeSidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files: badSize });
  const dirTwo = path.join(tempDir(t), 'size');
  await expectFailure(installSidecar(sizeSidecar, { platformKey: 'win32-x64',
    targetDir: dirTwo,
    fetchImpl: async () => archiveResponse(archive),
  }), 'entry-size');
  assertNoInstalledFiles(dirTwo);
});

test('a missing allowlisted entry fails closed', async (t) => {
  const entries = runtimeFiles('missing');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  files.push(fileEntry('ggml.dll', Buffer.from('not in the archive')));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  }), 'missing-entry');
  assertNoInstalledFiles(dir);
});

test('HTTP failures, an insecure redirect and a missing body are bounded', async (t) => {
  const entries = runtimeFiles('http');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async (url) => ({ status: 503, url, headers: { get: () => null }, body: { cancel: async () => {} } }),
  }), 'http-status');

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => ({ status: 200, url: 'http://evil.example/llama.zip', headers: { get: () => null }, body: null }),
  }), 'insecure-redirect');

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => ({ status: 200, url: 'https://user:x/llama.zip', headers: { get: () => null }, body: null }),
  }), 'insecure-redirect');

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => ({ status: 200, url: 'https://example.com/llama.zip#fragment', headers: { get: () => null }, body: null }),
  }), 'insecure-redirect');

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async (url) => ({ status: 200, url, headers: { get: () => null }, body: null }),
  }), 'invalid-response');

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async (url) => ({
      status: 200,
      url,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(archive.length + 1) : null) },
      body: { cancel: async () => {} },
    }),
  }), 'size-mismatch');
  assertNoInstalledFiles(dir);
});

test('a stalled transfer, a total timeout and a caller abort are bounded and keep no partial archive', async (t) => {
  const entries = runtimeFiles('stall');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    idleTimeoutMs: 50,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }), 'stalled');

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    totalTimeoutMs: 1000,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }), 'timeout');

  const controller = new AbortController();
  controller.abort();
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    signal: controller.signal,
    fetchImpl: async () => {
      throw new Error('must not be called');
    },
  }), 'aborted');
  assertNoInstalledFiles(dir);
});

test('a second concurrent install of the same directory is refused', async (t) => {
  const entries = runtimeFiles('busy');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => {
      await gate;
      return archiveResponse(archive);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  }), 'busy');
  release();
  const result = await first;
  assert.equal(result.installed, true);
});

test('install options and verification options are validated', async (t) => {
  const entries = runtimeFiles('options');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',}), 'invalid-options');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', targetDir: dir, unknown: true }), 'invalid-options');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', targetDir: dir, idleTimeoutMs: 1 }), 'invalid-options');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', targetDir: dir, signal: {} }), 'invalid-options');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', targetDir: 'relative/runtime' }), 'invalid-destination');
  await expectFailure(installSidecar(sidecar, { targetDir: dir, platformKey: 'linux-x64' }), 'unsupported-platform');
  await expectFailure(verifySidecarInstall(sidecar, { platformKey: 'win32-x64', targetDir: dir, unknown: true }), 'invalid-options');

  let invoked = 0;
  const options = {};
  Object.defineProperty(options, 'targetDir', {
    enumerable: true,
    configurable: true,
    get() {
      invoked += 1;
      throw new Error('getter ran');
    },
  });
  await expectFailure(installSidecar(sidecar, options), 'invalid-options');
  assert.equal(invoked, 0);
});

async function installArchive(t, entries, manifestEntries, code, options = {}) {
  const archive = makeZip(entries);
  const files = manifestEntries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files, ...options });
  const dir = path.join(tempDir(t), 'runtime');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  }), code);
  assertNoInstalledFiles(dir);
  return dir;
}

test('unsafe archive entry names and symbolic links are refused', async (t) => {
  const entries = runtimeFiles('unsafe');
  await installArchive(t, [...entries, { name: '../evil.dll', data: 'x' }], entries, 'unsafe-entry');
  await installArchive(t, [...entries, { name: '/evil.dll', data: 'x' }], entries, 'unsafe-entry');
  await installArchive(t, [...entries, { name: 'folder\\evil.dll', data: 'x' }], entries, 'unsafe-entry');
  await installArchive(t, [...entries, { name: 'C:/evil.dll', data: 'x' }], entries, 'unsafe-entry');
  await installArchive(t, [...entries, { name: 'NUL.tar.gz', data: 'x' }], entries, 'unsafe-entry');
  await installArchive(t, [...entries, { name: 'CON.foo.exe', data: 'x' }], entries, 'unsafe-entry');
  const linked = entries.map((entry, index) => (
    index === 0 ? { ...entry, externalAttributes: (0o120777 << 16) >>> 0 } : entry
  ));
  await installArchive(t, linked, entries, 'unsafe-entry');
});

test('duplicate, unsupported, truncated and oversized archives fail closed', async (t) => {
  const entries = runtimeFiles('badzip');
  await installArchive(t, [...entries, { name: 'llama-server.exe', data: 'dup' }], entries, 'invalid-archive');
  const unsupported = entries.map((entry, index) => (index === 0 ? { ...entry, declaredMethod: 99 } : entry));
  await installArchive(t, unsupported, entries, 'invalid-archive');

  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const truncated = archive.subarray(0, archive.length - 5);
  const truncatedSidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive: truncated, files });
  const truncatedDir = path.join(tempDir(t), 'truncated');
  await expectFailure(installSidecar(truncatedSidecar, { platformKey: 'win32-x64',
    targetDir: truncatedDir,
    fetchImpl: async () => archiveResponse(truncated),
  }), 'invalid-archive');
  assertNoInstalledFiles(truncatedDir);
  const notZip = Buffer.from('not a zip at all');
  const notZipSidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive: notZip, files });
  const notZipDir = path.join(tempDir(t), 'not-zip');
  await expectFailure(installSidecar(notZipSidecar, { platformKey: 'win32-x64',
    targetDir: notZipDir,
    fetchImpl: async () => archiveResponse(notZip),
  }), 'invalid-archive');
  assertNoInstalledFiles(notZipDir);

  const huge = entries.map((entry, index) => (
    index === 0 ? { ...entry, declaredSize: 300 * 1024 * 1024 } : entry
  ));
  await installArchive(t, huge, entries, 'entry-too-large');
});

test('a directory entry and an unlisted file in the archive are ignored', async (t) => {
  const entries = runtimeFiles('ignore');
  const archive = makeZip([
    ...entries,
    { name: 'docs/', data: '' },
    { name: 'docs/README.md', data: 'ignored' },
  ]);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  const result = await installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  });
  assert.equal(result.installed, true);
  assert.equal(lstatSync(path.join(dir, 'docs'), { throwIfNoEntry: false }), undefined);
});

test('errors and results never echo the URL, an entry body or the injected error', async (t) => {
  const entries = runtimeFiles('leak');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/secret-path/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  let message = '';
  await assert.rejects(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => ({
      status: 500,
      url: 'https://example.com/secret-path/llama.zip',
      headers: { get: () => null },
      body: {
        cancel: async () => {},
        [Symbol.asyncIterator]: async function* body() { yield Buffer.from('SECRET-BODY'); },
      },
    }),
  }), (error) => {
    message = error && error.message ? error.message : '';
    assert.equal(error.code, 'http-status');
    assert.equal(error.status, 500);
    return true;
  });
  assert.ok(!message.includes('example.com'));
  assert.ok(!message.includes('secret-path'));
  assert.ok(!message.includes('SECRET-BODY'));

  let thrown = '';
  await assert.rejects(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => { throw new Error('connection to 10.0.0.1 failed'); },
  }), (error) => {
    thrown = error && error.message ? error.message : '';
    assert.equal(error.code, 'network-error');
    return true;
  });
  assert.ok(!thrown.includes('10.0.0.1'));

  const good = await (async () => {
    const okArchive = makeZip(entries);
    const okFiles = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
    const okSidecar = makeSidecar({ url: 'https://example.com/secret-path/llama.zip', archive: okArchive, files: okFiles });
    return installSidecar(okSidecar, { platformKey: 'win32-x64',
      targetDir: dir,
      fetchImpl: async () => archiveResponse(okArchive, 'https://example.com/secret-path/llama.zip'),
    });
  })();
  const serialized = JSON.stringify(good);
  assert.ok(!serialized.includes('example.com'));
  assert.ok(!serialized.includes('secret-path'));
});

test('the installed executable satisfies the supervisor path contract', async (t) => {
  const entries = runtimeFiles('contract');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  const result = await installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  });
  const { validateLlamaExecutablePath } = await import('../../src/stable/runtime/llama-server.mjs');
  assert.equal(validateLlamaExecutablePath(result.executablePath), result.executablePath);
  if (process.platform !== 'win32') {
    assert.ok((lstatSync(result.executablePath).mode & 0o111) !== 0);
  }
});

function patchEocd(buffer, offset, value) {
  const copy = Buffer.from(buffer);
  copy.writeUInt16LE(value, copy.length - 22 + offset);
  return copy;
}

test('a final URL on an internal literal host is refused when the pin was not loopback', async (t) => {
  const entries = runtimeFiles('internal');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  const hosts = [
    'https://' + ['127', '0', '0', '1'].join('.') + '/llama.zip',
    'https://' + ['10', '0', '0', '1'].join('.') + '/llama.zip',
    'https://' + ['192', '168', '1', '1'].join('.') + '/llama.zip',
    'https://' + ['169', '254', '169', '254'].join('.') + '/llama.zip',
    'https://localhost/llama.zip',
    'https://localhost./llama.zip',
    'https://[::1]/llama.zip',
    'https://[::ffff:7f00:1]/llama.zip',
    'https://[::7f00:1]/llama.zip',
    'https://[::ffff:0:7f00:1]/llama.zip',
    'https://[64:ff9b::7f00:1]/llama.zip',
    'https://[64:ff9b:1::a00:1]/llama.zip',
    'https://[2002:7f00:1::]/llama.zip',
    'https://[fe80::1]/llama.zip',
    'https://[febf::1]/llama.zip',
    'https://[fd00::1]/llama.zip',
    'https://[ff02::1]/llama.zip',
    'https://' + ['100', '64', '0', '1'].join('.') + '/llama.zip',
    'https://' + ['198', '18', '0', '1'].join('.') + '/llama.zip',
    'https://' + ['240', '0', '0', '1'].join('.') + '/llama.zip',
  ];
  for (const url of hosts) {
    await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
      targetDir: dir,
      fetchImpl: async () => ({ status: 200, url, headers: { get: () => null }, body: null }),
    }), 'insecure-redirect');
  }
  assertNoInstalledFiles(dir);
});

test('a symlinked target directory or nested parent is refused', async (t) => {
  const entries = runtimeFiles('symlink-dir');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const root = tempDir(t);
  const real = path.join(root, 'real');
  mkdirSync(real);
  const link = path.join(root, 'link');
  try {
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('this host cannot create a directory symlink without elevation');
      return;
    }
    throw error;
  }
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: link,
    fetchImpl: async () => archiveResponse(archive),
  }), 'invalid-destination');

  const dir = path.join(root, 'runtime');
  mkdirSync(dir);
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(dir, 'linkd'), process.platform === 'win32' ? 'junction' : 'dir');
  const nestedEntries = [{ name: 'linkd/llama-server.exe', data: 'MZ nested' }];
  const nestedArchive = makeZip(nestedEntries);
  const nestedFiles = nestedEntries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const nested = makeSidecar({
    url: 'https://example.com/llama.zip',
    archive: nestedArchive,
    files: nestedFiles,
    executable: 'linkd/llama-server.exe',
  });
  await expectFailure(installSidecar(nested, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(nestedArchive),
  }), 'unsafe-path');
  assert.deepEqual(readdirSync(outside), []);
});

test('ZIP64, multi-disk, encrypted and unsafe archive names fail closed', async (t) => {
  const entries = runtimeFiles('zipflags');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const make = (badArchive) => makeSidecar({ url: 'https://example.com/llama.zip', archive: badArchive, files });
  const dir = path.join(tempDir(t), 'runtime');

  const zip64 = patchEocd(patchEocd(archive, 8, 0xffff), 10, 0xffff);
  await expectFailure(installSidecar(make(zip64), { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(zip64),
  }), 'invalid-archive');

  const multiDisk = patchEocd(archive, 4, 1);
  await expectFailure(installSidecar(make(multiDisk), { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(multiDisk),
  }), 'invalid-archive');

  const encrypted = makeZip(entries.map((entry) => ({ ...entry, flags: 1 })));
  const encryptedFiles = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  await expectFailure(installSidecar(makeSidecar({
    url: 'https://example.com/llama.zip',
    archive: encrypted,
    files: encryptedFiles,
  }), { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(encrypted),
  }), 'invalid-archive');

  for (const name of ['evil.', 'evil ', 'evil\u202E', 'CON.tar.gz']) {
    const unsafe = makeZip([...entries, { name, data: 'x' }]);
    await expectFailure(installSidecar(make(unsafe), { platformKey: 'win32-x64',
      targetDir: dir,
      fetchImpl: async () => archiveResponse(unsafe),
    }), 'unsafe-entry');
  }
  assertNoInstalledFiles(dir);
});

test('a nested executable path is installed inside the target directory only', async (t) => {
  const entries = [
    { name: 'bin/llama-server.exe', data: Buffer.from('MZ nested') },
    { name: 'bin/llama.dll', data: Buffer.from('nested dll') },
  ];
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({
    url: 'https://example.com/llama.zip',
    archive,
    files,
    executable: 'bin/llama-server.exe',
  });
  const dir = path.join(tempDir(t), 'runtime');
  const result = await installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  });
  assert.equal(result.executablePath, path.join(dir, 'bin', 'llama-server.exe'));
  assert.equal(readFileSync(result.executablePath, 'utf8'), 'MZ nested');
});

// Every pinned file is repeated here so an accidental edit to the shipped pin cannot pass unnoticed.
const PINNED_FILE_TABLE = `
LICENSE-LLVM-OpenMP|19741|fdad1758a9e1f9d5a81e18879b3406772115edc92c24bfa36b70c654f325e8e4
ggml-base.dll|832000|60a2c224d4b846018ee2d150c677af7c754ec914905d4d778d4ccc71887d2c1a
ggml-cpu-alderlake.dll|1461760|90e05ec7829cc1909305bca96c9c45879d4171ce8dc72dee740fde946dfe62d0
ggml-cpu-cannonlake.dll|1695232|4fdb5888833706e4f96d618c43ebbc92377a3be9df2bb664932b7bff98010602
ggml-cpu-cascadelake.dll|1668096|6f02134ab5cc1192f357ac960945831236941a560127a49e9113f42b18306539
ggml-cpu-cooperlake.dll|1677824|ead953d09b401740599b54b7b3f08fb90857319d60d0a9c4568657f3a8bda55f
ggml-cpu-haswell.dll|1466880|2724efbb48b123d22c2a22bcfeb8f088b35d12ffbae9a84b96925abed094980e
ggml-cpu-icelake.dll|1674752|85b1c40d6bbc55340c7534a49494dc61924658061fcf9a14778add5bc7f72230
ggml-cpu-ivybridge.dll|1348096|3e495daddf8c46aff31f1520eb698bb97888444bd22809847a5cc869d444bc62
ggml-cpu-piledriver.dll|1341440|96ccd3e75a9165934ecebb047b75c0540bafff50365b743d5808588bdef97752
ggml-cpu-sandybridge.dll|1316352|c026d6691331de698ff5fd04c8a69f9381bd02199b3ecf0ad4a64c2f7c46d79a
ggml-cpu-sapphirerapids.dll|1954304|295acfa23c4918df2e8b578344c92e2cb518b10a1cb36a8e0e59bd94d09d146e
ggml-cpu-skylakex.dll|1688064|584e292c060e2e15076ce331bc859172cb43def5b8e2cf236c90153b4b48d610
ggml-cpu-sse42.dll|939520|fae759bc2728c434f61c78039153c93670025cfb010ef2e86e68f4452b329b84
ggml-cpu-x64.dll|932352|ab755f6ebf270d0e7bb660e8db59c067508f568fbe0980cde3d37d963fa82d60
ggml-cpu-zen4.dll|1683968|09001f9f1374005e1c27a0fc599932dca36f221d16032d80661c9ff387471b8c
ggml.dll|78848|341c2295de3cecb3722da74184d9a62bcf18d4c99db04f86f3629f1ccec030bb
libomp.dll|768000|a12116ba72d1d6820407cf30be23da04ce79d6bb8a71a5ee71759c5a1faa6f1c
llama-common.dll|8542208|4612027595411390e304615ec83f6754539f984b222c2565869fc45247144ff9
llama-server-impl.dll|10352128|fd3cfe5ee696fe01f4f79dee6dd54c1ce7a967a9cb851ea2162ea1cab7961858
llama-server.exe|9728|693d45d4a9f47c70f7f373fcfafcb673784546d7fcf6e46c09da913e851ccafd
llama.dll|3909632|19d14e50d61febaaaae55ef5004942848a064251937773332951692439719686
mtmd.dll|2435584|d4536a2349e404e13ebb83209b831e384536d62185b1d07465ce95f8d826a375
`.trim().split('\n').map((line) => {
  const [filePath, sizeBytes, sha256] = line.split('|');
  return { path: filePath, sizeBytes: Number(sizeBytes), sha256 };
});

test('the shipped manifest pins every file with its exact byte size and digest', () => {
  const target = loadSidecarManifestFile(SHIPPED).sidecars[0].targets['win32-x64'];
  assert.equal(PINNED_FILE_TABLE.length, 23);
  assert.equal(target.files.length, PINNED_FILE_TABLE.length);
  const actual = new Map(target.files.map((file) => [file.path, file]));
  assert.equal(actual.size, 23);
  for (const expected of PINNED_FILE_TABLE) {
    const file = actual.get(expected.path);
    assert.ok(file, 'missing pinned file ' + expected.path);
    assert.equal(file.sizeBytes, expected.sizeBytes, expected.path + ' size');
    assert.equal(file.sha256, expected.sha256, expected.path + ' digest');
  }
  assert.equal(target.files.reduce((total, file) => total + file.sizeBytes, 0), 47_796_509);
  assert.equal(target.sizeBytes, 25_209_516);
  assert.equal(target.sha256, '61145645c26cf8d7b3ed76435812192ae42f51c4c51e895936adc61dc1eb0410');
});

test('nested reserved keys and class-instance entries fail closed', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const sidecar = plainSidecar();
    Object.defineProperty(sidecar, key, { enumerable: true, configurable: true, value: 1 });
    rejects(plainManifest(sidecar), 'sidecar ' + key);

    const target = plainTarget();
    Object.defineProperty(target, key, { enumerable: true, configurable: true, value: 1 });
    rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': target } })), 'target ' + key);

    const file = { path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 1 };
    Object.defineProperty(file, key, { enumerable: true, configurable: true, value: 1 });
    rejects(plainManifest(plainSidecar({
      targets: { 'win32-x64': plainTarget({ files: [file] }) },
    })), 'file ' + key);
  }

  class SidecarEntry {
    constructor() { Object.assign(this, plainSidecar()); }
  }
  class TargetEntry {
    constructor() { Object.assign(this, plainTarget()); }
  }
  class FileEntry {
    constructor() { Object.assign(this, { path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 1 }); }
  }
  rejects(plainManifest(new SidecarEntry()), 'sidecar class instance');
  rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': new TargetEntry() } })), 'target class instance');
  rejects(plainManifest(plainSidecar({
    targets: { 'win32-x64': plainTarget({ files: [new FileEntry()] }) },
  })), 'file class instance');
});

test('a nested array Proxy is read without running its get trap', () => {
  let hits = 0;
  const sidecars = new Proxy(plainManifest().sidecars, {
    get(target, property, receiver) {
      hits += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const manifest = validateSidecarManifest({ version: 1, sidecars });
  assert.equal(manifest.sidecars.length, 1);
  assert.equal(hits, 0);

  let fileHits = 0;
  const files = new Proxy(plainTarget().files, {
    get(target, property, receiver) {
      fileHits += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  validateSidecarManifest(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ files }) } })));
  assert.equal(fileHits, 0);
});

test('reserved Win32 device names with multiple extensions are rejected', () => {
  for (const bad of ['NUL.tar.gz', 'CON.foo.bar', 'COM1.a.b', 'LPT1.tar.gz', 'CON.foo.exe']) {
    const files = [
      { path: 'llama-server.exe', sha256: 'b'.repeat(64), sizeBytes: 1 },
      { path: bad, sha256: 'c'.repeat(64), sizeBytes: 1 },
    ];
    rejects(plainManifest(plainSidecar({ targets: { 'win32-x64': plainTarget({ files }) } })), 'reserved ' + bad);
  }
});

test('the archive request is one credential-free GET and only an allowed final URL is accepted', async (t) => {
  const entries = runtimeFiles('request');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  const calls = [];
  const result = await installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return archiveResponse(archive);
    },
  });
  assert.equal(result.installed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/llama.zip');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'follow');
  assert.deepEqual(calls[0].init.headers, { accept: 'application/zip' });
  assert.equal(typeof calls[0].init.signal.addEventListener, 'function');
  assert.equal(typeof calls[0].init.signal.aborted, 'boolean');

  const second = path.join(tempDir(t), 'second');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: second,
    fetchImpl: async () => archiveResponse(archive, 'http://' + ['127', '0', '0', '1'].join('.') + ':8080/llama.zip'),
  }), 'insecure-redirect');
  assertNoInstalledFiles(second);
});

test('a loopback pin accepts a loopback redirect that carries a query', async (t) => {
  const entries = runtimeFiles('loopback');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'http://' + ['127', '0', '0', '1'].join('.') + ':9/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  const result = await installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive, 'http://' + ['127', '0', '0', '1'].join('.') + ':8080/llama.zip?sp=r&sig=abc'),
  });
  assert.equal(result.installed, true);
  assert.equal(readFileSync(path.join(dir, 'llama-server.exe'), 'utf8'), Buffer.from(entries[0].data).toString());
});

test('a streamed archive that exceeds or falls short of the pin fails and leaves no part file', async (t) => {
  const entries = runtimeFiles('stream');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });

  const overDir = path.join(tempDir(t), 'over');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: overDir,
    fetchImpl: async () => ({
      status: 200,
      url: 'https://example.com/llama.zip',
      headers: { get: () => null },
      body: (async function* body() {
        yield archive;
        yield Buffer.from([0]);
      })(),
    }),
  }), 'size-mismatch');
  assertNoInstalledFiles(overDir);
  assert.deepEqual(readdirSync(overDir), []);

  const underDir = path.join(tempDir(t), 'under');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: underDir,
    fetchImpl: async () => ({
      status: 200,
      url: 'https://example.com/llama.zip',
      headers: { get: () => null },
      body: (async function* body() {
        yield archive.subarray(0, archive.length - 1);
      })(),
    }),
  }), 'network-error');
  assertNoInstalledFiles(underDir);
  assert.deepEqual(readdirSync(underDir), []);
});

test('verify options are read through own data descriptors', async (t) => {
  const sidecar = manifestForFiles(runtimeFiles('verify-options')).sidecar;
  let invoked = 0;
  const options = {};
  Object.defineProperty(options, 'targetDir', {
    enumerable: true,
    configurable: true,
    get() {
      invoked += 1;
      throw new Error('getter ran');
    },
  });
  await expectFailure(verifySidecarInstall(sidecar, options), 'invalid-options');
  assert.equal(invoked, 0);

  let hits = 0;
  const proxied = new Proxy({ platformKey: 'win32-x64', targetDir: path.join(tempDir(t), 'runtime') }, {
    get(target, property, receiver) {
      hits += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = await verifySidecarInstall(sidecar, proxied);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'missing');
  assert.equal(hits, 0);
});

test('findSidecar and resolveSidecarTarget read their inputs without invoking a getter', () => {
  const validated = validateSidecarManifest(plainManifest());
  let invoked = 0;
  const manifest = { sidecars: validated.sidecars };
  Object.defineProperty(manifest, 'sidecars', {
    enumerable: true,
    configurable: true,
    get() {
      invoked += 1;
      return validated.sidecars;
    },
  });
  assert.throws(() => findSidecar(manifest, 'llama-server'), (error) => error.code === 'unknown-sidecar');
  assert.equal(invoked, 0);

  let targetsInvoked = 0;
  const sidecar = Object.getOwnPropertyDescriptor(validated.sidecars, '0').value;
  const holder = { targets: sidecar.targets };
  Object.defineProperty(holder, 'targets', {
    enumerable: true,
    configurable: true,
    get() {
      targetsInvoked += 1;
      return sidecar.targets;
    },
  });
  assert.throws(() => resolveSidecarTarget(holder, 'win32-x64'), (error) => error.code === 'unsupported-platform');
  assert.equal(targetsInvoked, 0);

  let hits = 0;
  const sidecars = new Proxy(validated.sidecars, {
    get(target, property, receiver) {
      hits += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal(findSidecar({ sidecars }, 'llama-server').id, 'llama-server');
  assert.equal(hits, 0);
});

test('a successful install removes the archive and leaves no temporary file', async (t) => {
  const entries = runtimeFiles('clean');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  const result = await installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  });
  assert.equal(result.installed, true);
  assert.deepEqual(readdirSync(dir).sort(), entries.map((entry) => entry.name).sort());
  assert.ok(!readdirSync(dir).some((name) => name.endsWith('.zip.part') || name.startsWith('.install-')));
});

test('a failed rename leaves no temporary file and no unverified file; the skip path reports the partial install', async (t) => {
  const entries = runtimeFiles('rename');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  mkdirSync(path.join(dir, 'llama.dll'), { recursive: true });
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  }), 'install-failed');
  assert.deepEqual(readdirSync(dir).sort(), ['llama-server.exe', 'llama.dll'].sort());
  assert.ok(lstatSync(path.join(dir, 'llama.dll')).isDirectory());
  assert.deepEqual(readFileSync(path.join(dir, 'llama-server.exe')), Buffer.from(entries[0].data));
  const result = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', targetDir: dir });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'unsafe-path');
});

test('an unsafe archive entry name is not echoed in the error', async (t) => {
  const entries = runtimeFiles('echo');
  const archive = makeZip([...entries, { name: '/secret/evil.dll', data: 'x' }]);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/secret-path/llama.zip', archive, files });
  const dir = path.join(tempDir(t), 'runtime');
  let message = '';
  await assert.rejects(installSidecar(sidecar, { platformKey: 'win32-x64',
    targetDir: dir,
    fetchImpl: async () => archiveResponse(archive),
  }), (error) => {
    message = error && error.message ? error.message : '';
    assert.equal(error.code, 'unsafe-entry');
    return true;
  });
  assert.ok(!message.includes('secret'));
  assert.ok(!message.includes('evil.dll'));
  assert.ok(!message.includes('example.com'));
  assertNoInstalledFiles(dir);
});

// --- Installer-owned runtime directory (M3: a webview path never reaches a write) ---

function ownedTargetDir(root, sidecar = 'llama-server', version = 'b12426') {
  return path.join(root, 'runtime', 'win32-x64', sidecar + '-' + version);
}

test('installSidecar with ownedRoot derives the installer-owned runtime directory', async (t) => {
  const entries = runtimeFiles('owned');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  let requests = 0;
  await withServer((request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': archive.length });
    response.end(archive);
  }, async (base) => {
    const sidecar = makeSidecar({ url: base + 'llama.zip', archive, files });
    const root = tempDir(t);
    const result = await installSidecar(sidecar, { platformKey: 'win32-x64', ownedRoot: root });
    const expected = ownedTargetDir(root);
    assert.equal(requests, 1);
    assert.equal(result.installed, true);
    assert.equal(result.verified, true);
    assert.equal(result.executablePath, path.join(expected, 'llama-server.exe'));
    for (const entry of entries) {
      assert.deepEqual(readFileSync(path.join(expected, entry.name)), Buffer.from(entry.data));
    }
    assert.equal(lstatSync(path.join(root, 'runtime'), { throwIfNoEntry: false }).isDirectory(), true);

    const second = await installSidecar(sidecar, { platformKey: 'win32-x64', ownedRoot: root,
      fetchImpl: () => {
        throw new Error('the second install must not open a socket');
      },
    });
    assert.equal(requests, 1);
    assert.equal(second.skipped, true);
  });
});

test('verifySidecarInstall with ownedRoot verifies the derived directory without a caller path', async (t) => {
  const entries = runtimeFiles('owned-verify');
  const sidecar = manifestForFiles(entries).sidecar;
  const root = tempDir(t);
  const dir = ownedTargetDir(root);
  const missing = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', ownedRoot: root });
  assert.deepEqual(missing, Object.freeze({ verified: false, reason: 'missing', version: 'b12426' }));

  writeRuntimeFiles(dir, entries);
  const verified = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', ownedRoot: root });
  assert.equal(verified.verified, true);
  assert.equal(verified.executablePath, path.join(dir, 'llama-server.exe'));

  writeFileSync(path.join(dir, 'llama.dll'), Buffer.from('short'));
  const sized = await verifySidecarInstall(sidecar, { platformKey: 'win32-x64', ownedRoot: root });
  assert.equal(sized.reason, 'size');
});

test('ownedRoot is required or exclusive and never accepts a caller directory', async (t) => {
  const entries = runtimeFiles('owned-options');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const root = tempDir(t);
  const targetDir = path.join(root, 'runtime');

  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return archiveResponse(archive);
  };

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64' }), 'invalid-options');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', ownedRoot: root, targetDir, fetchImpl }), 'invalid-options');
  await expectFailure(verifySidecarInstall(sidecar, { platformKey: 'win32-x64', ownedRoot: root, targetDir }), 'invalid-options');
  await expectFailure(verifySidecarInstall(sidecar, { platformKey: 'win32-x64' }), 'invalid-options');
  assert.equal(fetched, 0);
  assert.equal(lstatSync(path.join(root, 'runtime'), { throwIfNoEntry: false }), undefined);
});

test('an ownedRoot the installer cannot own is refused as invalid-destination', async (t) => {
  const entries = runtimeFiles('owned-escape');
  const archive = makeZip(entries);
  const files = entries.map((entry) => fileEntry(entry.name, Buffer.from(entry.data)));
  const sidecar = makeSidecar({ url: 'https://example.com/llama.zip', archive, files });
  const root = tempDir(t);
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return archiveResponse(archive);
  };

  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', ownedRoot: 'relative/appdata', fetchImpl }), 'invalid-destination');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', ownedRoot: 42, fetchImpl }), 'invalid-destination');
  const file = path.join(root, 'not-a-directory');
  writeFileSync(file, 'x');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', ownedRoot: file, fetchImpl }), 'invalid-destination');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', ownedRoot: path.parse(root).root, fetchImpl }), 'invalid-destination');
  await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', ownedRoot: path.join(root, 'a\u202Eb'), fetchImpl }), 'invalid-destination');
  assert.equal(lstatSync(path.join(root, 'runtime'), { throwIfNoEntry: false }), undefined);

  const owned = path.join(root, 'appdata');
  mkdirSync(owned);
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  try {
    symlinkSync(outside, path.join(owned, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.diagnostic('this host cannot create a directory symlink without elevation');
    } else {
      throw error;
    }
  }
  if (lstatSync(path.join(owned, 'runtime'), { throwIfNoEntry: false })?.isSymbolicLink()) {
    await expectFailure(installSidecar(sidecar, { platformKey: 'win32-x64', ownedRoot: owned, fetchImpl }), 'invalid-destination');
    await expectFailure(verifySidecarInstall(sidecar, { platformKey: 'win32-x64', ownedRoot: owned }), 'invalid-destination');
    assert.deepEqual(readdirSync(outside), []);
  }
  assert.equal(fetched, 0);
});
