/**
 * The static-timing scanner (spec §20.4), the one definition of a violation for the gate's test and
 * its generator. `node scripts/static-timing-scan.mjs [--json] [file…]` prints a summary or the JSON.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// TypeScript 7 ships no JS compiler API, so the parse is SWC's: the parser the jest transform uses.
import { parseSync } from '@swc/core';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SPECS_FILE = 'src/kernel/tempo/specs.ts';
export const UNITS_FILE = 'src/kernel/units.ts';
/** Groups every key of which is a prior: spec §20.4 names `MOTION.*` and `PACING_BASE_MS.*` whole. */
export const WHOLE_GROUPS = ['MOTION', 'PACING_BASE_MS'];

/** Out of scope: the kernel (the home of every allowed constant) and the renderer (spec §3 deviation 1). */
const OUT_OF_SCOPE = /^src\/(kernel|renderer)\//;
const SKIP = /([.]generated[.]tsx?|[.]d[.]ts)$/;
const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const parse = (file, source) => parseSync(source, { syntax: 'typescript', tsx: file.endsWith('.tsx'), target: 'es2022' });

/** Every in-scope source file, as sorted repo-relative POSIX paths. */
export function scopeFiles(dir = join(ROOT, 'src')) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...scopeFiles(full));
    else if (/[.]tsx?$/.test(entry.name)) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out.filter((f) => !OUT_OF_SCOPE.test(f) && !SKIP.test(f)).sort();
}

/** Calls `fn(node)` on every typed AST node. */
function each(node, fn) {
  if (Array.isArray(node)) for (const child of node) each(child, fn);
  else if (node !== null && typeof node === 'object') {
    if (node.type !== undefined) fn(node);
    for (const key of Object.keys(node)) if (key !== 'span') each(node[key], fn);
  }
}

const unwrap = (n) =>
  n?.type === 'TsAsExpression' || n?.type === 'TsSatisfiesExpression' || n?.type === 'TsConstAssertion' ||
  n?.type === 'ParenthesisExpression' ? unwrap(n.expression) : n;

function propKey(k) {
  switch (k?.type) {
    case 'Identifier': case 'StringLiteral': case 'JSXIdentifier': return k.value;
    case 'NumericLiteral': return String(k.value);
    case 'PrivateName': return `#${k.value}`;
    case 'Computed': return `[${exprText(k.expression)}]`;
    default: return '?';
  }
}

function exprText(n) {
  switch (n?.type) {
    case 'Identifier': return n.value;
    case 'ThisExpression': return 'this';
    case 'Super': return 'super';
    case 'Import': return 'import';
    case 'MemberExpression': case 'SuperPropExpression':
      return `${n.object ? exprText(n.object) : 'super'}.${propKey(n.property)}`;
    case 'CallExpression': return `${exprText(n.callee)}()`;
    case 'OptionalChainingExpression': return exprText(n.base);
    case 'ParenthesisExpression': case 'TsNonNullExpression': case 'TsAsExpression': return exprText(n.expression);
    default: return '(expr)';
  }
}

/** The claimed priors: every `identity.registry` key and `identity.motion` key in the tempo specs. */
export function tempoClaims(source = read(SPECS_FILE)) {
  const claims = new Set();
  each(parse(SPECS_FILE, source), (node) => {
    if (node.type !== 'KeyValueProperty' || propKey(node.key) !== 'identity') return;
    const identity = unwrap(node.value);
    for (const p of identity?.type === 'ObjectExpression' ? identity.properties : []) {
      const kind = propKey(p.key);
      const list = unwrap(p.value);
      if ((kind !== 'registry' && kind !== 'motion') || list?.type !== 'ArrayExpression') continue;
      for (const el of list.elements) {
        const s = el?.expression;
        if (s?.type === 'StringLiteral') claims.add(kind === 'motion' ? `MOTION.${s.value}` : s.value);
      }
    }
  });
  return [...claims].sort();
}

/** The `MS_PER_*` multipliers of kernel/units, evaluated from their declarations. */
export function unitMultipliers(source = read(UNITS_FILE)) {
  const env = new Map();
  const value = (n) => {
    if (n?.type === 'NumericLiteral') return n.value;
    if (n?.type === 'Identifier') return env.get(n.value) ?? null;
    if (n?.type !== 'BinaryExpression' || n.operator !== '*') return null;
    const [a, b] = [value(n.left), value(n.right)];
    return a === null || b === null ? null : a * b;
  };
  each(parse(UNITS_FILE, source), (node) => {
    if (node.type !== 'VariableDeclarator' || !/^MS_PER_/.test(node.id?.value ?? '')) return;
    const v = value(node.init);
    if (v !== null) env.set(node.id.value, v);
  });
  return [...env.values()].sort((a, b) => a - b);
}

