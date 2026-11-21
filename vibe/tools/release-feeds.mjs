#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { generateUpdateFeeds, writeUpdateFeeds } from './update-feed.mjs';

const WINDOWS_ASSET_EXTENSIONS = new Set(['.exe', '.msi', '.zip']);
const REQUIRED_ARGUMENTS = new Set([
  'assets',
  'assetUrlRoot',
  'commit',
  'date',
  'name',
  'out',
  'platform',
  'quality',
  'version',
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readChecksum(content, fileName) {
  const escapedFileName = escapeRegExp(fileName);
  const match = content.trim().match(new RegExp(`^([a-f0-9]{64})(?:\\s+\\*?${escapedFileName})?$`, 'i'));
  if (!match) {
    throw new Error(`${fileName} must have a valid matching .sha256 file`);
  }
  return match[1];
}

function classifyWindowsAsset(fileName, metadata) {
  const name = escapeRegExp(metadata.name);
  const version = escapeRegExp(metadata.version);
  if (new RegExp(`^${name}-[A-Za-z0-9_-]+-updates-disabled-${version}\\.msi$`).test(fileName)) {
    return undefined;
  }
  const rules = [
    { expression: new RegExp(`^${name}Setup-([A-Za-z0-9_-]+)-${version}\\.exe$`), target: 'system' },
    { expression: new RegExp(`^${name}UserSetup-([A-Za-z0-9_-]+)-${version}\\.exe$`), target: 'user' },
    { expression: new RegExp(`^${name}-win32-([A-Za-z0-9_-]+)-${version}\\.zip$`), target: 'archive' },
    { expression: new RegExp(`^${name}-([A-Za-z0-9_-]+)-${version}\\.msi$`), target: 'msi' },
  ];
  for (const rule of rules) {
    const match = rule.expression.exec(fileName);
    if (match) {
      return { architecture: match[1], target: rule.target };
    }
  }
  return undefined;
}

async function collectWindowsAssets(assetsRoot, metadata, readFile, statFile, listFiles) {
  const entries = await listFiles(assetsRoot);
  const assetFileNames = entries.filter((entry) => !entry.endsWith('.sha256') && WINDOWS_ASSET_EXTENSIONS.has(path.extname(entry)));
  if (assetFileNames.length === 0) {
    throw new Error(`no supported Windows release assets found in ${assetsRoot}`);
  }

  const assets = [];
  for (const fileName of assetFileNames) {
    const classified = classifyWindowsAsset(fileName, metadata);
    if (!classified) {
      continue;
    }
    const assetPath = path.join(assetsRoot, fileName);
    const checksumPath = `${assetPath}.sha256`;
    let checksumContent;
    try {
      checksumContent = await readFile(checksumPath, 'utf8');
    } catch {
      throw new Error(`${fileName} must have a matching .sha256 file`);
    }
    const fileStat = await statFile(assetPath);
    assets.push({
      architecture: classified.architecture,
      path: fileName,
      platform: metadata.platform,
      sha256: readChecksum(checksumContent, fileName),
      size: fileStat.size,
      target: classified.target,
    });
  }
  if (assets.length === 0) {
    throw new Error(`no checksum-mapped Windows release assets found in ${assetsRoot}`);
  }
  return assets;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || typeof value !== 'string') {
      throw new Error('usage: node vibe/tools/release-feeds.mjs --assets <dir> --name <name> --version <semver> --commit <sha> --date <iso-date> --quality <stable|insider> --platform win32 --asset-url-root <https-url> --out <dir>');
    }
    const name = flag.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    values[name] = value;
  }
  for (const name of REQUIRED_ARGUMENTS) {
    if (!values[name]) {
      throw new Error(`missing required argument: --${name}`);
    }
  }
  return values;
}

export async function runCli(argv, readFile, statFile, listFiles) {
  const values = parseArguments(argv);
  if (values.platform !== 'win32') {
    throw new TypeError(`platform is unsupported: ${values.platform}`);
  }
  const metadata = {
    commit: values.commit,
    date: values.date,
    name: values.name,
    platform: values.platform,
    quality: values.quality,
    version: values.version,
  };
  metadata.assets = await collectWindowsAssets(
    values.assets,
    metadata,
    readFile ?? (await import('node:fs/promises')).readFile,
    statFile ?? (await import('node:fs/promises')).stat,
    listFiles ?? (await import('node:fs/promises')).readdir,
  );
  const feeds = generateUpdateFeeds(metadata, { assetUrlRoot: values.assetUrlRoot });
  await writeUpdateFeeds(feeds, values.out);
  return feeds;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await runCli(process.argv.slice(2));
}
