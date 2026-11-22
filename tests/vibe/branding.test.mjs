import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { generateUpdateFeeds } from '../../vibe/tools/update-feed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

test('stable build metadata identifies Vibecodium with an independent Windows identity', () => {
  const utils = read('utils.sh');
  const prepare = read('prepare_vscode.sh');
  const productStart = prepare.indexOf('if [[ "${VSCODE_QUALITY}" == "insider" ]]; then', prepare.indexOf('setpath "product" "twitterUrl"'));
  const productEnd = prepare.indexOf('\nfi\n\nsetpath_json "product" "tunnelApplicationConfig"', productStart);
  const stable = productStart >= 0 && productEnd >= 0
    ? prepare.slice(productStart, productEnd).match(/\nelse\n(?<body>[\s\S]*)$/)
    : null;

  assert.ok(stable?.groups?.body, 'stable product metadata block must exist');
  assert.match(utils, /^APP_NAME="\$\{APP_NAME:-Vibecodium\}"$/m);
  assert.match(utils, /^BINARY_NAME="\$\{BINARY_NAME:-vibecodium\}"$/m);
  assert.match(utils, /^GH_REPO_PATH="\$\{GH_REPO_PATH:-ynotfins\/vibecodium\}"$/m);
  assert.match(utils, /^ASSETS_REPOSITORY="\$\{ASSETS_REPOSITORY:-ynotfins\/vibecodium\}"$/m);
  assert.match(utils, /^ORG_NAME="\$\{ORG_NAME:-Vibecodium\}"$/m);

  for (const [field, value] of Object.entries({
    nameShort: 'Vibecodium',
    nameLong: 'Vibecodium',
    applicationName: 'vibecodium',
    dataFolderName: '.vibecodium',
    linuxIconName: 'vibecodium',
    urlProtocol: 'vibecodium',
    serverApplicationName: 'vibecodium-server',
    serverDataFolderName: '.vibecodium-server',
    darwinBundleIdentifier: 'com.ynotfins.vibecodium',
    win32AppUserModelId: 'Vibecodium.Vibecodium',
    win32DirName: 'Vibecodium',
    win32MutexName: 'vibecodium',
    win32NameVersion: 'Vibecodium',
    win32RegValueName: 'Vibecodium',
    win32ShellNameShort: 'Vibecodium',
    tunnelApplicationName: 'vibecodium-tunnel',
    win32TunnelServiceMutex: 'vibecodium-tunnelservice',
    win32TunnelMutex: 'vibecodium-tunnel',
  })) {
    assert.match(stable.groups.body, new RegExp(`setpath "product" "${field}" "${value}"`));
  }

  for (const [field, value] of Object.entries({
    win32AppId: '{{47F5B123-8E21-4FF1-9652-EA78C1CC7473}',
    win32x64AppId: '{{D41EA55C-BE3E-413F-9210-2D6D9355C541}',
    win32arm64AppId: '{{479062A3-BB02-4F30-B7C6-B671170F17DE}',
    win32UserAppId: '{{A6880127-81CD-416B-B752-04A4E079CA60}',
    win32x64UserAppId: '{{E1E359BA-7AD7-4AC3-8AF3-B366DCF9A93C}',
    win32arm64UserAppId: '{{910FD302-45AF-40DE-9EF8-7F40E5223339}',
    'win32ContextMenu.x64.clsid': 'F81D3C13-4AEA-4CAB-B42E-56B7B9BFF523',
    'win32ContextMenu.arm64.clsid': 'E5CB0F94-DFA4-445F-8C53-2BC8901CE45B',
  })) {
    assert.match(stable.groups.body, new RegExp(`setpath "product" "${field.replaceAll('.', '\\.')}" "${value.replaceAll('{', '\\{').replaceAll('}', '\\}')}"`));
  }

  assert.doesNotMatch(stable.groups.body, /VSCodium|vscodium/);
  for (const legacyId of ['763CBF88-25C6-4B10-952F-326AE657F16B', '88DA3577-054F-4CA1-8122-7D820494CFFB', '67DEE444-3D04-4258-B92A-BC1F0FF2CAE4', '0FD05EB4-651E-4E78-A062-515204B47A3A', '2E1F05D1-C245-4562-81EE-28188DB6FD17', '57FD70A5-1B8D-4875-9F40-C5553F094828']) {
    assert.doesNotMatch(stable.groups.body, new RegExp(legacyId));
  }
  assert.match(prepare, /setpath "product" "licenseUrl" "https:\/\/github\.com\/ynotfins\/vibecodium\/blob\/vibe\/main\/LICENSE"/);
  assert.match(prepare, /setpath "product" "reportIssueUrl" "https:\/\/github\.com\/ynotfins\/vibecodium\/issues\/new"/);
  assert.match(prepare, /setpath "resources\/server\/manifest" "name" "Vibecodium"/);
  assert.match(prepare, /setpath "resources\/server\/manifest" "short_name" "Vibecodium"/);
  assert.match(prepare, /replace 's\|Microsoft Corporation\|Vibecodium\|'/);
  assert.match(prepare, /replace 's\|\(\[0-9\]\) Microsoft\|\\1 Vibecodium\|'/);
  assert.match(prepare, /sed -i 's\|https:\/\/code\.visualstudio\.com\|https:\/\/github\.com\/ynotfins\/vibecodium\|'/);
  assert.match(prepare, /sed -i 's\|Microsoft Corporation\|Vibecodium\|' build\/win32\/code\.iss/);
});