/** The scan's inputs, read from the kernel once. */
export function scanContext() {
  return { claims: new Set(tempoClaims()), whole: new Set(WHOLE_GROUPS), multipliers: new Set(unitMultipliers()) };
}

const TYPE_KEYS = new Set(['typeAnnotation', 'typeParameters', 'typeParams', 'typeArguments', 'superTypeParams', 'returnType', 'implements']);
const TYPE_DECLS = new Set(['TsInterfaceDeclaration', 'TsTypeAliasDeclaration']);
const FUNCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression']);
const TRANSPARENT = new Set([
  'ParenthesisExpression', 'TsAsExpression', 'TsSatisfiesExpression', 'TsNonNullExpression', 'TsConstAssertion',
  'TsTypeAssertion', 'UnaryExpression', 'UpdateExpression', 'AwaitExpression', 'BinaryExpression',
  'ConditionalExpression', 'SequenceExpression', 'OptionalChainingExpression', 'SpreadElement', 'Computed',
  'Parameter', 'JSXExpressionContainer', 'ExportDeclaration',
]);
const STATEMENTS = {
  ReturnStatement: 'return', ThrowStatement: 'throw', IfStatement: 'if', WhileStatement: 'while',
  DoWhileStatement: 'while', ForStatement: 'for', ForInStatement: 'for', ForOfStatement: 'for',
  SwitchStatement: 'switch', SwitchCase: 'case', ExpressionStatement: 'expr', TemplateLiteral: 'template',
  ExportDefaultExpression: 'default', ArrowFunctionExpression: 'return',
};

function patternName(p) {
  if (p?.type === 'Identifier') return p.value;
  if (p?.type === 'AssignmentPattern') return patternName(p.left);
  return '<pattern>';
}

/** The enclosing declaration: named classes, functions, methods and module-level constants, outermost first. */
function scopeOf(stack) {
  const names = [];
  let inFunction = false;
  for (const { node, key } of stack) {
    switch (node.type) {
      case 'ClassDeclaration': case 'ClassExpression': case 'FunctionExpression':
        if (node.identifier) names.push(node.identifier.value);
        if (node.type === 'FunctionExpression') inFunction = true;
        break;
      case 'FunctionDeclaration': names.push(node.identifier.value); inFunction = true; break;
      case 'ArrowFunctionExpression': inFunction = true; break;
      case 'ClassMethod': case 'PrivateMethod': case 'Constructor': case 'MethodProperty':
      case 'GetterProperty': case 'SetterProperty':
        names.push(propKey(node.key)); inFunction = true; break;
      case 'ClassProperty': case 'PrivateProperty': case 'KeyValueProperty':
        if (key === 'value' && FUNCTIONS.has(unwrap(node.value)?.type)) names.push(propKey(node.key));
        break;
      case 'VariableDeclarator': {
        const init = unwrap(node.init)?.type;
        const named = !inFunction || FUNCTIONS.has(init) || init === 'ClassExpression';
        if (key === 'init' && node.id.type === 'Identifier' && named) names.push(node.id.value);
        break;
      }
      case 'TsEnumDeclaration': case 'TsModuleDeclaration': names.push(propKey(node.id)); break;
      case 'ExportDefaultExpression': names.push('default'); break;
      case 'ExportDefaultDeclaration': if (!node.decl?.identifier) names.push('default'); break;
      default: break;
    }
  }
  return names.filter((n, i) => n !== names[i - 1]).join('.') || '<module>';
}

/** The callee or property the value at `stack[from]`'s child feeds. */
function contextOf(stack, from) {
  let suffix = '';
  const path = [];
  for (let i = from; i >= 0; i -= 1) {
    const { node, key } = stack[i];
    const t = node.type;
    if (t === undefined || t === 'ObjectExpression') continue;
    if (t === 'KeyValueProperty' && key === 'value') {
      path.unshift(propKey(node.key));
      continue;
    }
    if (path.length > 0) return path.join('.') + suffix;
    if (TRANSPARENT.has(t)) continue;
    if (t === 'ArrayExpression') {
      suffix = '[]';
      continue;
    }
    if (t === 'CallExpression' || t === 'NewExpression') {
      if (key !== 'arguments') continue;
      return `${t === 'NewExpression' ? 'new ' : ''}${exprText(node.callee)}${suffix}`;
    }
    if (t === 'MemberExpression') {
      if (key === 'property') return `${exprText(node.object)}[]`;
      continue;
    }
    if (t === 'VariableDeclarator') return patternName(node.id) + suffix;
    if (t === 'AssignmentPattern') return patternName(node.left) + suffix;
    if (t === 'AssignmentExpression') return (node.left?.property ? propKey(node.left.property) : patternName(node.left)) + suffix;
    if (t === 'ClassProperty' || t === 'PrivateProperty' || t === 'AssignmentPatternProperty') return propKey(node.key) + suffix;
    if (t === 'TsEnumMember') return propKey(node.id);
    if (t === 'JSXAttribute') return propKey(node.name);
    if (t === 'KeyValueProperty') return 'key';
    return STATEMENTS[t] ?? t[0].toLowerCase() + t.slice(1);
  }
  return path.length > 0 ? path.join('.') + suffix : '<module>';
}

