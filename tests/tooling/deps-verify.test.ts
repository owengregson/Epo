/**
 * Version truth is a test (ADR 1001).
 *
 * "Up to date" is not the property that matters — *agreeing with the runtime we
 * ship* is. `@types/node` types the main process, and the main process is
 * Electron's Node; the esbuild targets describe the engines the bundles run in,
 * and those are Electron's too. Both can be "latest" and both can be wrong, and
 * neither `npm outdated` nor Dependabot can see it.
 *
 * Everything here reads INSTALLED versions from `node_modules/<pkg>/package.json`
 * — never the ranges in `package.json`, which are wishes, not facts.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** The version actually installed, or null when the package is absent. */
function installed(pkg: string): string | null {
  const manifest = path.join(ROOT, 'node_modules', pkg, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  return (JSON.parse(fs.readFileSync(manifest, 'utf8')).version as string) ?? null;
}

const major = (version: string): number => Number(version.split('.')[0]);

/** `-1 | 0 | 1`, comparing dotted numeric versions field by field. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

interface Targets {
  node: string;
  chrome: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
}

const TARGETS_PATH = path.join(ROOT, 'build', 'targets.generated.json');

function readTargets(): Targets {
  return JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')) as Targets;
}

/**
 * `process.versions` straight from the installed Electron binary, or null when
 * it was never downloaded (`npm ci --ignore-scripts`).
 */
function probeElectron(): Record<string, string> | null {
  const pathTxt = path.join(ROOT, 'node_modules', 'electron', 'path.txt');
  if (!fs.existsSync(pathTxt)) return null;
  const binary = path.join(
    ROOT,
    'node_modules',
    'electron',
    'dist',
    fs.readFileSync(pathTxt, 'utf8').trim(),
  );
  if (!fs.existsSync(binary)) return null;
  const result = spawnSync(binary, ['-p', 'JSON.stringify(process.versions)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  for (const line of result.stdout.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed && typeof parsed.node === 'string') return parsed;
    } catch {
      // Not the value line — keep walking back.
    }
  }
  return null;
}

describe('type packages agree with the runtimes they type', () => {
  test('@types/node major === the Node major Electron bundles', () => {
    const types = installed('@types/node');
    expect(types).not.toBeNull();
    // The recorded truth; `npm run gen:targets:check` proves it is current.
    expect(major(types as string)).toBe(major(readTargets().nodeVersion));
  });

  /**
   * The store runs on the runtime's built-in `node:sqlite` (ADR 0702). No native
   * SQLite package — and no hand-written types for one — may creep back in:
   * the last time they were "up to date", the types were four majors behind
   * the runtime and nothing could tell.
   */
  test('no native sqlite package is installed', () => {
    expect(installed('better-sqlite3')).toBeNull();
    expect(installed('@types/better-sqlite3')).toBeNull();
  });

  /**
   * `@electron/rebuild` still arrives transitively through electron-builder;
   * what must not return is a DIRECT dependency on it (the old
   * `rebuild:electron` / `rebuild:node` scripts), because `npmRebuild: false`
   * in electron-builder.yml is the only thing that keeps a native rebuild
   * out of the packaging path.
   */
  test('@electron/rebuild is not a direct dependency', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['@electron/rebuild']).toBeUndefined();
    expect(manifest.devDependencies?.['@electron/rebuild']).toBeUndefined();
  });
});

describe('esbuild targets are the installed Electron', () => {
  test('build/targets.generated.json exists and is well formed', () => {
    const targets = readTargets();
    expect(targets.node).toMatch(/^node\d+$/);
    expect(targets.chrome).toMatch(/^chrome\d+$/);
    expect(targets.node).toBe(`node${major(targets.nodeVersion)}`);
    expect(targets.chrome).toBe(`chrome${major(targets.chromeVersion)}`);
  });

  test('the recorded versions match the Electron that is installed', () => {
    const targets = readTargets();
    const versions = probeElectron();
    if (versions) {
      expect(targets.electronVersion).toBe(versions.electron);
      expect(targets.nodeVersion).toBe(versions.node);
      expect(targets.chromeVersion).toBe(versions.chrome);
    } else {
      // No binary (CI installs with --ignore-scripts). The package version is
      // still a fact, and it is the one a dependency bump moves.
      expect(targets.electronVersion).toBe(installed('electron'));
    }
  });

  test('.node-version is the major Electron bundles', () => {
    const pinned = fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim();
    expect(pinned).toBe(String(major(readTargets().nodeVersion)));
  });
});

describe('packaging and supply chain', () => {
  test('electron-builder is at least 26.16.0 (its `latest` tag is behind `v26`)', () => {
    const version = installed('electron-builder');
    expect(version).not.toBeNull();
    expect(compareVersions(version as string, '26.16.0')).toBeGreaterThanOrEqual(0);
  });

  test('every lockfile entry resolves to the npm registry', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { resolved?: string }>;
    };
    const foreign = Object.entries(lock.packages)
      .filter(([, entry]) => entry.resolved !== undefined)
      .filter(([, entry]) => !(entry.resolved as string).startsWith('https://registry.npmjs.org/'))
      .map(([name, entry]) => `${name} → ${entry.resolved}`);
    expect(foreign).toEqual([]);
  });
});
