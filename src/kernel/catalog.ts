/**
 * The kernel catalog behind Settings → Under the hood and Limits & reading (spec §6.5, Appendix B.4): every
 * entry of every catalogued kernel table, one row per value, with the guard line written above it (the
 * generated index), the registry's provenance tier, the fundamentals' src and rev, MOTION's roles and the
 * envelope. A row is structurally the shared `BasisRow`; kernel siblings only.
 */

import { ADAPTER_BOUNDS } from './adapter-bounds';
import { BOOT } from './boot-policy';
import { KERNEL_GUARDS, KERNEL_TABLES } from './catalog.generated';
import { CENSUS_POLICY } from './census-policy';
import {
  ACTIVITY, ADAPTER, CAUTION, CIRCADIAN, CLEANUP, CONNECTIVITY, ENGINE, NOISE, PATIENCE, PATTERN, POLL, PRUNE,
  RECOVERY, REST_DAY_PCT, RHYTHM, RIM, SCHEDULER, SESSION, TAB, UPDATER, VARIANCE_PCT,
} from './derive';
import { ENVELOPE } from './derive-envelope';
import { PROVENANCE } from './derive-provenance';
import { EXPLORATION_POLICY } from './exploration-policy';
import { EMPIRICAL } from './fundamentals';
import { INPUT_PROBE } from './input-probe';
import { DIAGNOSTICS, LIVE } from './live-policy';
import { MOTION } from './motion-policy';
import { MOTION_ADDED, MOTION_ROLE, MOTION_SHAPE_DIALS } from './motion-roles';
import { OVERRIDES, type Override } from './overrides';
import { PLAN_BOUNDS } from './plan/policy';
import { BOUNDS, PACING_BASE_MS, POLICY, PREFERENCES, SCALES } from './policy';
import { BOUNDS_REENTRY } from './reentry-policy';
import { RENDERER_HEALTH } from './renderer-health-policy';
import { RUNTIME_BOUNDS } from './runtime-bounds';
import { RUNTIME_POLICY } from './runtime-policy';
import { SCRUB_POLICY } from './scrub-policy';
import { SETTINGS_GUARDS, SETTINGS_POLICY } from './settings-policy';
import { SHELL_GEOMETRY } from './shell-geometry';
import { STORE_POLICY } from './store-policy';
import { HTTP_STATUS, SURFACE_BOUNDS } from './surface-policy';
import { PLAN_POLICY, TEMPO_BOUNDS, TEMPO_POLICY } from './tempo-policy';

type CatalogGroup = 'fundamental' | 'policy' | 'bound' | 'derived' | 'registry' | 'motion';

/** One catalogued value. */
export interface CatalogRow {
  readonly id: string;
  readonly group: CatalogGroup;
  readonly value: number | string;
  readonly unit: string | null;
  /** The registry's provenance tier, a derived value's `derived` or `override`, a MOTION key's role. */
  readonly tier: string | null;
  /** A fundamental's source, an override's reason, a MOTION key's provenance. */
  readonly src: string | null;
  readonly rev: string | null;
  readonly module: string;
  readonly guard: string | null;
}

type TableName = (typeof KERNEL_TABLES)[keyof typeof KERNEL_TABLES][number];

