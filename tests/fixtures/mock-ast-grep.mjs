#!/usr/bin/env node
// Local stand-in for the ast-grep `sg` CLI used by the provider tests.
// It validates the provider argv contract and writes the same --json=stream
// shape that ast-grep 0.51.3 produces (zero-based lines and columns).
import process from 'node:process';

const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`mock-ast-grep: ${message}\n`);
  process.exit(2);
}

function valueOf(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) fail(`missing ${flag}`);
  return args[index + 1];
}

function match(text, line, column, extra = {}) {
  const languageJson = { javascript: 'JavaScript', typescript: 'TypeScript', tsx: 'Tsx' }[valueOf('--lang')];
  return {
    text,
    range: {
      byteOffset: { start: 0, end: Buffer.byteLength(text) },
      start: { line, column },
      end: { line, column: column + text.length },
    },
    file: '<stdin>',
    lines: text,
    charCount: { leading: 0, trailing: 0 },
    language: languageJson,
    ...extra,
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (args[0] !== 'run') fail('expected the run subcommand');
if (!args.includes('--stdin')) fail('missing --stdin');
if (args.find((arg) => arg.startsWith('--json=')) !== '--json=stream') fail('expected --json=stream');
if (valueOf('--color') !== 'never') fail('expected --color never');
if (!['javascript', 'typescript', 'tsx'].includes(valueOf('--lang'))) fail('unsupported language');

const mode = process.env.MOCK_SG_MODE ?? 'matches';
const pattern = valueOf('--pattern');
let source = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { source += chunk; });
process.stdin.on('end', () => {
  if (mode === 'none') process.exit(1);
  if (mode === 'fail') fail('simulated ast-grep failure');
  if (mode === 'malformed') {
    process.stdout.write('{not json}\n');
    return;
  }
  if (mode === 'badschema') {
    emit({ text: 'broken', range: { start: { line: 0 } } });
    return;
  }
  if (mode === 'huge') {
    for (let index = 0; index < 6; index += 1) process.stdout.write('x'.repeat(1024 * 1024));
    return;
  }
  if (mode === 'slow') {
    setTimeout(() => emit(match('late', 0, 0)), 5_000);
    return;
  }
  if (mode === 'huge-text') {
    emit(match(`route:${pattern}:` + 'y'.repeat(10_000), 2, 3));
    return;
  }
  if (mode === 'many') {
    for (let index = 0; index < 100; index += 1) emit(match(`hit-${index}`, index, index));
    return;
  }
  if (mode === 'proto-meta') {
    emit(match('proto', 0, 0, {
      metaVariables: {
        single: { ['__proto__']: { text: 'polluted', range: { byteOffset: { start: 0, end: 8 }, start: { line: 0, column: 0 }, end: { line: 0, column: 8 } } } },
        multi: {},
        transformed: {},
      },
    }));
    return;
  }
  if (mode === 'control-text') {
    emit(match('safe:\u001b[31mred\u001b[0m:\u202Eevil', 0, 0, {
      metaVariables: {
        single: { NAME: { text: 'a\u0007b\u202Ec', range: { byteOffset: { start: 0, end: 5 }, start: { line: 0, column: 0 }, end: { line: 0, column: 5 } } } },
        multi: {},
        transformed: { T: 'x\u0000y' },
      },
    }));
    return;
  }
  if (mode === 'bad-language') {
    emit(match('foreign', 0, 0, { language: 'Rust' }));
    return;
  }
  if (mode === 'wrong-language') {
    emit(match('foreign', 0, 0, { language: 'TypeScript' }));
    return;
  }
  if (source.length === 0) fail('expected source on stdin');
  emit(match(`first:${pattern}`, 1, 2, {
    metaVariables: {
      single: { NAME: { text: 'handler', range: { byteOffset: { start: 0, end: 7 }, start: { line: 1, column: 2 }, end: { line: 1, column: 9 } } } },
      multi: { ARGS: [{ text: 'a', range: { byteOffset: { start: 0, end: 1 }, start: { line: 1, column: 9 }, end: { line: 1, column: 10 } } }] },
      transformed: { UPPER: 'HANDLER' },
    },
  }));
  emit(match(`second:${pattern}`, 4, 0));
});
