import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAX_SYMBOLS_PER_FILE, extractSymbols, validateSymbolProvider } from './index-engine.mjs';

export { validateSymbolProvider };

export const SYMBOL_PROVIDER_VERSION = 1;
export const MAX_SYMBOL_SOURCE_BYTES = 1_000_000;
export const MAX_AST_NODES = 2_000_000;
export const TREE_SITTER_VENDOR_DIR = fileURLToPath(new URL('./vendor/tree-sitter/', import.meta.url));

export class SymbolProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SymbolProviderError';
  }
}

function fail(message) {
  throw new SymbolProviderError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSymbolSource(source) {
  if (typeof source !== 'string') fail('source must be a string');
  const normalized = source.replace(/^\uFEFF/, '');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_SYMBOL_SOURCE_BYTES) {
    fail(`source must not exceed ${MAX_SYMBOL_SOURCE_BYTES} bytes`);
  }
  return normalized;
}

function validateMaxSymbols(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SYMBOLS_PER_FILE) {
    fail(`maxSymbols must be an integer between 1 and ${MAX_SYMBOLS_PER_FILE}`);
  }
  return value;
}

function validateFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
    fail('filePath must be a non-empty string');
  }
  if (filePath.includes('\0')) fail('filePath contains a NUL character');
  return path.extname(filePath).toLowerCase();
}

const GRAMMARS = Object.freeze({
  javascript: Object.freeze({
    name: 'javascript',
    wasm: 'tree-sitter-javascript.wasm',
    extensions: Object.freeze(['.js', '.jsx', '.mjs', '.cjs']),
  }),
  typescript: Object.freeze({
    name: 'typescript',
    wasm: 'tree-sitter-typescript.wasm',
    extensions: Object.freeze(['.ts', '.mts', '.cts']),
  }),
  tsx: Object.freeze({
    name: 'tsx',
    wasm: 'tree-sitter-tsx.wasm',
    extensions: Object.freeze(['.tsx']),
  }),
});

const GRAMMAR_BY_EXTENSION = new Map();
for (const grammar of Object.values(GRAMMARS)) {
  for (const extension of grammar.extensions) GRAMMAR_BY_EXTENSION.set(extension, grammar.name);
}

export function grammarForFile(filePath) {
  const extension = validateFilePath(filePath);
  return GRAMMAR_BY_EXTENSION.get(extension) ?? null;
}

export function createRegexSymbolProvider(options = {}) {
  if (!isPlainObject(options)) fail('options must be an object');
  const extract = options.extractSymbols ?? extractSymbols;
  if (typeof extract !== 'function') fail('extractSymbols must be a function');
  return Object.freeze({
    id: 'regex',
    version: SYMBOL_PROVIDER_VERSION,
    supports(filePath) {
      return typeof filePath === 'string' && filePath.length > 0 && filePath.length <= 4096 && !filePath.includes('\0');
    },
    async extractSymbols(source, extractOptions = {}) {
      if (!isPlainObject(extractOptions)) fail('options must be an object');
      return extract(validateSymbolSource(source), extractOptions);
    },
  });
}

function nameField(node) {
  const field = node.childForFieldName('name');
  if (!field) return null;
  const name = field.text;
  return /^#?[A-Za-z_$][\w$]*$/.test(name) ? { name, node: field } : null;
}

function named(node, kind, scope, descend) {
  const field = nameField(node);
  return field ? { name: field.name, node: field.node, kind, scope, descend } : null;
}

function methodKind(node, name) {
  if (name === 'constructor') return 'constructor';
  if (node.children.some((child) => child.type === 'get')) return 'getter';
  if (node.children.some((child) => child.type === 'set')) return 'setter';
  return 'method';
}

function declarationFor(node) {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_signature':
      return named(node, 'function', false, false);
    case 'class_declaration':
    case 'abstract_class_declaration':
      return named(node, 'class', true, true);
    case 'interface_declaration':
      return named(node, 'interface', true, true);
    case 'type_alias_declaration':
      return named(node, 'type', true, true);
    case 'enum_declaration':
      return named(node, 'enum', true, false);
    case 'internal_module':
      return named(node, 'namespace', true, true);
    case 'method_definition':
    case 'method_signature':
    case 'abstract_method_signature': {
      const field = nameField(node);
      if (!field) return null;
      return { name: field.name, node: field.node, kind: methodKind(node, field.name), scope: false, descend: false };
    }
    case 'property_signature': {
      const field = nameField(node);
      if (!field) return null;
      return { name: field.name, node: field.node, kind: 'variable', scope: false, descend: false };
    }
    case 'public_field_definition':
    case 'field_definition':
    case 'variable_declarator': {
      const field = nameField(node);
      if (!field) return null;
      const value = node.childForFieldName('value');
      const callable = value && ['arrow_function', 'function', 'function_expression'].includes(value.type);
      return {
        name: field.name,
        node: field.node,
        kind: callable ? 'function' : 'variable',
        scope: false,
        descend: false,
      };
    }
    default:
      return null;
  }
}