/** How each generated table shows: rows under its group, or `null` for the notes MOTION's rows carry. */
const TABLES = {
  ADAPTER_BOUNDS: [ADAPTER_BOUNDS, 'bound'],
  BOOT: [BOOT, 'bound'],
  CENSUS_POLICY: [CENSUS_POLICY, 'bound'],
  ENGINE: [ENGINE, 'registry'], PRUNE: [PRUNE, 'registry'], CONNECTIVITY: [CONNECTIVITY, 'registry'],
  SCHEDULER: [SCHEDULER, 'registry'], ADAPTER: [ADAPTER, 'registry'], TAB: [TAB, 'registry'],
  RECOVERY: [RECOVERY, 'registry'], RIM: [RIM, 'registry'], NOISE: [NOISE, 'registry'], POLL: [POLL, 'registry'],
  CIRCADIAN: [CIRCADIAN, 'registry'], SESSION: [SESSION, 'registry'], PATTERN: [PATTERN, 'registry'],
  UPDATER: [UPDATER, 'registry'],
  ACTIVITY: [ACTIVITY, 'derived'], VARIANCE_PCT: [VARIANCE_PCT, 'derived'], REST_DAY_PCT: [REST_DAY_PCT, 'derived'],
  RHYTHM: [RHYTHM, 'derived'], CAUTION: [CAUTION, 'derived'], CLEANUP: [CLEANUP, 'derived'],
  PATIENCE: [PATIENCE, 'derived'],
  EXPLORATION_POLICY: [EXPLORATION_POLICY, 'policy'],
  EMPIRICAL: [EMPIRICAL, 'fundamental'],
  INPUT_PROBE: [INPUT_PROBE, 'derived'],
  LIVE: [LIVE, 'bound'], DIAGNOSTICS: [DIAGNOSTICS, 'bound'],
  MOTION: [MOTION, 'motion'],
  MOTION_ROLE: null, MOTION_SHAPE_DIALS: null, MOTION_ADDED: null,
  PLAN_BOUNDS: [PLAN_BOUNDS, 'bound'],
  POLICY: [POLICY, 'policy'], SCALES: [SCALES, 'policy'], BOUNDS: [BOUNDS, 'bound'],
  PACING_BASE_MS: [PACING_BASE_MS, 'policy'], PREFERENCES: [PREFERENCES, 'policy'],
  BOUNDS_REENTRY: [BOUNDS_REENTRY, 'bound'],
  RENDERER_HEALTH: [RENDERER_HEALTH, 'bound'],
  RUNTIME_BOUNDS: [RUNTIME_BOUNDS, 'bound'], RUNTIME_POLICY: [RUNTIME_POLICY, 'bound'],
  SCRUB_POLICY: [SCRUB_POLICY, 'bound'],
  SETTINGS_POLICY: [SETTINGS_POLICY, 'policy'], SETTINGS_GUARDS: [SETTINGS_GUARDS, 'bound'],
  SHELL_GEOMETRY: [SHELL_GEOMETRY, 'bound'],
  STORE_POLICY: [STORE_POLICY, 'bound'],
  SURFACE_BOUNDS: [SURFACE_BOUNDS, 'bound'], HTTP_STATUS: [HTTP_STATUS, 'bound'],
  TEMPO_POLICY: [TEMPO_POLICY, 'policy'], PLAN_POLICY: [PLAN_POLICY, 'policy'], TEMPO_BOUNDS: [TEMPO_BOUNDS, 'bound'],
} satisfies { readonly [K in TableName]: readonly [object, CatalogGroup] | null };

const ROLES: Readonly<Partial<Record<string, string>>> = MOTION_ROLE;
const DIALS: Readonly<Partial<Record<string, { readonly guard: string; readonly provenance: string }>>> = MOTION_SHAPE_DIALS;
const ADDED: Readonly<Partial<Record<string, { readonly from: string }>>> = MOTION_ADDED;

/** Paths whose unit no name along them carries. */
const UNIT_AT: Readonly<Partial<Record<string, string>>> = {
  'EMPIRICAL.LATENCY': 'ms', 'SETTINGS_POLICY.BOOST.CHOICES': 'h', 'ENVELOPE.gapTypical': 's',
  'ENVELOPE.gapFloor': 's', 'ENVELOPE.dayVariation': '%', 'ENVELOPE.restDayChance': '%',
};

/** Unit suffixes of a path segment, the rate suffixes before the plain ones they end with. */
const UNIT_SUFFIX: readonly (readonly [RegExp, string])[] = [
  [/PxPerSecond$/, 'px/s'], [/(_PER_HOUR|PerHour)$/, '/h'], [/(_PER_DAY|PerDay)$/, '/day'], [/(_MS|Ms)$/, 'ms'],
  [/(_PX|Px)$/, 'px'], [/(_SECONDS|Seconds)$/, 's'], [/(_MINUTES|Minutes)$/, 'min'], [/(_HOURS|Hours|Hour|_H)$/, 'h'],
  [/(_DAYS|Days)$/, 'days'], [/(_BYTES|Bytes)$/, 'bytes'], [/(_CHARS|Chars)$/, 'chars'], [/(_PCT|Pct)$/, '%'],
  [/Fps$/, 'fps'],
];

