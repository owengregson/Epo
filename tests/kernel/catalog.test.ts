/**
 * The Under-the-hood catalog (spec §6.5, §20.2): the committed index matches the kernel's source text, every
 * module whose header names it tier 1 is catalogued, and every exported entry of every catalogued table shows
 * as a row with its guard line, tier and provenance.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { type CatalogRow, kernelCatalog } from '@/kernel/catalog';
import { KERNEL_GUARDS, KERNEL_TABLES } from '@/kernel/catalog.generated';
import { ENVELOPE } from '@/kernel/derive-envelope';
import { PROVENANCE } from '@/kernel/derive-provenance';
import { empiricalProvenance } from '@/kernel/fundamentals';
import { MOTION_ADDED, MOTION_ROLE, MOTION_SHAPE_DIALS } from '@/kernel/motion-roles';
import { OVERRIDES } from '@/kernel/overrides';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';

const REPO = path.join(__dirname, '..', '..');
const KERNEL = path.join(REPO, 'src', 'kernel');
const rows = kernelCatalog();
const byId = new Map(rows.map((r) => [r.id, r]));
const under = (id: string): CatalogRow[] => rows.filter((r) => r.id === id || r.id.startsWith(`${id}.`));

/** Tables whose entries annotate MOTION's rows instead of listing rows of their own. */
const MOTION_NOTES = new Set(['MOTION_ROLE', 'MOTION_SHAPE_DIALS', 'MOTION_ADDED']);
/** Runtime exports a module re-exports rather than declares, each with where its content shows. */
const RE_EXPORTS: Readonly<Record<string, string>> = { PROVENANCE: 'every registry row carries it as its tier' };
/** The registry group the dev harness reads lives outside the kernel (`src/timing/config.ts`). */
const kernelRegistryKeys = Object.keys(PROVENANCE).filter((k) => !k.startsWith('HARNESS.'));

function kernelModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return kernelModules(full);
    if (!e.name.endsWith('.ts') || e.name.endsWith('.generated.ts')) return [];
    return [path.relative(KERNEL, full).split(path.sep).join('/').replace(/\.ts$/, '')];
  });
}

const header = (module: string): string =>
  /\/\*\*[\s\S]*?\*\//.exec(readFileSync(path.join(KERNEL, `${module}.ts`), 'utf8'))?.[0] ?? '';

test('the committed index matches the kernel source', () => {
  // `--check` re-reads the sources and exits non-zero when the index differs. Run the script without it to refresh.
  expect(() => execFileSync('node', ['scripts/gen-kernel-catalog.mjs', '--check'], { cwd: REPO, stdio: 'pipe' }))
    .not.toThrow();
}, 60_000);

test('every module whose header names it tier 1 is catalogued', () => {
  const tierOne = kernelModules(KERNEL).filter((m) => /\bTier 1\b/.test(header(m)));
  expect(tierOne.length).toBeGreaterThanOrEqual(17);
  for (const m of tierOne) expect({ m, catalogued: m in KERNEL_TABLES }).toEqual({ m, catalogued: true });
});

test('every exported table and entry of a catalogued module shows as a row', () => {
  for (const [module, tables] of Object.entries(KERNEL_TABLES)) {
    const live = jest.requireActual<Record<string, unknown>>(`@/kernel/${module}`);
    const listed: readonly string[] = tables;
    for (const [name, value] of Object.entries(live)) {
      if (typeof value === 'function' || name in RE_EXPORTS) continue;
      if (typeof value === 'number') {
        const alias = rows.find((r) => r.module === `src/kernel/${module}.ts` && r.id.endsWith(`.${name}`));
        expect({ name, value: alias?.value }).toEqual({ name, value });
        continue;
      }
      expect({ module, name, listed: listed.includes(name) }).toEqual({ module, name, listed: true });
      if (MOTION_NOTES.has(name)) continue;
      for (const key of Object.keys(value as object)) {
        expect({ entry: `${name}.${key}`, shown: under(`${name}.${key}`).length > 0 }).toEqual({ entry: `${name}.${key}`, shown: true });
      }
    }
  }
});

test('row ids are unique, values are numbers or strings, and every module path exists', () => {
  expect(byId.size).toBe(rows.length);
  for (const r of rows) {
    expect(['number', 'string']).toContain(typeof r.value);
    expect(existsSync(path.join(REPO, r.module))).toBe(true);
  }
});

test('values: a primitive array is one row, an unbounded guard reads ∞, a flag reads true or false', () => {
  expect(byId.get('SETTINGS_POLICY.BOOST.CHOICES')?.value).toBe(`[${SETTINGS_POLICY.BOOST.CHOICES.join(', ')}]`);
  expect(byId.get('SETTINGS_GUARDS.dailyVolume.max')?.value).toBe('∞');
  expect(byId.get('SETTINGS_GUARDS.dailyVolume.min')?.value).toBe(1);
  expect(byId.get('PREFERENCES.cleanup.off.weave')?.value).toBe('false');
  expect(byId.get('POLICY.LADDER_COVERS')?.value).toBe('p50');
  expect(byId.get('PREFERENCES.dayShape.morning.0.centerHour')?.value).toBe(8);
});

