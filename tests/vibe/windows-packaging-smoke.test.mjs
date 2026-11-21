import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

import { runSmoke } from '../../vibe/tools/windows-packaging-smoke.mjs';

const payload = Buffer.from('Vibecodium packaging fixture');
const checksum = 'e3fbbf5e6ae7a862c31ed6ce8071ad3ecb1b6eef01ef878c33b4d01ce1e37b33';

function sha256() {
  return checksum;
}

async function createAssets(root) {
  const assets = path.join(root, 'assets');
  await mkdir(assets, { recursive: true });
  await Promise.all([
    writeFile(path.join(assets, 'Vibecodium-win32-x64-1.147.17795.zip'), payload),
    writeFile(path.join(assets, 'VibecodiumSetup-x64-1.147.17795.exe'), payload),
    writeFile(path.join(assets, 'VibecodiumUserSetup-x64-1.147.17795.exe'), payload),
  ]);
  return assets;
}

const fakeRead = async () => payload;
const fakeList = async () => [
  'Vibecodium.exe',
  'bin/vibecodium.cmd',
  'resources/app/package.json',
  'resources/app/product.json',
];
const fakeExtract = async () => 'C:/tmp/vibecodium-portable';
const fakeProduct = async () => ({
  nameShort: 'Vibecodium',
  version: '1.147.17795',
  commit: '4c2b3f4aebcfef13c63c19d4ee7e1a5ee36656d9',
});
const fakePackage = async () => ({ name: 'Vibecodium', version: '1.147.17795' });
const fakeStat = async () => ({ size: payload.byteLength });

test('validates required Windows installer and portable zip artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibecodium-packaging-smoke-'));
  try {
    const assets = await createAssets(root);
    const report = await runSmoke(
      {
        assets,
        name: 'Vibecodium',
        version: '1.147.17795',
        commit: '4c2b3f4aebcfef13c63c19d4ee7e1a5ee36656d9',
      },
      {
        hashFile: sha256,
        listZip: fakeList,
        extractZip: fakeExtract,
        readProductJson: fakeProduct,
        readPackageJson: fakePackage,
        statFile: fakeStat,
      },
    );

    assert.equal(report.name, 'Vibecodium');
    assert.equal(report.version, '1.147.17795');
    assert.equal(report.commit, '4c2b3f4aebcfef13c63c19d4ee7e1a5ee36656d9');
    assert.equal(report.identity.nameShort, 'Vibecodium');
    assert.equal(report.artifacts.length, 3);
    assert.deepEqual(report.artifacts.map((artifact) => artifact.kind), [
      'system-installer',
      'user-installer',
      'portable-zip',
    ]);
    assert.equal(report.artifacts[0].sha256, checksum);
    assert.equal(report.artifacts[2].contents.includes('Vibecodium.exe'), true);
    assert.equal(report.artifacts[2].contents.includes('bin/vibecodium.cmd'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI exits nonzero for missing assets', () => {
  const result = spawnSync(process.execPath, [
    'vibe/tools/windows-packaging-smoke.mjs',
    '--assets', 'definitely-missing',
    '--name', 'Vibecodium',
    '--version', '1.147.17795',
    '--commit', '4c2b3f4aebcfef13c63c19d4ee7e1a5ee36656d9',
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /missing assets directory/);
});

test('rejects a missing portable zip', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibecodium-packaging-smoke-'));
  try {
    const assets = await createAssets(root);
    await rm(path.join(assets, 'Vibecodium-win32-x64-1.147.17795.zip'));
    await assert.rejects(
      runSmoke(
        {
          assets,
          name: 'Vibecodium',
          version: '1.147.17795',
          commit: '4c2b3f4aebcfef13c63c19d4ee7e1a5ee36656d9',
        },
        {
          hashFile: sha256,
          listZip: fakeList,
          extractZip: fakeExtract,
          readProductJson: fakeProduct,
          readPackageJson: fakePackage,
          statFile: fakeStat,
        },
      ),
      /missing artifact: Vibecodium-win32-x64-1\.147\.17795\.zip/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