function lineOf(source) {
  const bytes = Buffer.from(source, 'utf8');
  const starts = [0];
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0x0a) starts.push(i + 1);
  return (spanStart) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= spanStart - 1) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Every finding in one file, in any syntactic position: `literal` (not 0, ±1, or a kernel/units
 * multiplier used as one), `prior` (a read of a claimed key), `random` (Math.random). Line-free key:
 * `file :: enclosing declaration :: callee or property :: text`.
 */
export function scanSource(file, source, ctx) {
  const ast = parse(file, source);
  const line = lineOf(source);
  const aliases = new Map();
  each(ast, (n) => {
    if (n.type === 'ImportSpecifier' && n.imported) aliases.set(n.local.value, propKey(n.imported));
  });
  const groupOf = (obj) => {
    const o = unwrap(obj);
    if (o?.type === 'Identifier') return aliases.get(o.value) ?? o.value;
    return o?.type === 'MemberExpression' ? propKey(o.property) : null;
  };
  const claimed = (group, key) => ctx.whole.has(group) || ctx.claims.has(`${group}.${key}`);
  const findings = [];
  const stack = [];
  const report = (node, kind, text, from, context = contextOf(stack, from)) => {
    const scope = scopeOf(stack);
    findings.push({ key: `${file} :: ${scope} :: ${context} :: ${text}`, file, scope, context, text, kind, line: line(node.span.start) });
  };
  const visit = (node) => {
    const top = stack.length - 1;
    if (node.type === 'NumericLiteral' || node.type === 'BigIntLiteral') {
      if (stack.some((f) => TYPE_KEYS.has(f.key) || TYPE_DECLS.has(f.node.type))) return;
      const parent = stack[top]?.node;
      const negative = parent?.type === 'UnaryExpression' && parent.operator === '-';
      const value = Number(node.type === 'BigIntLiteral' ? String(node.value).replace(/n$/, '') : node.value);
      if (value === 0 || value === 1) return;
      const op = parent?.type === 'ParenthesisExpression' ? stack[top - 1]?.node : parent;
      const multiplies = (op?.type === 'BinaryExpression' && (op.operator === '*' || op.operator === '/')) ||
        (op?.type === 'AssignmentExpression' && (op.operator === '*=' || op.operator === '/='));
      if (ctx.multipliers.has(value) && multiplies) return;
      report(node, 'literal', `${negative ? '-' : ''}${node.raw ?? node.value}`, top);
    } else if (node.type === 'MemberExpression') {
      const group = groupOf(node.object);
      const key = propKey(node.property);
      if (group === 'Math' && key === 'random') {
        const call = stack[top]?.node.type === 'CallExpression' && stack[top].key === 'callee';
        report(node, 'random', 'Math.random', call ? top - 1 : top);
      } else if (group !== null && claimed(group, key)) report(node, 'prior', `${group}.${key}`, top);
    } else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && node.init) {
      // Destructuring reads the property too: `const { random } = Math`, `const { X } = RIM`.
      const group = groupOf(node.init);
      for (const p of node.id.properties) {
        const key = p.key ? propKey(p.key) : null;
        if (group === 'Math' && key === 'random') report(node, 'random', 'Math.random', top, key);
        else if (group !== null && key !== null && claimed(group, key)) report(node, 'prior', `${group}.${key}`, top, key);
      }
    }
  };
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (node.type !== undefined) visit(node);
    for (const key of Object.keys(node)) {
      if (key === 'span' || node[key] === null || typeof node[key] !== 'object') continue;
      stack.push({ node, key });
      walk(node[key]);
      stack.pop();
    }
  };
  walk(ast);
  return findings;
}

/** Every finding in `files` (default: the whole scope), keyed and in file order. */
export function scan(files = scopeFiles(), ctx = scanContext()) {
  return files.flatMap((file) => scanSource(file, read(file), ctx));
}

/** `{key: count}` over findings, keys sorted. */
export function countKeys(findings) {
  const counts = new Map();
  for (const f of findings) counts.set(f.key, (counts.get(f.key) ?? 0) + 1);
  return new Map([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const ctx = scanContext();
  const findings = scan(files.length > 0 ? files : scopeFiles(), ctx);
  if (args.includes('--json')) {
    const out = { claims: [...ctx.claims], whole: [...ctx.whole], multipliers: [...ctx.multipliers], findings };
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } else {
    const kinds = Object.groupBy(findings, (f) => f.kind);
    for (const [kind, list] of Object.entries(kinds)) console.log(`${kind}: ${list.length}`);
    console.log(`static-timing: ${findings.length} findings, ${countKeys(findings).size} keys`);
  }
}
