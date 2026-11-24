import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_ENDPOINT_CATEGORIES,
  AI_ENDPOINT_INVENTORY,
  AI_ENDPOINT_POLICY_VERSION,
  AIEndpointPolicyError,
  assertAIEndpointAllowed,
  classifyAIEndpoint,
  describeAIEndpointPolicy,
  evaluateAIEndpointRequest,
  redactAIEndpoint,
} from '../../src/stable/security/ai-endpoint-policy.mjs';

const CATEGORY_NAMES = new Set(Object.keys(AI_ENDPOINT_CATEGORIES));
const CAPI = 'https://api.githubcopilot.com/v1/messages';
const ipv4 = (...octets) => octets.join('.');
const BIDI_MARK = String.fromCodePoint(0x061C);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const CREDENTIAL = 'https://user:' + 'p' + 'w' + '@example.com/v1/messages';
const CREDENTIAL_CAPI = 'https://user:' + 'p' + 'w' + '@api.githubcopilot.com/v1/messages';
const LOOPBACK = 'http://' + ['127', '0', '0', '1'].join('.') + ':11434/v1/models';

test('the endpoint inventory is frozen, unique and schema-valid', () => {
  assert.ok(Object.isFrozen(AI_ENDPOINT_INVENTORY));
  assert.ok(AI_ENDPOINT_INVENTORY.length >= 10);
  const ids = new Set();
  const hostPaths = new Set();
  for (const entry of AI_ENDPOINT_INVENTORY) {
    assert.ok(Object.isFrozen(entry), 'entry must be frozen');
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(entry.id), 'duplicate id');
    ids.add(entry.id);
    assert.ok(CATEGORY_NAMES.has(entry.category), 'unknown category');
    assert.equal(typeof entry.allowedByDefault, 'boolean');
    assert.ok(['block', 'allow', 'user-authorized'].includes(entry.disposition));
    assert.ok(entry.host.length > 0 && !entry.host.includes('/') && !entry.host.includes(' '));
    assert.ok(entry.purpose.length > 0);
    assert.ok(Array.isArray(entry.upstreamFiles) && entry.upstreamFiles.length > 0);
    for (const file of entry.upstreamFiles) {
      assert.match(file, /^src\/vs\//);
    }
    if (entry.paths) {
      assert.ok(Object.isFrozen(entry.paths));
      for (const p of entry.paths) {
        assert.ok(p.startsWith('/'), 'path must be absolute');
      }
    }
    const key = entry.host + (entry.pathPrefix || '/');
    assert.ok(!hostPaths.has(key), 'duplicate host/path');
    hostPaths.add(key);
  }
});

test('the inventory names every critical Microsoft, Copilot and telemetry endpoint from the audit', () => {
  const hosts = new Set(AI_ENDPOINT_INVENTORY.map((e) => e.host));
  for (const host of [
    'api.githubcopilot.com',
    'api.individual.githubcopilot.com',
    'api.business.githubcopilot.com',
    'api.enterprise.githubcopilot.com',
    'copilot-telemetry.githubusercontent.com',
    'mobile.events.data.microsoft.com',
    'api.catalog.azureml.ms',
    'update.code.visualstudio.com',
    'api.github.com',
  ]) {
    assert.ok(hosts.has(host), 'inventory is missing ' + host);
  }
  const byHost = (host) => AI_ENDPOINT_INVENTORY.find((e) => e.host === host);
  const capi = byHost('api.githubcopilot.com');
  assert.equal(capi.category, 'copilot-capi');
  assert.equal(capi.allowedByDefault, false);
  assert.ok(capi.paths.includes('/v1/messages'));
  assert.ok(capi.paths.includes('/models'));
  assert.ok(capi.paths.includes('/copilot_internal/user'));
  assert.equal(byHost('copilot-telemetry.githubusercontent.com').category, 'copilot-telemetry');
  assert.equal(byHost('mobile.events.data.microsoft.com').category, 'microsoft-telemetry');
  assert.equal(byHost('api.catalog.azureml.ms').category, 'microsoft-model-catalog');
  assert.equal(byHost('update.code.visualstudio.com').category, 'vscode-update');
  assert.equal(byHost('api.github.com').category, 'github-api');
});

