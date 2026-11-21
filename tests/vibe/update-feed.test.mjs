import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';

import { generateUpdateFeeds, runCli, writeUpdateFeeds } from '../../vibe/tools/update-feed.mjs';

const manifest = {
  name: 'Vibecodium',
  version: '1.147.0',
  commit: 'abc123',
  date: '2026-11-21',
  quality: 'stable',
  assets: [
    {
      platform: 'win32',
      architecture: 'x64',
      target: 'system',
      path: 'Vibecodium-x64-system.exe',
      sha256: 'a'.repeat(64),
      size: 1_024,
    },
    {
      platform: 'win32',
      architecture: 'x64',
      target: 'user',
      path: 'Vibecodium-x64-user.exe',
      sha256: 'b'.repeat(64),
      size: 2_048,
    },
    {
      platform: 'win32',
      architecture: 'x64',
      target: 'archive',
      path: 'Vibecodium-win32-x64.zip',
      sha256: 'c'.repeat(64),
      size: 4_096,
    },
    {
      platform: 'darwin',
      architecture: 'arm64',
      path: 'Vibecodium-darwin-arm64.zip',
      sha256: 'd'.repeat(64),
      size: 8_192,
    },
  ],
};

function assetRoot(path) {
  return `https://releases.example.com/vibecodium/1.147.0/${path}`;
}

test('generates platform-scoped update feeds in deterministic paths', () => {
  const feeds = generateUpdateFeeds(manifest, { assetUrlRoot: 'https://releases.example.com/vibecodium/1.147.0' });

  assert.deepEqual(feeds.map((feed) => feed.path), [
    'stable/win32/x64/system/latest.json',
    'stable/win32/x64/user/latest.json',
    'stable/win32/x64/archive/latest.json',
    'stable/darwin/arm64/latest.json',
  ]);

  const system = JSON.parse(feeds[0].content);
  assert.deepEqual(system, {
    url: assetRoot('Vibecodium-x64-system.exe'),
    name: '1.147.0',
    version: 'abc123',
    productVersion: '1.147.0',
    platform: 'win32',
    architecture: 'x64',
    target: 'system',
    commit: 'abc123',
    date: '2026-11-21',
    timestamp: Date.parse('2026-11-21').toString(),
    sha256hash: 'a'.repeat(64),
    size: 1_024,
  });

  const archive = JSON.parse(feeds[2].content);
  assert.equal(archive.target, 'archive');
  assert.equal(archive.sha256hash, 'c'.repeat(64));
});

test('rejects malformed release metadata', () => {
  assert.throws(() => generateUpdateFeeds({ ...manifest, assets: [] }), /at least one asset/);
  assert.throws(() => generateUpdateFeeds({ ...manifest, version: '' }), /version must be a non-empty string/);
  assert.throws(() => generateUpdateFeeds({ ...manifest, version: 'not-semver' }), /valid SemVer product version/);
  assert.throws(
    () => generateUpdateFeeds(manifest, { assetUrlRoot: 'https://user:secret@releases.example.com/vibecodium' }),
    /absolute https URL/,
  );
  assert.throws(
    () => generateUpdateFeeds({
      ...manifest,
      assets: [{ platform: 'unknown', architecture: 'x64', path: 'x.exe', sha256: 'z'.repeat(64), size: 1 }],
    }, { assetUrlRoot: 'https://releases.example.com/vibecodium/1.147.0' }),
    /asset\[0\].platform/,
  );
  assert.throws(
    () => generateUpdateFeeds({
      ...manifest,
      assets: [{ platform: 'win32', architecture: 'x64', target: 'system', path: 'x.exe', sha256: 'short', size: 1 }],
    }, { assetUrlRoot: 'https://releases.example.com/vibecodium/1.147.0' }),
    /asset\[0\].sha256/,
  );
});

test('rejects unsafe exported feed paths', async () => {
  const outputRoot = path.join(tmpdir(), `vibecodium-update-feed-${process.pid}-${Date.now()}`);
  await mkdir(outputRoot, { recursive: true });
  await assert.rejects(
    writeUpdateFeeds([{ path: '../escape/latest.json', content: '{}' }], outputRoot),
    /feed\.path must be a safe relative path/,
  );
  await rm(outputRoot, { recursive: true, force: true });
});

test('writes feeds with the documented CLI arguments', async () => {
  const outputRoot = path.join(tmpdir(), `vibecodium-update-feed-cli-${process.pid}-${Date.now()}`);
  await mkdir(outputRoot, { recursive: true });
  const manifestPath = path.join(outputRoot, 'release.json');
  const stagingRoot = path.join(outputRoot, 'staging');
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  const feeds = await runCli(
    ['--manifest', manifestPath, '--out', stagingRoot, '--asset-url-root', 'https://releases.example.com/vibecodium/1.147.0'],
    readFile,
  );
  assert.equal(feeds.length, manifest.assets.length);
  const system = JSON.parse(await readFile(path.join(stagingRoot, 'stable/win32/x64/system/latest.json'), 'utf8'));
  assert.equal(system.version, 'abc123');
  assert.equal(system.sha256hash, 'a'.repeat(64));
  await rm(outputRoot, { recursive: true, force: true });
});