/** A path and its ancestors up to the table's name, nearest first. */
function* pathUp(id: string): Generator<string> {
  for (let at = id; ; at = at.slice(0, at.lastIndexOf('.'))) {
    yield at;
    if (!at.includes('.')) return;
  }
}

function unitOf(id: string): string | null {
  for (const at of pathUp(id)) {
    const segment = at.slice(at.lastIndexOf('.') + 1);
    const unit = UNIT_AT[at] ?? UNIT_SUFFIX.find(([suffix]) => suffix.test(segment))?.[1];
    if (unit !== undefined) return unit;
  }
  return null;
}

/** The guard line of the entry or of the nearest entry holding it; a table's own comment is not one. */
function guardOf(id: string): string | null {
  for (const at of pathUp(id)) {
    const guard = at.includes('.') ? KERNEL_GUARDS[at] : undefined;
    if (guard !== undefined) return guard;
  }
  return null;
}

const OVERRIDE_KEYS = Object.keys(OVERRIDES);

/** The override pinning this value, or one element of it. */
function overrideOf(id: string): Override | null {
  const key = OVERRIDE_KEYS.find((k) => k === id || k.startsWith(`${id}.`));
  return key === undefined ? null : OVERRIDES[key];
}

interface Leaf { readonly id: string; readonly value: number | string; readonly src: string | null; readonly rev: string | null }

const shown = (v: unknown): number | string =>
  typeof v === 'number' ? (Number.isFinite(v) ? v : v > 0 ? '∞' : '-∞') : String(v);

/** Every value under `node`: a number, string or flag is one leaf, and so is a list of them. */
function leaves(node: unknown, id: string, from: Pick<Leaf, 'src' | 'rev'>, out: Leaf[]): Leaf[] {
  if (Array.isArray(node) && node.every((v) => v === null || typeof v !== 'object')) {
    out.push({ id, value: `[${node.map(shown).join(', ')}]`, ...from });
  } else if (node !== null && typeof node === 'object') {
    const rec = node as Readonly<Record<string, unknown>>;
    const own = typeof rec.src === 'string' && typeof rec.rev === 'string';
    const next = own ? { src: String(rec.src), rev: String(rec.rev) } : from;
    for (const [k, v] of Object.entries(rec)) if (!own || (k !== 'src' && k !== 'rev')) leaves(v, `${id}.${k}`, next, out);
  } else {
    out.push({ id, value: shown(node), ...from });
  }
  return out;
}

function rowOf(leaf: Leaf, group: CatalogGroup, module: string): CatalogRow {
  const { id, value } = leaf;
  const row = { id, group, value, unit: unitOf(id), tier: null, src: null, rev: null, module, guard: guardOf(id) };
  const pinned = overrideOf(id);
  switch (group) {
    case 'fundamental':
      return { ...row, src: leaf.src, rev: leaf.rev };
    case 'registry':
      return { ...row, tier: PROVENANCE[id.split('.').slice(0, 2).join('.')] ?? null, src: pinned?.reason ?? null };
    case 'derived':
      return { ...row, tier: pinned === null ? 'derived' : 'override', src: pinned?.reason ?? null };
    case 'motion': {
      const key = id.slice(id.indexOf('.') + 1);
      const dial = DIALS[key];
      return { ...row, tier: ROLES[key] ?? null, src: dial?.provenance ?? ADDED[key]?.from ?? null, guard: dial?.guard ?? row.guard };
    }
    default:
      return row;
  }
}

function build(): CatalogRow[] {
  const none = { src: null, rev: null };
  const rows: CatalogRow[] = [];
  for (const [module, names] of Object.entries(KERNEL_TABLES)) {
    for (const name of names) {
      const entry = TABLES[name];
      if (entry === null) continue;
      for (const leaf of leaves(entry[0], name, none, [])) rows.push(rowOf(leaf, entry[1], `src/kernel/${module}.ts`));
    }
  }
  for (const leaf of leaves(ENVELOPE, 'ENVELOPE', none, [])) rows.push(rowOf(leaf, 'derived', 'src/kernel/derive-envelope.ts'));
  return rows;
}

let memo: readonly CatalogRow[] | null = null;

/** The catalog, built on first use: the kernel's tables never change while the app runs. */
export function kernelCatalog(): readonly CatalogRow[] {
  memo ??= Object.freeze(build());
  return memo;
}
