#!/usr/bin/env node
// Verifies local Windows packaging output before any release step.
//
//   source dev/build.env
//   node vibe/tools/windows-packaging-smoke.mjs --assets assets \
//     --name Vibecodium --version "$RELEASE_VERSION" \
//     --commit "$BUILD_SOURCEVERSION"
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function normalizeListEntry(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function parseSevenZipDetailedListing(output) {
  const entries = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^Path = (.*)$/);
    if (match) {
      if (current) entries.push(current);
      current = normalizeListEntry(match[1]);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function defaultListZip(file) {
  const result = spawnSync('7z', ['l', '-ba', '-slt', file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`7z listing failed with exit ${result.status}: ${result.stderr.trim()}`);
  }
  return parseSevenZipDetailedListing(result.stdout);
}

function defaultExtractZip(file, destination) {
  const result = spawnSync('7z', ['x', '-y', file, `-o${destination}`, 'resources/app/package.json', 'resources/app/product.json'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`7z extraction failed with exit ${result.status}: ${result.stderr.trim()}`);
  }
  return destination;
}

async function defaultHashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function runSmoke(options, dependencies = {}) {
  const {
    listZip = defaultListZip,
    extractZip = defaultExtractZip,
    hashFile = defaultHashFile,
    readPackageJson = async (file) => JSON.parse(await readFile(file, 'utf8')),
    readProductJson = async (file) => JSON.parse(await readFile(file, 'utf8')),
    statFile = stat,
  } = dependencies;
  const name = options.name || 'Vibecodium';
  const version = options.version || '';
  const commit = options.commit || '';
  const arch = options.arch || 'x64';

  if (!/^[\w.-]+$/.test(name) || /^-/.test(name)) {
    throw new Error('name contains unsupported characters');
  }
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error(`unsupported release version: ${version}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('commit must be a 40-character hexadecimal SHA-1');
  }

  const definitions = [
    { kind: 'system-installer', file: `${name}Setup-${arch}-${version}.exe` },
    { kind: 'user-installer', file: `${name}UserSetup-${arch}-${version}.exe` },
    { kind: 'portable-zip', file: `${name}-win32-${arch}-${version}.zip` },
  ];
  const directory = path.resolve(options.assets);
  let listing;
  try {
    listing = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error(`missing assets directory: ${directory}`);
  }
  const available = new Set(listing.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const artifacts = [];

  for (const definition of definitions) {
    if (!available.has(definition.file)) {
      throw new Error(`missing artifact: ${definition.file}`);
    }
    const file = path.join(directory, definition.file);
    const metadata = await statFile(file);
    const sha256 = await hashFile(file);
    const artifact = {
      kind: definition.kind,
      file: definition.file,
      size: metadata.size,
      sha256,
    };

    if (definition.kind === 'portable-zip') {
      const contents = (await listZip(file)).map(normalizeListEntry);
      const requiredZipEntries = [
        `${name}.exe`,
        `bin/${name.toLowerCase()}.cmd`,
        'resources/app/package.json',
        'resources/app/product.json',
      ];
      for (const requiredEntry of requiredZipEntries) {
        if (!contents.includes(requiredEntry)) {
          throw new Error(`portable zip is missing ${requiredEntry}`);
        }
      }
      artifact.contents = contents;

      const extractionRoot = await mkdtemp(path.join(tmpdir(), 'vibecodium-packaging-smoke-'));
      try {
        await extractZip(file, extractionRoot);
        const [packageJson, productJson] = await Promise.all([
          readPackageJson(path.join(extractionRoot, 'resources', 'app', 'package.json')),
          readProductJson(path.join(extractionRoot, 'resources', 'app', 'product.json')),
        ]);
        if (productJson.nameShort !== name || packageJson.name !== name) {
          throw new Error(`packaged app name does not match ${name}`);
        }
        if (packageJson.version !== version) {
          throw new Error(`packaged app version ${packageJson.version} does not match ${version}`);
        }
        if (!productJson.commit || productJson.commit !== commit) {
          throw new Error(`packaged app commit ${productJson.commit} does not match ${commit}`);
        }
        artifact.identity = {
          nameShort: productJson.nameShort,
          applicationName: productJson.applicationName,
          dataFolderName: productJson.dataFolderName,
          version: packageJson.version,
          commit: productJson.commit || commit,
        };
      } finally {
        await rm(extractionRoot, { recursive: true, force: true });
      }
    }

    artifacts.push(artifact);
  }

  return {
    name,
    version,
    commit,
    architecture: arch,
    identity: artifacts.find((artifact) => artifact.kind === 'portable-zip')?.identity,
    artifacts,
  };
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith('--')) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    options[flag.slice(2).replaceAll('-', (character, offset) => (offset === 2 ? character : ''))] = argv[index + 1];
  }
  const report = await runSmoke(options, dependencies);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
