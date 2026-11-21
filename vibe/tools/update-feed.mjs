#!/usr/bin/env node
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ARCHITECTURES = new Set([
  'arm',
  'arm64',
  'ia32',
  'loong64',
  'mips',
  'mipsel',
  'ppc',
  'ppc64',
  'riscv64',
  's390',
  's390x',
  'x64',
]);
const PLATFORMS = new Set([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
]);
const TARGETS = new Set(['archive', 'msi', 'system', 'user']);

function validateString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function validateHttpsUrl(value, label) {
  validateString(value, label);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.href === 'https://' || url.username || url.password) {
    throw new TypeError(`${label} must be an absolute https URL`);
  }
}

function validateAssetPath(value, label) {
  validateString(value, label);
  if (value.includes('\\')) {
    throw new TypeError(`${label} must use forward slashes`);
  }
  const segments = value.split('/');
  if (!segments.every((segment) => segment.length > 0 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new TypeError(`${label} must be a safe relative path`);
  }
}

function validateAsset(asset, index) {
  const label = (field) => `asset[${index}].${field}`;
  for (const field of ['platform', 'architecture']) {
    validateString(asset[field], label(field));
  }
  if (!PLATFORMS.has(asset.platform)) {
    throw new TypeError(`${label('platform')} is unsupported: ${asset.platform}`);
  }
  if (!ARCHITECTURES.has(asset.architecture)) {
    throw new TypeError(`${label('architecture')} is unsupported: ${asset.architecture}`);
  }
  if (asset.target !== undefined) {
    validateString(asset.target, label('target'));
    if (!TARGETS.has(asset.target)) {
      throw new TypeError(`${label('target')} is unsupported: ${asset.target}`);
    }
  } else if (asset.platform === 'win32') {
    throw new TypeError(`${label('target')} is required for win32`);
  }
  validateAssetPath(asset.path, label('path'));
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new TypeError(`${label('sha256')} must be 64 lowercase hexadecimal characters`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new TypeError(`${label('size')} must be a positive safe integer`);
  }
  if (asset.url !== undefined) {
    validateHttpsUrl(asset.url, label('url'));
  }
}

function validateFeedPath(value, label) {
  validateAssetPath(value, label);
  if (path.basename(value) !== 'latest.json') {
    throw new TypeError(`${label} must end in latest.json`);
  }
}

export function generateUpdateFeeds(manifest, options) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('manifest must be an object');
  }
  for (const field of ['name', 'version', 'commit', 'date', 'quality']) {
    validateString(manifest[field], field);
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new TypeError('version must be a valid SemVer product version');
  }
  const timestamp = Date.parse(manifest.date);
  if (Number.isNaN(timestamp)) {
    throw new TypeError('date must be a valid ISO 8601 date');
  }
  if (manifest.quality !== 'stable' && manifest.quality !== 'insider') {
    throw new TypeError(`quality is unsupported: ${manifest.quality}`);
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new TypeError('manifest.assets must contain at least one asset');
  }
  validateHttpsUrl(options?.assetUrlRoot, 'options.assetUrlRoot');
  manifest.assets.forEach((asset, index) => validateAsset(asset, index));

  const feedPaths = new Set();
  return manifest.assets.map((asset) => {
    const target = asset.target ? `/${asset.target}` : '';
    const relativePath = `${manifest.quality}/${asset.platform}/${asset.architecture}${target}/latest.json`;
    validateFeedPath(relativePath, 'update feed path');
    if (feedPaths.has(relativePath)) {
      throw new Error(`duplicate update feed path: ${relativePath}`);
    }
    feedPaths.add(relativePath);
    const url = asset.url ?? new URL(asset.path, `${options.assetUrlRoot.replace(/\/$/, '')}/`).href;
    const update = {
      url,
      name: manifest.version,
      version: manifest.commit,
      productVersion: manifest.version,
      platform: asset.platform,
      architecture: asset.architecture,
      commit: manifest.commit,
      date: manifest.date,
      timestamp: timestamp.toString(),
      sha256hash: asset.sha256,
      size: asset.size,
    };
    if (asset.target !== undefined) {
      update.target = asset.target;
    }
    return {
      path: relativePath,
      content: `${JSON.stringify(update, null, '	')}\n`,
    };
  });
}

export async function writeUpdateFeeds(feeds, outputRoot) {
  if (!Array.isArray(feeds)) {
    throw new TypeError('feeds must be an array');
  }
  const resolvedOutputRoot = path.resolve(outputRoot);
  for (const feed of feeds) {
    validateFeedPath(feed.path, 'feed.path');
    const targetPath = path.join(resolvedOutputRoot, feed.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, feed.content, 'utf8');
    await rename(temporaryPath, targetPath);
  }
}

function parseArguments(argv) {
  const required = new Set(['manifest', 'out', 'assetUrlRoot']);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || typeof value !== 'string') {
      throw new Error('usage: node vibe/tools/update-feed.mjs --manifest <file> --out <dir> --asset-url-root <https-url>');
    }
    const name = flag.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    values[name] = value;
  }
  for (const name of required) {
    if (!values[name]) {
      throw new Error(`missing required argument: --${name}`);
    }
  }
  return values;
}

export async function runCli(argv, readFile) {
  const values = parseArguments(argv);
  const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
  const feeds = generateUpdateFeeds(manifest, { assetUrlRoot: values.assetUrlRoot });
  await writeUpdateFeeds(feeds, values.out);
  return feeds;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await runCli(process.argv.slice(2), (await import('node:fs/promises')).readFile);
}