const SKIP_SUBTREES = new Set(['arrow_function', 'function', 'function_expression', 'generator_function']);

function extractFromTree(tree, source, maxSymbols) {
  const symbols = [];
  const seen = new Set();
  const stack = [{ node: tree.rootNode, container: undefined }];
  let visited = 0;
  while (stack.length > 0 && symbols.length < maxSymbols) {
    visited += 1;
    if (visited > MAX_AST_NODES) fail('syntax tree contains too many nodes');
    const current = stack.pop();
    const declaration = declarationFor(current.node);
    let nextContainer = current.container;
    let descend = true;
    if (declaration) {
      const container = current.container;
      const position = declaration.node.startPosition;
      const key = `${position.row}:${position.column}:${declaration.name}:${declaration.kind}:${container ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push({
          name: declaration.name,
          kind: declaration.kind,
          line: position.row + 1,
          column: position.column + 1,
          ...(container ? { container } : {}),
        });
      }
      if (declaration.scope) nextContainer = declaration.name;
      descend = declaration.descend;
    } else if (SKIP_SUBTREES.has(current.node.type)) {
      descend = false;
    }
    if (!descend) continue;
    const children = current.node.namedChildren;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], container: nextContainer });
    }
  }
  return symbols.sort((a, b) => a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
}

export function createTreeSitterSymbolProvider(options = {}) {
  if (!isPlainObject(options)) fail('options must be an object');
  const wasmDir = path.resolve(options.wasmDir ?? TREE_SITTER_VENDOR_DIR);
  const defaultMaxSymbols = validateMaxSymbols(options.maxSymbols ?? MAX_SYMBOLS_PER_FILE);
  let runtimePromise = null;
  const languagePromises = new Map();

  async function loadRuntime() {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        let runtime;
        try {
          runtime = await import(pathToFileURL(path.join(wasmDir, 'web-tree-sitter.js')).href);
        } catch {
          runtimePromise = null;
          fail('tree-sitter runtime is unavailable');
        }
        try {
          await runtime.Parser.init({
            locateFile: (asset) => {
              if (path.basename(asset) !== 'web-tree-sitter.wasm') {
                fail('tree-sitter requested an unexpected runtime asset');
              }
              return path.join(wasmDir, 'web-tree-sitter.wasm');
            },
          });
        } catch (error) {
          runtimePromise = null;
          if (error instanceof SymbolProviderError) throw error;
          fail('tree-sitter runtime failed to initialise');
        }
        return runtime;
      })();
    }
    return runtimePromise;
  }

  async function loadGrammar(grammarName) {
    const grammar = GRAMMARS[grammarName];
    if (!grammar) fail('unsupported tree-sitter grammar');
    let promise = languagePromises.get(grammarName);
    if (!promise) {
      promise = (async () => {
        const runtime = await loadRuntime();
        try {
          return await runtime.Language.load(path.join(wasmDir, grammar.wasm));
        } catch {
          fail(`tree-sitter grammar ${grammarName} is unavailable`);
        }
      })();
      languagePromises.set(grammarName, promise);
    }
    try {
      return await promise;
    } catch (error) {
      languagePromises.delete(grammarName);
      throw error;
    }
  }

  return Object.freeze({
    id: 'tree-sitter',
    version: SYMBOL_PROVIDER_VERSION,
    supports(filePath) {
      try {
        return grammarForFile(filePath) !== null;
      } catch {
        return false;
      }
    },
    async extractSymbols(source, extractOptions = {}) {
      if (!isPlainObject(extractOptions)) fail('options must be an object');
      const text = validateSymbolSource(source);
      const grammarName = grammarForFile(extractOptions.filePath);
      if (!grammarName) fail('file type is not supported by the tree-sitter provider');
      const maxSymbols = validateMaxSymbols(extractOptions.maxSymbols ?? defaultMaxSymbols);
      const grammar = await loadGrammar(grammarName);
      const runtime = await loadRuntime();
      const parser = new runtime.Parser();
      let tree;
      try {
        parser.setLanguage(grammar);
        tree = parser.parse(text);
      } finally {
        parser.delete();
      }
      if (!tree) fail('tree-sitter returned no syntax tree');
      try {
        return extractFromTree(tree, text, maxSymbols);
      } finally {
        tree.delete();
      }
    },
  });
}
