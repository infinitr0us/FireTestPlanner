// Shared source traversal for the catalogue guard and the migration audit.
// Uses the parser already supplied by Vite, with no browser/runtime dependency.
import { parseSync } from 'rolldown/utils';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path)
      : path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

export function walk(node, visit, parents = []) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node, parents);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(child)) child.forEach(value => walk(value, visit, [...parents, node]));
    else if (child && typeof child === 'object') walk(child, visit, [...parents, node]);
  }
}

export function parseFile(path) {
  const source = readFileSync(path, 'utf8');
  const result = parseSync(path, source);
  if (result.errors.length) throw new Error(`${path}: ${JSON.stringify(result.errors)}`);
  return { source, ast: result.program };
}

export function collectKeys(root) {
  const keys = new Set();
  const errors = [];
  for (const file of sourceFiles(root)) {
    if (/i18n(?:-fr)?\.ts$/.test(file)) continue;
    const { ast } = parseFile(file);
    const imported = new Map();
    const namespaces = new Set();
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration' && /(?:^|\/)i18n$/.test(node.source.value)) {
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier') imported.set(spec.local.name, spec.imported.name);
          else if (spec.type === 'ImportNamespaceSpecifier') namespaces.add(spec.local.name);
          else errors.push(`${file}: unsupported translation import`);
        }
      }
      if (node.type.startsWith('Export') && node.source && /(?:^|\/)i18n$/.test(node.source.value)) errors.push(`${file}: import translations directly; re-exports cannot be collected`);
    }
    walk(ast, (node, parents) => {
      const parent = parents.at(-1);
      if (node.type === 'Identifier' && namespaces.has(node.name)
        && parent?.type !== 'ImportNamespaceSpecifier'
        && !(parent?.type === 'MemberExpression' && parent.object === node)) {
        errors.push(`${file}:${node.start}: do not alias or destructure the translation namespace`);
      }
      if (node.type === 'Identifier' && ['t', 'plural'].includes(imported.get(node.name))
        && parent?.type !== 'ImportSpecifier'
        && !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
        && !(parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)
        && !(parent?.type === 'CallExpression' && parent.callee === node)) {
        errors.push(`${file}:${node.start}: call the imported translator directly; aliases cannot be collected`);
      }
      if (node.type === 'MemberExpression' && namespaces.has(node.object.name)
        && (node.computed || ['t', 'plural'].includes(node.property.name))
        && !(parent?.type === 'CallExpression' && parent.callee === node && !node.computed)) {
        errors.push(`${file}:${node.start}: translation calls must use direct, named properties`);
      }
      if (node.type !== 'CallExpression') return;
      const name = node.callee.type === 'Identifier' ? imported.get(node.callee.name)
        : node.callee.type === 'MemberExpression' && namespaces.has(node.callee.object.name) ? node.callee.property.name : '';
      if (!['t', 'plural'].includes(name)) return;
      if (node.arguments.length < (name === 'plural' ? 2 : 1)) errors.push(`${file}:${node.start}: missing translation key`);
      const args = name === 'plural' ? node.arguments.slice(0, 2) : node.arguments.slice(0, 1);
      for (const arg of args) {
        const key = arg.type === 'Literal' && typeof arg.value === 'string' ? arg.value
          : arg.type === 'TemplateLiteral' && !arg.expressions.length ? arg.quasis[0].value.cooked : null;
        if (key === null) errors.push(`${file}:${node.start}: translation keys must be static literals`);
        else keys.add(key);
      }
    });
  }
  return { keys: [...keys].sort(), errors };
}