test('dev/build.sh must not defeat the branded identity defaults', () => {
  const build = read('dev/build.sh');

  // The wrapper `vibe/dev/build-windows.sh` calls `dev/build.sh` unconditionally;
  // upstream's hardcoded exports would override the branded defaults in utils.sh
  // for every patch placeholder (!!APP_NAME!!, !!ORG_NAME!!, ...) and artifact name.
  // ASSETS_REPOSITORY now mirrors utils.sh too: it points at the Vibecodium product
  // repository, whose releases and generated update feeds the build consumes.
  for (const [key, value] of Object.entries({
    APP_NAME: 'Vibecodium',
    ASSETS_REPOSITORY: 'ynotfins/vibecodium',
    BINARY_NAME: 'vibecodium',
    GH_REPO_PATH: 'ynotfins/vibecodium',
    ORG_NAME: 'Vibecodium',
  })) {
    assert.match(
      build,
      new RegExp(`^export ${key}="\\$\\{${key}:-${value.replaceAll('/', '\\/')}\\}"$`, 'm'),
      `dev/build.sh must export ${key} with the default utils.sh brands it with, not the upstream VSCodium value`,
    );
  }

  // Non-identity settings keep their plain upstream exports.
  assert.match(build, /^export CI_BUILD="no"$/m);

  // The insider flag forces insider identity (plain assignments, like upstream).
  assert.match(build, /export ASSETS_REPOSITORY="ynotfins\/vibecodium-insiders"/);
  assert.match(build, /export BINARY_NAME="vibecodium-insiders"/);
});

const UPDATE_BLOCK_START = 'if [[ "${DISABLE_UPDATE}" != "yes" ]]; then';

function updateBlock() {
  const prepare = read('prepare_vscode.sh');
  const start = prepare.indexOf(UPDATE_BLOCK_START);
  const end = prepare.indexOf('\nfi\n', start);
  assert.ok(start >= 0 && end > start, 'the update configuration block must exist');
  return prepare.slice(start, end);
}

function resolveDefault(value) {
  return value.replace(/\$\{(?:GH_REPO_PATH|ASSETS_REPOSITORY):-([^}]+)\}/g, '$1');
}

test('update and download endpoints use the Vibecodium feed and release page', () => {
  const block = updateBlock();
  const update = block.match(/setpath "product" "updateUrl" "([^"]+)"/);
  const download = block.match(/setpath "product" "downloadUrl" "([^"]+)"/);

  assert.ok(update, 'updateUrl must be set');
  assert.ok(download, 'downloadUrl must be set');
  assert.equal(
    resolveDefault(update[1]),
    'https://raw.githubusercontent.com/ynotfins/vibecodium/refs/heads/vibe/main/update-feed',
  );
  assert.equal(resolveDefault(download[1]), 'https://github.com/ynotfins/vibecodium/releases');
  assert.doesNotMatch(block, /VSCodium|vscodium/);
  assert.doesNotMatch(read('prepare_vscode.sh'), /raw\.githubusercontent\.com\/VSCodium\/versions/);
});

