/**
 * Settings v2 test helpers: a plan-math fake standing in for the plan core's kernel (the closed forms of
 * spec §5.4 and §5.10, good to a percent), documents from patterns, and resolution in one call.
 */
import { BOUNDS, POLICY } from '@/kernel';
import type { OrdinalPattern } from '@/kernel/derive';
import type { PlanMath } from '@/settings/basis';
import { DEFAULT_DOC, type OverrideEntry, RECOMMENDED_INTENT, type SettingsDocV2 } from '@/settings/doc';
import { type EffectiveSettings, effectiveFrom } from '@/settings/effective';
import type { SettingsFs } from '@/settings/persist';
import { type ResolvedParams, resolveParams } from '@/settings/resolve';
import type { Intent } from '@/shared/settings-intent';
import type { ParamValue } from '@/shared/settings-model';
import type { ParamKey } from '@/shared/settings-params';

/** The reference gap mean over its median at balanced (103.9 s over 95 s, spec §5.10). */
const MEAN_OVER_MEDIAN = 103.9 / 95;

export const FAKE_PLAN_MATH: PlanMath = {
  gapTypicalSeconds: (cap) => (3600 * POLICY.CEILING_HEADROOM) / cap / BOUNDS.NOISE.BEAT_MIN_FACTOR,
  gapMinimumSeconds: (g) => g.floorSeconds * Math.max(1, g.typicalSeconds / (g.medianSeconds * MEAN_OVER_MEDIAN)),
  automaticDayMax: (p0) => (p0 < 10 ? p0 : Math.min(p0 - 1, Math.ceil(0.97 * p0 - 0.5))),
  dayLaw: ({ operatingRate: p0 }) => ({ low: Math.round(0.58 * p0), typical: Math.round(0.88 * p0), high: Math.round(0.94 * p0) }),
  retryLimit: () => 3,
};

/** The intent a kernel pattern names (cleanup `deep` reads as `steady`). */
export function intentOf(p: OrdinalPattern, over: Partial<Intent> = {}): Intent {
  return {
    ...RECOMMENDED_INTENT, activity: p.activityLevel, caution: p.caution, rhythm: p.rhythm, consistency: p.consistency,
    dayShape: p.dayShape, weeklyShape: p.weeklyShape, patience: p.patience,
    cleanup: p.cleanup === 'deep' ? 'steady' : p.cleanup, ...over,
  };
}

/** Overrides from plain values, set at `setAt` against `basis` (default: the value itself). */
export function overridesOf(
  values: Partial<Record<ParamKey, ParamValue>>, setAt = 1, basis?: ParamValue,
): Partial<Record<ParamKey, OverrideEntry>> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, setAt, basis: basis ?? v }]));
}

export function docOf(over: Partial<SettingsDocV2> = {}): SettingsDocV2 {
  return { ...DEFAULT_DOC, ...over };
}

export function resolveDoc(doc: SettingsDocV2, plan = false, math: PlanMath = FAKE_PLAN_MATH): ResolvedParams {
  return resolveParams({ intent: doc.intent, overrides: doc.overrides, plan, math });
}

export function effectiveOf(doc: SettingsDocV2, plan = false): EffectiveSettings {
  return effectiveFrom(doc, resolveDoc(doc, plan));
}

/** An in-memory settings fs recording every call; `failOn` makes one operation (on one file) throw. */
export function memoryFs(files: Record<string, string> = {}, mtime = 1) {
  const data = new Map(Object.entries(files));
  const calls: string[] = [];
  let fail: { op: string; file?: string } | null = null;
  const base = (p: string): string => p.split('/').pop() ?? p;
  const guard = (op: string, p: string): void => {
    calls.push(`${op} ${base(p)}`);
    if (fail !== null && fail.op === op && (fail.file === undefined || fail.file === base(p))) throw new Error(`${op} failed`);
  };
  const fs: SettingsFs = {
    exists: (p) => data.has(base(p)),
    readFile: (p) => {
      guard('read', p);
      const v = data.get(base(p));
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFileSynced: (p, d) => {
      guard('write', p);
      data.set(base(p), d);
    },
    copyFile: (a, b) => {
      guard('copy', a);
      data.set(base(b), data.get(base(a)) ?? '');
    },
    rename: (a, b) => {
      guard('rename', a);
      data.set(base(b), data.get(base(a)) ?? '');
      data.delete(base(a));
    },
    fsyncDir: (d) => guard('fsync-dir', d),
    mtimeMs: () => mtime,
    list: () => [...data.keys()],
  };
  return { fs, data, calls, failOn: (op: string, file?: string) => { fail = { op, file }; } };
}