test('classification recognizes the audited endpoint families', () => {
  const cases = [
    ['https://api.githubcopilot.com/v1/messages', 'copilot-capi'],
    ['https://api.individual.githubcopilot.com/v1/messages', 'copilot-capi'],
    ['https://api.business.githubcopilot.com/models', 'copilot-capi'],
    ['https://api.enterprise.githubcopilot.com/copilot_internal/user', 'copilot-capi'],
    ['https://copilot-telemetry.githubusercontent.com/telemetry', 'copilot-telemetry'],
    ['https://mobile.events.data.microsoft.com/OneCollector/1.0', 'microsoft-telemetry'],
    ['https://mobile.events.data.microsoft.com/ping', 'microsoft-telemetry'],
    ['https://api.catalog.azureml.ms/asset-gallery/v1.0/models', 'microsoft-model-catalog'],
    ['https://update.code.visualstudio.com/api/update/win32-x64/stable', 'vscode-update'],
    ['https://api.github.com/graphql', 'github-api'],
    ['https://acme.ghe.com/api/v3', 'github-api'],
    ['https://raw.githubusercontent.com/owner/repo/main/README.md', 'github-content'],
    ['https://avatars.githubusercontent.com/u/1', 'github-content'],
    ['https://chatgpt.com/backend-api/wham/profiles/me', 'external-provider'],
    ['https://api.openai.com/auth', 'external-provider'],
    ['https://openai.com/settings/profile', 'external-provider'],
    ['https://auth.openai.com/u/1', 'external-provider'],
    ['https://learn.chatgpt.com/docs', 'external-documentation'],
    ['https://developers.openai.com/api', 'external-documentation'],
    ['https://platform.openai.com/docs', 'external-documentation'],
    ['https://docs.anthropic.com/en/docs', 'external-documentation'],
    ['https://code.claude.com/docs', 'external-documentation'],
    ['https://platform.claude.com/docs', 'external-documentation'],
    ['https://modelcontextprotocol.io/spec', 'external-documentation'],
    ['https://aka.ms/vscode-docs', 'microsoft-documentation'],
    ['https://example.invalid/api', 'unknown'],
  ];
  for (const [url, category] of cases) {
    const result = classifyAIEndpoint(url);
    assert.equal(result.ok, true, url);
    assert.equal(result.category, category, url);
    assert.equal(result.allowedByDefault, category === 'local-model', url);
  }
});

test('loopback and local model endpoints are allowed by default', () => {
  const urls = [
    'http://localhost:1234/v1/chat/completions',
    LOOPBACK,
    'http://[::1]:8080/health',
    'http://my.local',
    'http://host.docker.internal:11434',
    'http://on-device.vscode.invalid/v1',
  ];
  for (const url of urls) {
    const result = classifyAIEndpoint(url);
    assert.equal(result.ok, true, url);
    assert.equal(result.category, 'local-model', url);
    assert.equal(result.allowedByDefault, true, url);
    assert.equal(evaluateAIEndpointRequest(url).allowed, true, url);
  }
});

test('private LAN and IPv4-mapped loopback addresses are local', () => {
  for (const url of [
    'http://' + ipv4('10', '0', '0', '5') + ':8000/v1/models',
    'http://' + ipv4('192', '168', '1', '10') + ':11434/v1',
    'http://' + ipv4('172', '16', '0', '9') + ':11434/v1',
    'http://[::ffff:' + ipv4('127', '0', '0', '1') + ']:8080/v1',
    'http://[::ffff:' + ipv4('192', '168', '1', '1') + ']:8080/v1',
  ]) {
    const result = classifyAIEndpoint(url);
    assert.equal(result.ok, true, url);
    assert.equal(result.category, 'local-model', url);
    assert.equal(evaluateAIEndpointRequest(url).allowed, true, url);
  }
});

