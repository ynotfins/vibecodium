import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const readBuffer = (rel) => readFileSync(path.join(ROOT, rel));
const assets = ['vibe_clt.svg', 'vibe_cnl.svg', 'vibe_cnl_w80_b8.svg'];

const pngSize = (buffer) => {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const icoSizes = (buffer) => {
  assert.equal(buffer.readUInt16LE(0), 0);
  assert.equal(buffer.readUInt16LE(2), 1);
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16;
    sizes.push(buffer[offset] || 256);
  }
  return sizes.sort((a, b) => a - b);
};

const bmpSize = (buffer) => ({ width: buffer.readInt32LE(18), height: buffer.readInt32LE(22) });

for (const quality of ['stable', 'insider']) {
  test(`${quality} icon vectors are Vibecodium-owned and renderable`, () => {
    const dir = path.join(ROOT, 'icons', quality);
    assert.deepEqual(readdirSync(dir).sort(), assets, `${quality} must contain only the branded source vectors`);

    for (const name of assets) {
      const svg = read(path.join('icons', quality, name));

      assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
      assert.match(svg, /<svg\b[^>]*width="100"[^>]*height="100"[^>]*viewBox="0 0 100 100"/);
      assert.match(svg, /<title>Vibecodium<\/title>/);
      assert.match(svg, /<linearGradient id="VibeGradient"/);
      assert.match(svg, /<path\b[^>]*d="M/);
      assert.doesNotMatch(svg, /VSCodium|vscodium/);
      assert.doesNotMatch(svg, /<text\b|<image\b|\bhref=|<script\b/i);
      assert.doesNotMatch(svg, /(?:href|src)="https?:/i);
    }

    const normal = read(path.join('icons', quality, 'vibe_cnl.svg'));
    const light = read(path.join('icons', quality, 'vibe_clt.svg'));
    const bordered = read(path.join('icons', quality, 'vibe_cnl_w80_b8.svg'));

    assert.notEqual(normal, light, 'normal and light variants must not be identical');
    assert.match(bordered, /stroke="#FFFFFF"/);
  });
}

test('icon build uses only local Vibecodium vectors and never downloads upstream artwork', () => {
  const script = read('icons/build_icons.sh');

  assert.doesNotMatch(script, /VSCodium\/icons|paulo22s|https?:\/\/raw\.githubusercontent\.com/);
  assert.doesNotMatch(script, /\b(?:wget|curl)\b/);
  assert.doesNotMatch(script, /codium_/);
  assert.match(script, /check_programs .*"mktemp"/);
  assert.match(script, /echo "\$\{arg\} could not be found"[\s\S]*?exit 1/);

  for (const name of assets) {
    assert.match(script, new RegExp(`icons/\\$\\{QUALITY\\}/${name.replaceAll('.', '\\.')}`));
  }

  assert.match(script, /load_linux_png\(\) \{[\s\S]*?rsvg-convert[\s\S]*?vibe_cnl\.svg[\s\S]*?\}/);
  assert.match(script, /load_windows_ico\(\) \{[\s\S]*?rsvg-convert[\s\S]*?icon:auto-resize=256,128,96,64,48,32,24,20,16[\s\S]*?\}/);
});

test('icon README documents only the Vibecodium vector sources', () => {
  const readme = read('icons/README.md');

  for (const name of assets) assert.match(readme, new RegExp(name.replaceAll('.', '\\.')));
  assert.doesNotMatch(readme, /codium_/);
});

test('shipped overlay icons are generated from the Vibecodium vectors', () => {
  const expectedIcoSizes = [16, 20, 24, 32, 48, 64, 96, 128, 256];

  assert.deepEqual(icoSizes(readBuffer('src/stable/resources/win32/code.ico')), expectedIcoSizes);
  assert.deepEqual(icoSizes(readBuffer('src/stable/resources/server/favicon.ico')), expectedIcoSizes);

  assert.deepEqual(pngSize(readBuffer('src/stable/resources/win32/code_70x70.png')), { width: 70, height: 70 });
  assert.deepEqual(pngSize(readBuffer('src/stable/resources/win32/code_150x150.png')), { width: 150, height: 150 });
  assert.deepEqual(pngSize(readBuffer('src/stable/resources/linux/code.png')), { width: 512, height: 512 });
  assert.deepEqual(pngSize(readBuffer('src/stable/resources/server/code-192.png')), { width: 192, height: 192 });
  assert.deepEqual(pngSize(readBuffer('src/stable/resources/server/code-512.png')), { width: 512, height: 512 });

  for (const [name, width, height] of [
    ['inno-big-100.bmp', 164, 314],
    ['inno-big-125.bmp', 192, 386],
    ['inno-big-150.bmp', 246, 459],
    ['inno-big-175.bmp', 273, 556],
    ['inno-big-200.bmp', 328, 604],
    ['inno-big-225.bmp', 355, 700],
    ['inno-big-250.bmp', 410, 797],
    ['inno-small-100.bmp', 55, 55],
    ['inno-small-125.bmp', 64, 68],
    ['inno-small-150.bmp', 83, 80],
    ['inno-small-175.bmp', 92, 97],
    ['inno-small-200.bmp', 110, 106],
    ['inno-small-225.bmp', 119, 123],
    ['inno-small-250.bmp', 138, 140],
  ]) {
    assert.deepEqual(bmpSize(readBuffer(`src/stable/resources/win32/${name}`)), { width, height });
  }

  const icns = readBuffer('src/stable/resources/darwin/code.icns');
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const icnsTypes = [];
  for (let offset = 8; offset < icns.length;) {
    const type = icns.subarray(offset, offset + 4).toString('ascii');
    const length = icns.readUInt32BE(offset + 4);
    icnsTypes.push(type);
    offset += length;
  }
  assert.deepEqual(icnsTypes, ['ic10', 'ic09', 'ic08', 'ic07']);

  assert.equal(read('src/stable/resources/linux/code.svg'), read('icons/stable/vibe_clt.svg'));
  assert.equal(read('src/stable/src/vs/workbench/browser/media/code-icon.svg'), read('icons/stable/vibe_clt.svg').replace('width="100" height="100"', 'width="1024" height="1024"'));
});

test('binary overlay assets match the recorded Vibecodium render manifest', () => {
  const manifest = JSON.parse(read('icons/overlay-assets.json'));
  assert.equal(manifest.generatedFrom, 'icons/stable/vibe_cnl.svg and icons/stable/vibe_clt.svg');

  for (const [rel, expected] of Object.entries(manifest.assets)) {
    const buffer = readBuffer(rel);
    assert.equal(buffer.length, expected.bytes, `${rel} byte size`);
    assert.equal(createHash('sha256').update(buffer).digest('hex'), expected.sha256, `${rel} sha256`);
  }
});

test('root README points at a live Vibecodium logo', () => {
  const readme = read('README.md');
  assert.match(readme, /\.\/icons\/stable\/vibe_cnl\.svg/);
  assert.match(readme, /alt="Vibecodium logo"/);
  assert.match(readme, /<h1>Vibecodium<\/h1>/);
  assert.doesNotMatch(readme, /codium_cnl\.svg|VSCodium Logo|<h1>VSCodium<\/h1>/);
});