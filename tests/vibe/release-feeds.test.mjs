import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runCli } from '../../vibe/tools/release-feeds.mjs';

const content = Buffer.from('Vibecodium release-feed fixture');
const files = [
  'VibecodiumSetup-x64-1.147.0.exe',
  'VibecodiumUserSetup-x64-1.147.0.exe',
  'Vibecodium-win32-x64-1.147.0.zip',
  'Vibecodium-x64-1.147.0.msi',
  'Vibecodium-x64-updates-disabled-1.147.0.msi',
];

function checksumFile(fileName) {
  return `${createHash('sha256').update(content).digest('hex')}  ${fileName}\n`;
}

async function createAssets(root) {
  await mkdir(root, { recursive: true });
  for (const file of files) {
    await writeFile(path.join(root, file), content);
    await writeFile(path.join(root, `${file}.sha256`), checksumFile(file), 'utf8');
  }
}

function cliArguments(assetsRoot, outputRoot) {
  return [
    '--assets', assetsRoot,
    '--name', 'Vibecodium',
    '--version', '1.147.0',
    '--commit', 'abc123',
    '--date', '2026-11-21',
    '--quality', 'stable',
    '--platform', 'win32',
    '--asset-url-root', 'https://github.com/ynotfins/vibecodium/releases/download/1.147.0',
    '--out', outputRoot,
  ];
}

test('collects checksummed Windows release assets into scoped feeds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibecodium-release-feeds-'));
  const assetsRoot = path.join(root, 'assets');
  const outputRoot = path.join(root, 'update-feed');
  await createAssets(assetsRoot);
  const feeds = await runCli(
    cliArguments(assetsRoot, outputRoot),
    readFile,
    stat,
    (directory) => files.filter((file) => !file.endsWith('.sha256')),
  );

  assert.deepEqual(feeds.map((feed) => feed.path), [
    'stable/win32/x64/system/latest.json',
    'stable/win32/x64/user/latest.json',
    'stable/win32/x64/archive/latest.json',
    'stable/win32/x64/msi/latest.json',
  ]);
  const system = JSON.parse(feeds[0].content);
  assert.equal(system.url, 'https://github.com/ynotfins/vibecodium/releases/download/1.147.0/VibecodiumSetup-x64-1.147.0.exe');
  assert.equal(system.sha256hash, createHash('sha256').update(content).digest('hex'));
  assert.equal(system.size, content.byteLength);
  await rm(root, { recursive: true, force: true });
});

test('requires a checksum and size for every mapped asset', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibecodium-release-feeds-'));
  const assetsRoot = path.join(root, 'assets');
  const outputRoot = path.join(root, 'update-feed');
  await createAssets(assetsRoot);
  await rm(path.join(assetsRoot, `${files[0]}.sha256`));
  await assert.rejects(
    runCli(
      cliArguments(assetsRoot, outputRoot),
      readFile,
      stat,
      (directory) => files.filter((file) => !file.endsWith('.sha256')),
    ),
    /must have a matching \.sha256/,
  );
  await rm(root, { recursive: true, force: true });
});