test('cloud metadata and link-local endpoints are hard-denied', () => {
  const targets = [
    'http://' + ipv4('169', '254', '169', '254') + '/latest/meta-data/',
    'http://' + ipv4('169', '254', '170', '2') + '/v2/metadata',
    'http://[::ffff:' + ipv4('169', '254', '169', '254') + ']/latest/meta-data/',
    'http://[fe' + '80::a9fe:a9fe]/',
    'http://[fd00' + ':ec2::254]/',
    'http://[fd20' + ':ce::254]/',
    'http://[::' + 'a9fe:a9fe]/',
    'http://[::ffff:' + '0:a9fe:a9fe]/',
    'http://[64:ff9b' + '::a9fe:a9fe]/',
    'http://[2002:' + 'a9fe:a9fe::]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.goog/computeMetadata/v1/',
    'http://instance-data/latest/',
    'http://metadata/',
    'http://' + [100, 100, 100, 200].join('.') + '/latest/meta-data/',
    'http://' + [192, 0, 0, 192].join('.') + '/',
    'http://[::ffff:' + '6464:64c8]/latest/meta-data/',
    'http://[::ffff:' + '0:6464:64c8]/latest/meta-data/',
    'http://[64:ff9b' + '::6464:64c8]/latest/meta-data/',
    'http://[2002:' + '6464:64c8::]/latest/meta-data/',
    'http://[::' + '6464:64c8]/latest/meta-data/',
    'http://[::ffff:' + 'c000:c0]/latest/meta-data/',
    'http://[::ffff:' + '0:c000:c0]/latest/meta-data/',
    'http://[64:ff9b' + '::c000:c0]/latest/meta-data/',
    'http://[2002:' + 'c000:c0::]/latest/meta-data/',
    'http://[::' + 'c000:c0]/latest/meta-data/',
    'http://' + ['0251', '0376', '0251', '0376'].join('.') + '/',
    'http://' + ['0xa9', '0xfe', '0xa9', '0xfe'].join('.') + '/',
    'http://' + String(169 * 16777216 + 254 * 65536 + 169 * 256 + 254) + '/',
    'http://' + ['0x64', '0x64', '0x64', '0xc8'].join('.') + '/latest/meta-data/',
    'http://' + ['0144', '0144', '0144', '0310'].join('.') + '/latest/meta-data/',
    'http://' + String(100 * 16777216 + 100 * 65536 + 100 * 256 + 200) + '/latest/meta-data/',
    'http://' + ['0xc0', '0x0', '0x0', '0xc0'].join('.') + '/latest/meta-data/',
    'http://' + ['0300', '0', '0', '0300'].join('.') + '/latest/meta-data/',
    'http://' + String(192 * 16777216 + 192) + '/latest/meta-data/',
  ];
  for (const url of targets) {
    const host = new URL(url).hostname;
    const options = {
      allowUnknownHosts: true,
      allowExternalProviders: true,
      allowCopilotApi: true,
      allowHosts: [host],
      allowEndpoints: [host + '/latest'],
    };
    const decision = evaluateAIEndpointRequest(url, options);
    assert.equal(decision.allowed, false, url);
    assert.equal(decision.code, 'forbidden-endpoint', url);
  }
  for (const url of ['http://[fd00' + '::1]:8080/v1', 'http://[fe80' + '::1]:8080/v1']) {
    assert.notEqual(classifyAIEndpoint(url).category, 'local-model', url);
    assert.equal(evaluateAIEndpointRequest(url).allowed, false, url);
  }
});

