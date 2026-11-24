#!/usr/bin/env node
import process from 'node:process';

import { DocsIndex } from './docs-index.mjs';
import { SERVER_NAME, serveMcpStdio } from './mcp-server.mjs';

function usage() {
  return 'Usage: node server.mjs --root <source-id>=<absolute-markdown-directory> [--root ...]';
}

function parseRoots(argv) {
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(usage() + '\n');
      process.exit(0);
    }
    if (argument !== '--root') throw new Error('unknown argument: ' + argument);
    const value = argv[index + 1];
    if (typeof value !== 'string') throw new Error('--root requires <source-id>=<absolute-directory>');
    const equals = value.indexOf('=');
    if (equals < 1 || equals === value.length - 1) {
      throw new Error('--root requires <source-id>=<absolute-directory>');
    }
    roots.push({ id: value.slice(0, equals), path: value.slice(equals + 1) });
    index += 1;
  }
  if (roots.length === 0) throw new Error('at least one --root is required');
  return roots;
}

async function main() {
  const roots = parseRoots(process.argv.slice(2));
  const index = new DocsIndex({ roots });
  await index.refresh();
  await serveMcpStdio({ index, version: '0.1.0' });
}

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});

main().catch((error) => {
  process.stderr.write(SERVER_NAME + ': ' + (error?.message || 'failed to start') + '\n' + usage() + '\n');
  process.exitCode = 1;
});
