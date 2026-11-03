/**
 * The resolve algorithm (spec §6.1): in topological order, each key's recommendation is derived from the
 * intent and the EFFECTIVE upstreams; the effective value is the override (or the recommendation) clamped
 * into envelope ∩ guards ∩ coupled bounds. Overrides are never rewritten here: clamping is reported.
 */
import type { Interval } from '@/kernel/derive-envelope';
import type { Intent } from '@/shared/settings-intent';
import type { ParamValue } from '@/shared/settings-model';
import type { ParamKey } from '@/shared/settings-params';
import type { PlanMath } from './basis';
import type { OverrideEntry } from './doc';
import { PARAM_SPECS, TOPO_ORDER } from './params';
import { clampValue, type DeriveCtx, fitsKind, sameValue } from './params-spec';

export interface ResolveInput {
  readonly intent: Intent;
  readonly overrides: Readonly<Partial<Record<ParamKey, OverrideEntry>>>;
  /** Whether the plan port is registered (the interim recommendations hold until it is). */
  readonly plan: boolean;
  readonly math: PlanMath;
}

export interface ResolvedParam {
  readonly value: ParamValue;
  readonly recommended: ParamValue;
  readonly bounds: Interval;
  readonly override: {
    readonly requested: ParamValue; readonly setAt: number; readonly basis: ParamValue;
    readonly clamped: boolean; readonly stale: boolean;
  } | null;
}

export type ResolvedParams = Readonly<Record<ParamKey, ResolvedParam>>;

/** Resolve every key. An override whose shape does not fit its key is ignored (the ops refuse such writes). */
export function resolveParams(input: ResolveInput): ResolvedParams {
  const upstream: Partial<Record<ParamKey, ParamValue>> = {};
  const out: Partial<Record<ParamKey, ResolvedParam>> = {};
  for (const key of TOPO_ORDER) {
    const spec = PARAM_SPECS[key];
    const ctx: DeriveCtx = { intent: input.intent, upstream, plan: input.plan, math: input.math };
    const recommended = spec.derive(ctx);
    const bounds = spec.bounds(ctx, recommended);
    const entry = input.overrides[key];
    const own = entry !== undefined && fitsKind(spec.kind, entry.value) ? entry : null;
    const value = clampValue(spec, own === null ? recommended : own.value, bounds);
    upstream[key] = value;
    out[key] = {
      value, recommended, bounds,
      override: own === null ? null : {
        requested: own.value, setAt: own.setAt, basis: own.basis,
        clamped: !sameValue(value, own.value), stale: !sameValue(own.basis, recommended),
      },
    };
  }
  return out as ResolvedParams;
}

/** The effective number of a key (every catalog key but the range and the curve is a number). */
export function numberOf(r: ResolvedParams, key: ParamKey): number {
  const v = r[key].value;
  if (typeof v !== 'number') throw new Error(`settings: ${key} is not a number`);
  return v;
}