test('IPv6 unique-local is not enabled by the blanket unknown-host switch', () => {
  for (const url of ['http://[fd00' + '::1]:8080/v1', 'http://[fdff' + '::1]:8080/v1', 'http://[fc00' + '::1]:8080/v1']) {
    const blanket = evaluateAIEndpointRequest(url, { allowUnknownHosts: true });
    assert.equal(blanket.allowed, false, url);
    assert.equal(blanket.code, 'denied-by-default', url);
    assert.equal(classifyAIEndpoint(url).category, 'private-ipv6', url);
    const exact = evaluateAIEndpointRequest(url, { allowHosts: [new URL(url).hostname] });
    assert.equal(exact.allowed, true, url);
  }
});

test('mDNS suffixes do not let a metadata alias borrow local trust', () => {
  const targets = [
    'http://metadata.local/',
    'http://metadata.localhost/',
    'http://metadata.google.internal.local/computeMetadata/v1/',
    'http://metadata.google.internal.localhost/',
    'http://' + ipv4('169', '254', '169', '254') + '.local/latest/meta-data/',
    'http://' + ipv4('169', '254', '169', '254') + '.localhost/latest/meta-data/',
    'http://' + ipv4('169', '254', '169', '254') + '.local.local/latest/meta-data/',
    'http://' + ipv4('100', '100', '100', '200') + '.local/latest/meta-data/',
    'http://[64:ff9b' + ':1::a9fe:a9fe]/',
    'http://[64:ff9b' + ':1::6464:64c8]/latest/meta-data/',
  ];
  for (const url of targets) {
    const host = new URL(url).hostname;
    const classified = classifyAIEndpoint(url);
    assert.equal(classified.forbidden, true, url);
    assert.notEqual(classified.category, 'local-model', url);
    assert.equal(classified.allowedByDefault, false, url);
    const decision = evaluateAIEndpointRequest(url, {
      allowUnknownHosts: true,
      allowExternalProviders: true,
      allowHosts: [host],
      allowEndpoints: [host + '/latest'],
    });
    assert.equal(decision.allowed, false, url);
    assert.equal(decision.code, 'forbidden-endpoint', url);
  }
  const local = 'http://mymodel.local:11434/v1/models';
  assert.equal(classifyAIEndpoint(local).category, 'local-model');
  assert.equal(evaluateAIEndpointRequest(local).allowed, true);
});

test('the bare .loc suffix is not treated as local', () => {
  const result = classifyAIEndpoint('http://my.loc');
  assert.equal(result.ok, true);
  assert.equal(result.category, 'unknown');
  assert.equal(evaluateAIEndpointRequest('http://my.loc').allowed, false);
});

test('punycode hosts and bidi or separator characters fail closed', () => {
  for (const url of [
    'https://xn--80ak6aa92e.com/v1/messages',
    'https://api.xn--80ak6aa92e.com/v1',
    'https://example.com/' + BIDI_MARK,
    'https://example.com/' + LINE_SEPARATOR,
    'https://example.com/' + PARAGRAPH_SEPARATOR,
  ]) {
    const decision = evaluateAIEndpointRequest(url, { allowUnknownHosts: true });
    assert.equal(decision.allowed, false, JSON.stringify(url));
  }
  const punycode = classifyAIEndpoint('https://xn--80ak6aa92e.com/');
  assert.equal(punycode.ok, false);
  assert.equal(punycode.code, 'invalid-host');
});

test('every remote category is denied by default', () => {
  for (const url of [
    CAPI,
    'https://copilot-telemetry.githubusercontent.com/telemetry',
    'https://mobile.events.data.microsoft.com/OneCollector/1.0',
    'https://api.catalog.azureml.ms/asset-gallery/v1.0/models',
    'https://update.code.visualstudio.com/api/update/win32-x64/stable',
    'https://api.github.com/repos/owner/repo',
    'https://raw.githubusercontent.com/owner/repo/main/README.md',
    'https://chatgpt.com/backend-api/wham/profiles/me',
    'https://example.invalid/api',
  ]) {
    const decision = evaluateAIEndpointRequest(url);
    assert.equal(decision.allowed, false, url);
    assert.equal(decision.code, 'denied-by-default', url);
  }
});