test('Linux package metadata endpoints point at Vibecodium', () => {
  const prepare = read('prepare_vscode.sh');
  const start = prepare.indexOf('# fix the packages metadata');
  const end = prepare.indexOf('elif [[ "\${OS_NAME}" == "windows" ]]', start);
  assert.ok(start >= 0 && end > start, 'the Linux package metadata block must exist');
  const block = prepare.slice(start, end);
  assert.match(block, /https:\/\/github\.com\/ynotfins\/vibecodium#download-install/);
  assert.doesNotMatch(block, /VSCodium\/vscodium#download-install/);
  assert.doesNotMatch(block, /vscodium\.com/);
});

test('stable Linux package metadata identifies Vibecodium', () => {
  const prepare = read('prepare_vscode.sh');
  const start = prepare.indexOf('# fix the packages metadata');
  const end = prepare.indexOf('elif [[ "${OS_NAME}" == "windows" ]]', start);
  assert.ok(start >= 0 && end > start, 'the Linux package metadata block must exist');
  const block = prepare.slice(start, end);

  const fixtures = {
    'resources/linux/code.appdata.xml': read('src/stable/resources/linux/code.appdata.xml'),
    'resources/linux/debian/control.template': [
      'Package: vibecodium',
      'Maintainer: Microsoft Corporation <vscode-linux@microsoft.com>',
      'Homepage: https://code.visualstudio.com/',
      'Description: Visual Studio Code. Code editing. Redefined.',
      ' Visual Studio Code is a choice of tool. See https://code.visualstudio.com/docs/setup/linux',
    ].join('\n'),
    'resources/linux/rpm/code.spec.template': [
      'Vendor:   Microsoft Corporation',
      'Packager: Visual Studio Code Team <vscode-linux@microsoft.com>',
      'URL:      https://code.visualstudio.com/',
      '%description',
      'Visual Studio Code is a choice of tool. See https://code.visualstudio.com/docs/setup/linux',
    ].join('\n'),
    'resources/linux/snap/snapcraft.yaml': [
      'name: vibecodium',
      'description: |',
      '  Visual Studio Code is a choice of tool.',
    ].join('\n'),
  };

  const maintainer = block.match(/\|(Microsoft Corporation <[^|]+)\|/)?.[1];
  const packager = block.match(/\|(Visual Studio Code Team <[^|]+)\|/)?.[1];
  assert.ok(maintainer && packager, 'the Debian and RPM identity replacements must exist');
  fixtures['resources/linux/debian/control.template'] = fixtures['resources/linux/debian/control.template']
    .replace(/Maintainer: .*/, `Maintainer: ${maintainer}`);
  fixtures['resources/linux/rpm/code.spec.template'] = fixtures['resources/linux/rpm/code.spec.template']
    .replace(/Packager: .*/, `Packager: ${packager}`);

  const commands = [...block.matchAll(/sed -i 's\|([^|]+)\|([^|]*)\|([g]*)'\s+([^\s]+)/g)]
    .map((match) => ({ search: match[1], replacement: match[2], global: match[3] === 'g', path: match[4] }));
  assert.ok(commands.length > 0, 'Linux package metadata must use sed replacements');

  const touched = new Set();
  for (const command of commands) {
    if (!(command.path in fixtures)) continue;
    touched.add(command.path);
    const pattern = command.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    fixtures[command.path] = fixtures[command.path].replace(
      new RegExp(pattern, command.global ? 'g' : ''),
      command.replacement,
    );
  }

  for (const [path, content] of Object.entries(fixtures)) {
    assert.ok(touched.has(path), `${path} must be transformed by the Linux package metadata block`);
    assert.doesNotMatch(content, /VSCodium|vscodium|Visual Studio Code|Microsoft Corporation|@microsoft\.com|https:\/\/code\.visualstudio\.com/, path);
    assert.match(content, /Vibecodium/, path);
  }
});

test('stable resource metadata contains no upstream brand identity', () => {
  const files = [
    'src/stable/resources/linux/code.appdata.xml',
    'src/stable/resources/linux/code.desktop',
    'src/stable/resources/linux/code-url-handler.desktop',
    'src/stable/resources/win32/VisualElementsManifest.xml',
  ];

  for (const file of files) {
    assert.doesNotMatch(
      read(file),
      /VSCodium|vscodium|Microsoft Corporation|Visual Studio Code|code\.visualstudio\.com|vscodium\.com/,
      file,
    );
  }

  assert.match(read('src/stable/resources/linux/code.appdata.xml'), /Vibecodium/);
  assert.match(read('src/stable/resources/win32/VisualElementsManifest.xml'), /ShortDisplayName="Vibecodium"/);
  for (const file of files.slice(1, 3)) {
    assert.match(read(file), /Keywords=vibecodium;/, file);
  }
});

test('the branded feed root matches the manifest generator paths', () => {
  const update = updateBlock().match(/setpath "product" "updateUrl" "([^"]+)"/);
  assert.ok(update, 'updateUrl must be set');
  const feedRoot = resolveDefault(update[1]);

  const feeds = generateUpdateFeeds({
    name: 'Vibecodium',
    version: '1.147.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
    date: '2026-11-22',
    quality: 'stable',
    assets: [{
      platform: 'win32',
      architecture: 'x64',
      target: 'system',
      path: 'Vibecodium-x64-system-1.147.0.exe',
      sha256: 'a'.repeat(64),
      size: 123,
    }],
  }, { assetUrlRoot: 'https://github.com/ynotfins/vibecodium/releases/download/1.147.0' });

  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].path, 'stable/win32/x64/system/latest.json');
  assert.equal(
    `${feedRoot}/${feeds[0].path}`,
    'https://raw.githubusercontent.com/ynotfins/vibecodium/refs/heads/vibe/main/update-feed/stable/win32/x64/system/latest.json',
  );
});
