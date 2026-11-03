/**
 * The tempo parameter keys (Appendix B.4): `tempo.<key>` for every tempo key no
 * other parameter sets, in registry order. `src/shared` restates them import-free;
 * this pins the restatement to the kernel's registry.
 */
import { TEMPO_KEYS } from '@/kernel/tempo';
import { type ParamKey, T2_PARAM_KEYS, TEMPO_PARAM_KEYS } from '@/shared/settings-params';
import { TEMPO_PARAM_KEYS as DIRECT } from '@/shared/settings-params-tempo';

/** The session gaps set `gap.action` and `checks.everyHours` sets `check.spacing`. */
const SET_ELSEWHERE: readonly string[] = ['gap.action', 'check.spacing'];

test('every tempo key but the two other parameters set, prefixed, in registry order', () => {
  expect(TEMPO_PARAM_KEYS).toEqual(TEMPO_KEYS.filter((k) => !SET_ELSEWHERE.includes(k)).map((k) => `tempo.${k}`));
  expect(TEMPO_PARAM_KEYS).toHaveLength(TEMPO_KEYS.length - SET_ELSEWHERE.length);
});

test('settings-params re-exports the one tuple, and ParamKey spans both sets without overlap', () => {
  expect(TEMPO_PARAM_KEYS).toBe(DIRECT);
  const all: readonly ParamKey[] = [...T2_PARAM_KEYS, ...TEMPO_PARAM_KEYS];
  expect(new Set(all).size).toBe(all.length);
});
