/**
 * Modules deliberately unwired for now (spec §20.4). Each entry names the stream
 * that wires it; that stream removes the entry in the same commit, and the list is
 * empty at Phase I. `.dependency-cruiser.mjs` reads the same file as `no-orphans`
 * exceptions, so a listed module never raises a boundaries warning.
 *
 * An entry must name an existing module that NOTHING under `src/` imports yet: a
 * wired module left on the list fails here, so the list cannot rot.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

interface PendingEntry {
  readonly module: string;
  readonly stream: string;
  readonly reason: string;
}

const { pending } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'pending-wiring.json'), 'utf8'),
) as { pending: PendingEntry[] };

/** Every authored module under `src/`, repo-relative and POSIX. */
function sourceFiles(dir = path.join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/[.]tsx?$/.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

/** The module an import specifier names, as a repo-relative path without extension. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith('@/')) return `src/${spec.slice(2)}`;
  if (spec.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return null;
}

const stripExt = (file: string): string => file.replace(/[.]tsx?$/, '');

/** Every module some `src/` file imports or re-exports from (static or dynamic). */
function importedModules(): Set<string> {
  const imported = new Set<string>();
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of text.matchAll(specifier)) {
      const target = resolveSpecifier(file, match[1]);
      if (target === null) continue;
      imported.add(target);
      imported.add(`${target}/index`);
    }
  }
  return imported;
}

test('every entry names a stream and a reason, once', () => {
  const modules = pending.map((e) => e.module);
  expect(new Set(modules).size).toBe(modules.length);
  for (const e of pending) {
    expect(e.stream.length).toBeGreaterThan(0);
    expect(e.reason.length).toBeGreaterThanOrEqual(20);
  }
});

test('every listed module exists and is still unwired', () => {
  const imported = importedModules();
  for (const e of pending) {
    expect({ module: e.module, exists: fs.existsSync(path.join(ROOT, e.module)) }).toEqual({
      module: e.module,
      exists: true,
    });
    expect({ module: e.module, imported: imported.has(stripExt(e.module)) }).toEqual({
      module: e.module,
      imported: false,
    });
  }
});

test('the import scan sees a known importer (the check is live)', () => {
  expect(importedModules().has('src/store/knowledge-store')).toBe(true);
});
