/**
 * The shape of one parameter spec (spec §6.5, Appendix B.4) and the value helpers every catalog file and
 * the resolver share: shape checks, clamping inside bounds, equality on the key's step.
 */
import type { Interval } from '@/kernel/derive-envelope';
import { SETTINGS_GUARDS } from '@/kernel/settings-policy';
import type { Intent } from '@/shared/settings-intent';
import type { ParamValue, RatioCurve } from '@/shared/settings-model';
import type { ApplyWhen, ParamKey, ParamKind, ParamRisk, ParamUnit, SectionId } from '@/shared/settings-params';
import type { PlanMath } from './basis';

/** What a derivation sees: the intent, the effective upstreams, the plan capability and the plan math. */
export interface DeriveCtx {
  readonly intent: Intent;
  readonly upstream: Readonly<Partial<Record<ParamKey, ParamValue>>>;
  readonly plan: boolean;
  readonly math: PlanMath;
}

export interface ParamSpec {
  readonly section: SectionId;
  readonly kind: ParamKind;
  readonly unit: ParamUnit;
  readonly step: number;
  readonly risk: ParamRisk;
  readonly applies: ApplyWhen;
  /** The capability that shows the row (null: always). */
  readonly needs: 'plan' | 'tempo' | null;
  /** The effective keys `derive` and `bounds` read. */
  readonly deps: readonly ParamKey[];
  derive(c: DeriveCtx): ParamValue;
  /** The allowed interval of a number (each component of a range or curve). */
  bounds(c: DeriveCtx, recommended: ParamValue): Interval;
  inactive?(i: Intent): 'mutuals-kept' | 'cleanup-off' | null;
}

/** The effective number of an upstream key (every upstream the catalog reads is a number). */
export const num = (c: DeriveCtx, key: ParamKey): number => {
  const v = c.upstream[key];
  if (typeof v !== 'number') throw new Error(`settings: ${key} resolves after the keys that read it`);
  return v;
};

const CURVE_KEYS = ['hardLow', 'bandLow', 'peakLow', 'peakHigh', 'bandHigh', 'hardHigh'] as const;

/** Whether a value has the shape the key's kind expects. */
export function fitsKind(kind: ParamKind, v: ParamValue): boolean {
  switch (kind) {
    case 'int': case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'bool': return typeof v === 'boolean';
    case 'range': return typeof v === 'object' && 'min' in v && 'max' in v;
    case 'curve': return typeof v === 'object' && CURVE_KEYS.every((k) => k in v);
  }
}

const clampNum = (v: number, b: Interval): number => Math.max(b.min, Math.min(b.max, v));
const onStep = (v: number, step: number): number => Math.round(v / step) * step;

/**
 * Bring a value of the right shape inside its bounds: numbers clamp (a lower bound above the upper one wins:
 * the safe side of a slower-only row), whole kinds snap to their step, ranges and curves stay ordered.
 */
export function clampValue(spec: ParamSpec, v: ParamValue, b: Interval): ParamValue {
  if (typeof v === 'number') return clampNum(spec.kind === 'int' ? onStep(v, spec.step) : v, b);
  if (typeof v === 'boolean') return v;
  if (spec.kind === 'range' && 'min' in v) {
    const { followerMin, followerMax } = SETTINGS_GUARDS;
    const min = clampNum(Math.round(v.min), { min: Math.max(b.min, followerMin.min), max: followerMin.max });
    const max = clampNum(Math.round(v.max), { min: Math.max(min, followerMax.min), max: Math.min(b.max, followerMax.max) });
    return { min: Math.min(min, max), max };
  }
  const c = v as RatioCurve;
  const sorted = CURVE_KEYS.map((k) => clampNum(c[k], b)).sort((x, y) => x - y);
  return Object.fromEntries(CURVE_KEYS.map((k, i) => [k, sorted[i]])) as unknown as RatioCurve;
}

/** Two values are the same setting (numbers compared on the key's step). */
export function sameValue(a: ParamValue, b: ParamValue): boolean {
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  const ka = Object.keys(a).sort();
  return ka.join() === Object.keys(b).sort().join()
    && ka.every((k) => (a as unknown as Record<string, number>)[k] === (b as unknown as Record<string, number>)[k]);
}
