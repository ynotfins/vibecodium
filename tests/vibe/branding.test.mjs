import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  // ASSETS_REPOSITORY deliberately mirrors utils.sh: it stays on the upstream assets
  // feed until the own-update-feed slice (M0) brands the download/update endpoints.
  for (const [key, value] of Object.entries({
    APP_NAME: 'Vibecodium',
    ASSETS_REPOSITORY: 'VSCodium/vscodium',
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
  assert.match(build, /export ASSETS_REPOSITORY="VSCodium\/vscodium-insiders"/);
  assert.match(build, /export BINARY_NAME="vibecodium-insiders"/);
});
