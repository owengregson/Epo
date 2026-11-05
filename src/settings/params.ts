/**
 * The Advanced parameter catalog (spec §6.5, Appendix B.4): one spec per `ParamKey` — where it shows, how
 * it is recommended from intent and the effective upstreams, its risk and its bounds (envelope ∩ guards ∩
 * coupled bounds). Exhaustive by type; `TOPO_ORDER` resolves every key after the keys it reads.
 */
import { type ParamKey, T2_PARAM_KEYS, TEMPO_PARAM_KEYS } from '@/shared/settings-params';
import { AUDIENCE_SPECS } from './params-audience';
import { LIFECYCLE_SPECS } from './params-lifecycle';
import { PACE_SPECS } from './params-pace';
import type { ParamSpec } from './params-spec';
import { TEMPO_ROW_SPECS } from './params-tempo';

export const ALL_PARAM_KEYS: readonly ParamKey[] = [...T2_PARAM_KEYS, ...TEMPO_PARAM_KEYS];

export const PARAM_SPECS = {
  ...PACE_SPECS, ...LIFECYCLE_SPECS, ...AUDIENCE_SPECS, ...TEMPO_ROW_SPECS,
} satisfies { [K in ParamKey]: ParamSpec };

/** Every key once, each after the keys it reads (a depth-first topological order). */
function topoOrder(): readonly ParamKey[] {
  const out: ParamKey[] = [];
  const state = new Map<ParamKey, 'visiting' | 'done'>();
  const visit = (k: ParamKey, path: readonly ParamKey[]): void => {
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'visiting') throw new Error(`settings: dependency cycle ${[...path, k].join(' → ')}`);
    state.set(k, 'visiting');
    for (const d of PARAM_SPECS[k].deps) visit(d, [...path, k]);
    state.set(k, 'done');
    out.push(k);
  };
  for (const k of ALL_PARAM_KEYS) visit(k, []);
  return out;
}

export const TOPO_ORDER: readonly ParamKey[] = topoOrder();

export { clampValue, type DeriveCtx, fitsKind, num, type ParamSpec, sameValue } from './params-spec';
