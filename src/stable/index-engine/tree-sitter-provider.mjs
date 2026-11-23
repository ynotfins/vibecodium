// Optional tree-sitter (WASM) symbol provider for the standalone index.
//
// The provider loads the vendored `@vscode/tree-sitter-wasm` runtime and grammars
// (MIT; see vendor/tree-sitter/README.md). It is optional on purpose: when the
// runtime or a grammar is missing, `createTreeSitterProvider` rejects so a caller
// can fall back to the built-in lexical extractor instead of failing the index.
// `wasmDir` is trusted configuration: the provider requires tree-sitter.js from
// that directory, so callers must never pass an untrusted path.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IndexEngineError, createLexicalSymbolProvider } from './index-engine.mjs';

export const TREE_SITTER_PROVIDER_ID = 'tree-sitter-wasm';
export const TREE_SITTER_DEFAULT_RUNTIME_DIR = fileURLToPath(new URL('./vendor/tree-sitter/', import.meta.url));
export const MAX_RUNTIME_BYTES = 4_000_000;
export const MAX_GRAMMAR_BYTES = 20_000_000;

export const TREE_SITTER_LANGUAGES = Object.freeze({
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
});

export const TREE_SITTER_GRAMMARS = Object.freeze({
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
});

const MAX_NAME_LENGTH = 512;
const MAX_SYMBOLS = 2_000;
const SIMPLE_FILE = /^[A-Za-z0-9._-]+$/;
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'generator_function']);
const CLASS_BODIES = new Set(['class_body']);
const NAMESPACE_STATEMENTS = new Set(['internal_module', 'module']);
const METHOD_TYPES = new Set(['method_definition', 'abstract_method_signature', 'method_signature']);
const require = createRequire(import.meta.url);

const runtimeInit = new WeakMap();

function fail(message) {
  throw new IndexEngineError(message);
}

function namedChildren(node) {
  const children = [];
  for (let index = 0; index < node.namedChildCount; index += 1) children.push(node.namedChild(index));
  return children;
}

function firstNamedChild(node, types) {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (types.has(child.type)) return child;
  }
  return null;
}

function nameOf(node) {
  const name = node.childForFieldName('name');
  const text = name?.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_NAME_LENGTH) return null;
  return /^#?[A-Za-z_$][\w$]*$/.test(text) ? text : null;
}

function symbolAt(name, kind, node, container) {
  return {
    name,
    kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    ...(container ? { container } : {}),
  };
}

function methodKind(node) {
  if (nameOf(node) === 'constructor') return 'constructor';
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child.type === 'property_identifier' || child.type === 'private_property_identifier') break;
    if (!child.isNamed && child.type === 'get') return 'getter';
    if (!child.isNamed && child.type === 'set') return 'setter';
  }
  return 'method';
}

function readAsset(dir, name, maxBytes) {
  if (typeof name !== 'string' || !SIMPLE_FILE.test(name)) fail('tree-sitter asset name is not valid');
  let bytes;
  try {
    bytes = readFileSync(path.join(dir, name));
  } catch {
    fail(`tree-sitter asset is missing: ${name}`);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) fail(`tree-sitter asset has an invalid size: ${name}`);
  return bytes;
}

function loadRuntime(dir) {
  readAsset(dir, 'tree-sitter.js', MAX_RUNTIME_BYTES);
  readAsset(dir, 'tree-sitter.wasm', MAX_RUNTIME_BYTES);
  let runtime;
  try {
    runtime = require(path.join(dir, 'tree-sitter.js'));
  } catch {
    fail('tree-sitter runtime could not be loaded');
  }
  if (!runtime || typeof runtime.Parser !== 'function' || typeof runtime.Language !== 'function' ||
      typeof runtime.Parser.init !== 'function') {
    fail('tree-sitter runtime is not supported');
  }
  return runtime;
}

async function startRuntime(runtime, dir) {
  let init = runtimeInit.get(runtime);
  if (!init) {
    init = Promise.resolve()
      .then(() => runtime.Parser.init({ locateFile: (file) => path.join(dir, path.basename(file)) }))
      .then(() => true)
      .catch((error) => {
        runtimeInit.delete(runtime);
        throw new IndexEngineError(`tree-sitter runtime failed to start: ${error?.message ?? 'unknown error'}`);
      });
    runtimeInit.set(runtime, init);
  }
  await init;
}