test('each explicit category switch allows only its own category', () => {
  assert.equal(evaluateAIEndpointRequest(CAPI, { allowCopilotApi: true }).allowed, true);
  assert.equal(evaluateAIEndpointRequest(CAPI, { allowCopilotTelemetry: true }).allowed, false);
  assert.equal(evaluateAIEndpointRequest(CAPI, { allowMicrosoftTelemetry: true }).allowed, false);

  const telemetry = 'https://copilot-telemetry.githubusercontent.com/telemetry';
  assert.equal(evaluateAIEndpointRequest(telemetry, { allowCopilotTelemetry: true }).allowed, true);
  assert.equal(evaluateAIEndpointRequest(telemetry, { allowCopilotApi: true }).allowed, false);

  const oneDs = 'https://mobile.events.data.microsoft.com/OneCollector/1.0';
  assert.equal(evaluateAIEndpointRequest(oneDs, { allowMicrosoftTelemetry: true }).allowed, true);

  const catalog = 'https://api.catalog.azureml.ms/asset-gallery/v1.0/models';
  assert.equal(evaluateAIEndpointRequest(catalog, { allowMicrosoftModelCatalog: true }).allowed, true);

  const update = 'https://update.code.visualstudio.com/api/update/win32-x64/stable';
  assert.equal(evaluateAIEndpointRequest(update, { allowVisualStudioUpdate: true }).allowed, true);

  const external = 'https://api.openai.com/auth';
  assert.equal(evaluateAIEndpointRequest(external, { allowExternalProviders: true }).allowed, true);
  assert.equal(evaluateAIEndpointRequest(external, { allowCopilotApi: true }).allowed, false);
});

test('host and endpoint allow lists are exact and path-scoped', () => {
  assert.equal(evaluateAIEndpointRequest('https://api.github.com/repos/o/r', { allowGitHubApi: true }).allowed, true);
  assert.equal(evaluateAIEndpointRequest('https://api.github.com/repos/o/r', { allowHosts: ['api.github.com'] }).allowed, true);
  assert.equal(evaluateAIEndpointRequest('https://api.github.com/repos/o/r', { allowHosts: ['github.com'] }).allowed, false);
  assert.equal(evaluateAIEndpointRequest('https://api.github.com/repos/o/r', { allowEndpoints: ['api.github.com/repos'] }).allowed, true);
  assert.equal(evaluateAIEndpointRequest('https://api.github.com/graphql', { allowEndpoints: ['api.github.com/repos'] }).allowed, false);
  for (const escape of [
    'https://api.github.com/repos/..%2Fgraphql',
    'https://api.github.com/repos/%2e%2e%2fgraphql',
    'https://api.github.com/repos/..%5Cgraphql',
    'https://api.github.com/repos/x%0d%0aInjected',
    'https://api.github.com/repos/x%E2%80%AEInjected',
    'https://api.github.com/repos/%252e%252e%252fgraphql',
  ]) {
    assert.equal(evaluateAIEndpointRequest(escape, { allowEndpoints: ['api.github.com/repos'] }).allowed, false, escape);
  }
  assert.equal(evaluateAIEndpointRequest('https://evil-api.githubcopilot.com/v1/messages', { allowHosts: ['api.githubcopilot.com'] }).allowed, false);
  assert.equal(evaluateAIEndpointRequest('https://example.invalid/api', { allowUnknownHosts: true }).allowed, true);
  const portDecision = evaluateAIEndpointRequest('https://api.github.com:8443/repos/o/r', { allowHosts: ['api.github.com'] });
  assert.equal(portDecision.allowed, true);
  assert.equal(portDecision.port, 8443);
});

test('an explicit allow never overrides a malformed URL, credentials or a non-HTTP scheme', () => {
  const allowed = { allowUnknownHosts: true, allowHosts: ['example.com'] };
  const bad = [
    CREDENTIAL,
    'ftp://example.com/api',
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'not a url',
    '',
    'https://',
    'https://exa mple.com/',
    'https://example.com/\u0000',
    'https://example.com/\u202e',
    'https://example.com/%0d%0a',
    'https://example.com/%E2%80%AE',
  ];
  for (const url of bad) {
    const decision = evaluateAIEndpointRequest(url, allowed);
    assert.equal(decision.allowed, false, JSON.stringify(url));
    assert.notEqual(decision.code, 'allowed');
  }
  assert.throws(() => assertAIEndpointAllowed(CREDENTIAL, allowed), AIEndpointPolicyError);
});