test('units follow the names, and the envelope reads in its own units', () => {
  const unit = (id: string): string | null | undefined => byId.get(id)?.unit;
  expect(unit('BOOT.SHOW_FALLBACK_MS')).toBe('ms');
  expect(unit('SHELL_GEOMETRY.SIDEBAR_WIDTH_PX')).toBe('px');
  expect(unit('EMPIRICAL.LATENCY.nav.p50')).toBe('ms');
  expect(unit('EMPIRICAL.SOFT_WALL_DURATION_H.p50')).toBe('h');
  expect(unit('EMPIRICAL.FOLLOW_WALL_PER_DAY.low')).toBe('/day');
  expect(unit('SETTINGS_POLICY.BOOST.MAX_HOURS')).toBe('h');
  expect(unit('SETTINGS_GUARDS.waitDays.max')).toBe('days');
  expect(unit('SETTINGS_POLICY.QUIET_GRID_MINUTES')).toBe('min');
  expect(unit('ENVELOPE.gapTypical.min')).toBe('s');
  expect(unit('ENVELOPE.dayVariation.max')).toBe('%');
  expect(unit('POLICY.SAFETY_MARGIN')).toBeNull();
});

/** Modules with a guard line on every top-level entry (their own structural tests hold them to it). */
const GUARDED_THROUGHOUT = ['adapter-bounds', 'boot-policy', 'census-policy', 'exploration-policy', 'input-probe',
  'live-policy', 'plan/policy', 'reentry-policy', 'renderer-health-policy', 'runtime-bounds', 'scrub-policy',
  'settings-policy', 'shell-geometry', 'surface-policy', 'tempo-policy'] as const;

test('the index finds the guard line of every entry in the modules that write one throughout', () => {
  for (const module of GUARDED_THROUGHOUT) {
    const live = jest.requireActual<Record<string, unknown>>(`@/kernel/${module}`);
    for (const table of KERNEL_TABLES[module]) {
      for (const key of Object.keys(live[table] as object)) {
        expect({ entry: `${table}.${key}`, guarded: KERNEL_GUARDS[`${table}.${key}`] !== undefined })
          .toEqual({ entry: `${table}.${key}`, guarded: true });
      }
    }
  }
});

test('guard lines reach their rows; the settings tables are guarded throughout', () => {
  for (const id of Object.keys(KERNEL_GUARDS)) {
    if (MOTION_NOTES.has(id.split('.')[0])) continue;
    expect({ id, shown: under(id).length > 0 }).toEqual({ id, shown: true });
  }
  const settings = rows.filter((r) => /^SETTINGS_(POLICY|GUARDS)\./.test(r.id));
  for (const r of settings) expect({ id: r.id, guarded: r.guard !== null }).toEqual({ id: r.id, guarded: true });
  expect(byId.get('SETTINGS_POLICY.AUDIENCE_SIZE.small.max')?.guard).toBe(KERNEL_GUARDS['SETTINGS_POLICY.AUDIENCE_SIZE']);
  expect(byId.get('BOUNDS.ENGINE.IDLE_MS')?.guard).toBe(KERNEL_GUARDS['BOUNDS.ENGINE.IDLE_MS']);
});

test('the fundamentals carry the src and rev of their entry', () => {
  for (const { path: p, src, rev } of empiricalProvenance()) {
    const found = under(`EMPIRICAL.${p}`);
    expect({ p, shown: found.length > 0 }).toEqual({ p, shown: true });
    for (const r of found) expect(r).toMatchObject({ group: 'fundamental', src, rev });
  }
  expect(rows.some((r) => /^EMPIRICAL\..*\.(src|rev)$/.test(r.id))).toBe(false);
});

test('the registry rows carry the provenance tier, and an override its reason', () => {
  for (const key of kernelRegistryKeys) {
    const found = under(key);
    expect({ key, shown: found.length > 0 }).toEqual({ key, shown: true });
    for (const r of found) expect(r).toMatchObject({ group: 'registry', tier: PROVENANCE[key] });
  }
  const registry = rows.filter((r) => r.group === 'registry');
  expect(registry.every((r) => kernelRegistryKeys.some((k) => r.id === k || r.id.startsWith(`${k}.`)))).toBe(true);
  expect(byId.get('RIM.ACCEPT_PACE_MIN_MS')?.src).toBe(OVERRIDES['RIM.ACCEPT_PACE_MIN_MS'].reason);
  expect(byId.get('RECOVERY.HOLD_MEDIANS_MS')?.src).toBe(OVERRIDES['RECOVERY.HOLD_MEDIANS_MS.2'].reason);
  expect(byId.get('CAUTION.bold.floorSeconds')).toMatchObject({ group: 'derived', tier: 'override' });
  expect(byId.get('CAUTION.cautious.floorSeconds')).toMatchObject({ group: 'derived', tier: 'derived', src: null });
  expect(byId.get('CAUTION.standard.floorSeconds')).toMatchObject({ group: 'derived', tier: 'derived', src: null });
});

test('MOTION rows carry their role, a shape dial its guard line, and every row its provenance', () => {
  const dials: Readonly<Record<string, { readonly guard: string; readonly provenance: string }>> = MOTION_SHAPE_DIALS;
  for (const [key, role] of Object.entries(MOTION_ROLE)) {
    expect(byId.get(`MOTION.${key}`)).toMatchObject({ group: 'motion', tier: role });
  }
  for (const [key, dial] of Object.entries(dials)) {
    expect(byId.get(`MOTION.${key}`)).toMatchObject({ guard: dial.guard, src: dial.provenance });
  }
  for (const [key, added] of Object.entries(MOTION_ADDED)) {
    expect(byId.get(`MOTION.${key}`)?.src).toBe(dials[key]?.provenance ?? added.from);
  }
});

test('the envelope shows beside the tables it bounds', () => {
  for (const [key, { min, max }] of Object.entries(ENVELOPE)) {
    expect(byId.get(`ENVELOPE.${key}.min`)).toMatchObject({ group: 'derived', value: min, module: 'src/kernel/derive-envelope.ts' });
    expect(byId.get(`ENVELOPE.${key}.max`)?.value).toBe(max);
  }
});