export async function createTreeSitterProvider({ wasmDir = TREE_SITTER_DEFAULT_RUNTIME_DIR } = {}) {
  if (typeof wasmDir !== 'string' || wasmDir.length === 0) fail('tree-sitter runtime directory must be a non-empty path');
  const dir = path.resolve(wasmDir);
  const runtime = loadRuntime(dir);
  await startRuntime(runtime, dir);

  const languages = new Map();
  for (const language of Object.keys(TREE_SITTER_GRAMMARS)) {
    const bytes = readAsset(dir, TREE_SITTER_GRAMMARS[language], MAX_GRAMMAR_BYTES);
    let loaded;
    try {
      loaded = await runtime.Language.load(new Uint8Array(bytes));
    } catch {
      fail(`tree-sitter grammar could not be loaded: ${language}`);
    }
    if (!loaded) fail(`tree-sitter grammar could not be loaded: ${language}`);
    languages.set(language, loaded);
  }

  const parsers = new Map();
  const parserFor = (language) => {
    let parser = parsers.get(language);
    if (!parser) {
      parser = new runtime.Parser();
      parser.setLanguage(languages.get(language));
      parsers.set(language, parser);
    }
    return parser;
  };

  const extractSymbols = (source, options = {}) => {
    if (typeof source !== 'string') fail('source must be a string');
    if (options === null || typeof options !== 'object') fail('options must be an object');
    if (typeof options.filePath !== 'string' || options.filePath.length === 0) {
      fail('filePath is required for the tree-sitter provider');
    }
    const language = TREE_SITTER_LANGUAGES[path.extname(options.filePath).toLowerCase()];
    if (!language) return null;
    const maxSymbols = options.maxSymbols ?? MAX_SYMBOLS;
    if (!Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > MAX_SYMBOLS) {
      fail(`maxSymbols must be an integer between 1 and ${MAX_SYMBOLS}`);
    }
    const tree = parserFor(language).parse(source.replace(/^\uFEFF/, ''));
    const symbols = [];
    const add = (symbol) => {
      if (symbols.length < maxSymbols) symbols.push(symbol);
    };
    const visit = (node, container) => {
      if (!node || symbols.length >= maxSymbols) return;
      switch (node.type) {
        case 'program':
        case 'export_statement':
        case 'ambient_declaration':
          for (const child of namedChildren(node)) visit(child, container);
          return;
        case 'expression_statement': {
          const child = firstNamedChild(node, NAMESPACE_STATEMENTS);
          if (child) visit(child, container);
          return;
        }
        case 'class_declaration':
        case 'abstract_class_declaration': {
          const name = nameOf(node);
          if (name) add(symbolAt(name, 'class', node, container));
          const body = firstNamedChild(node, CLASS_BODIES);
          if (body) {
            for (const member of namedChildren(body)) {
              if (!METHOD_TYPES.has(member.type)) continue;
              const memberName = nameOf(member);
              if (memberName) add(symbolAt(memberName, methodKind(member), member, name));
            }
          }
          return;
        }
        case 'interface_declaration': {
          const name = nameOf(node);
          if (name) add(symbolAt(name, 'interface', node, container));
          return;
        }
        case 'type_alias_declaration': {
          const name = nameOf(node);
          if (name) add(symbolAt(name, 'type', node, container));
          return;
        }
        case 'enum_declaration': {
          const name = nameOf(node);
          if (name) add(symbolAt(name, 'enum', node, container));
          return;
        }
        case 'internal_module':
        case 'module': {
          const name = nameOf(node);
          if (name) add(symbolAt(name, 'namespace', node, container));
          return;
        }
        case 'function_declaration':
        case 'generator_function_declaration': {
          const name = nameOf(node);
          if (name) add(symbolAt(name, 'function', node, container));
          return;
        }
        case 'lexical_declaration':
        case 'variable_declaration':
          for (const child of namedChildren(node)) {
            if (child.type !== 'variable_declarator') continue;
            const name = nameOf(child);
            if (!name) continue;
            const value = child.childForFieldName('value');
            add(symbolAt(name, value && FUNCTION_VALUES.has(value.type) ? 'function' : 'variable', child, container));
          }
          return;
        default:
          return;
      }
    };
    visit(tree.rootNode, undefined);
    return symbols.sort((a, b) => a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
  };

  return Object.freeze({
    id: TREE_SITTER_PROVIDER_ID,
    languages: Object.freeze([...languages.keys()]),
    extractSymbols,
    extract: (source, options) => extractSymbols(source, options),
  });
}

export async function createDefaultSymbolProvider({ wasmDir = TREE_SITTER_DEFAULT_RUNTIME_DIR } = {}) {
  try {
    return await createTreeSitterProvider({ wasmDir });
  } catch {
    return createLexicalSymbolProvider();
  }
}