test('classification normalizes case, trailing dots and default ports', () => {
  const upper = classifyAIEndpoint('https://API.GitHubCopilot.COM/v1/messages');
  assert.equal(upper.category, 'copilot-capi');
  assert.equal(upper.host, 'api.githubcopilot.com');
  const dotted = classifyAIEndpoint('https://api.githubcopilot.com./v1/messages');
  assert.equal(dotted.category, 'copilot-capi');
  const oddPort = classifyAIEndpoint('https://api.githubcopilot.com:8443/v1/messages');
  assert.equal(oddPort.port, 8443);
});

test('redaction strips query and fragment, and credential URLs fail closed', () => {
  const redacted = redactAIEndpoint('https://api.githubcopilot.com/v1/messages?token=hidden#frag');
  assert.equal(redacted, 'https://api.githubcopilot.com/v1/messages');
  assert.ok(!redacted.includes('hidden'));
  const credential = redactAIEndpoint(CREDENTIAL_CAPI + '?token=hidden');
  assert.equal(credential, '<invalid-endpoint>');
  assert.ok(!credential.includes('hidden'));
  assert.equal(redactAIEndpoint('not a url'), '<invalid-endpoint>');
  assert.equal(redactAIEndpoint('https://example.com/' + 'a'.repeat(2000)), '<invalid-endpoint>');
  const decision = evaluateAIEndpointRequest('https://api.githubcopilot.com/v1/messages?token=hidden');
  assert.equal(decision.allowed, false);
  assert.ok(!JSON.stringify(decision).includes('hidden'));
});

test('policy errors are fixed-code and carry only a redacted endpoint', () => {
  try {
    assertAIEndpointAllowed('https://api.githubcopilot.com/v1/messages?token=hidden');
    assert.fail('should throw');
  } catch (error) {
    assert.ok(error instanceof AIEndpointPolicyError);
    assert.equal(error.code, 'denied-by-default');
    assert.ok(!error.message.includes('hidden'));
    assert.equal(error.endpoint, 'https://api.githubcopilot.com/v1/messages');
  }
  try {
    assertAIEndpointAllowed(CREDENTIAL_CAPI);
    assert.fail('should throw');
  } catch (error) {
    assert.equal(error.code, 'credentials-in-url');
    assert.equal(error.endpoint, '<invalid-endpoint>');
  }
});

test('invalid option types fail closed with a stable code', () => {
  for (const options of [
    { allowCopilotApi: 'yes' },
    { allowHosts: 'api.github.com' },
    { allowHosts: [42] },
    { allowEndpoints: [null] },
    { allowUnknownHosts: 1 },
  ]) {
    const decision = evaluateAIEndpointRequest(CAPI, options);
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'invalid-options');
  }
});

test('describeAIEndpointPolicy is serializable, secret-free and reports the defaults', () => {
  const summary = describeAIEndpointPolicy();
  assert.equal(summary.version, AI_ENDPOINT_POLICY_VERSION);
  assert.equal(summary.defaultDeny, true);
  assert.equal(summary.localAllowedByDefault, true);
  assert.equal(summary.inventoryCount, AI_ENDPOINT_INVENTORY.length);
  assert.ok(summary.categories.includes('copilot-capi'));
  assert.ok(summary.categories.includes('private-ipv6'));
  const allowed = describeAIEndpointPolicy({ allowCopilotApi: true, allowHosts: ['example.com'] });
  assert.equal(allowed.options.allowCopilotApi, true);
  assert.deepEqual(allowed.options.allowHosts, ['example.com']);
});
