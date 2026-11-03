/**
 * The pace and session rows of the parameter catalog (spec §6.5): the daily target and hard stop, the hourly
 * cap, the day's variation, sessions per day and the two gap rows on the effective scale (§5.10, slower only).
 */
import { ACTIVITY, CAUTION, derivePattern, REST_DAY_PCT, RHYTHM, VARIANCE_PCT } from '@/kernel/derive';
import { burstFloorSeconds, ENVELOPE } from '@/kernel/derive-envelope';
import { POLICY } from '@/kernel/policy';
import { SETTINGS_GUARDS as G, SETTINGS_POLICY } from '@/kernel/settings-policy';
import { patternOf } from './basis';
import { type DeriveCtx, num, type ParamSpec } from './params-spec';

const { whole } = SETTINGS_POLICY.PARAM_STEP;

const ROW = { kind: 'int', step: whole, needs: null, deps: [] } as const;

export const PACE_SPECS = {
  'pace.dailyVolume': {
    ...ROW, section: 'pace', unit: 'per-day', risk: 'higher-is-riskier', applies: 'replan',
    derive: (c: DeriveCtx) => ACTIVITY[c.intent.activity],
    bounds: () => ({ min: G.dailyVolume.min, max: ENVELOPE.dailyVolume.max }),
  },
  'pace.dailyCeiling': {
    ...ROW, section: 'pace', unit: 'per-day', risk: 'higher-is-riskier', applies: 'now', deps: ['pace.dailyVolume'],
    derive: (c: DeriveCtx) => Math.round(num(c, 'pace.dailyVolume') * POLICY.CEILING_HEADROOM),
    bounds: (c: DeriveCtx) => ({ min: Math.max(G.dailyCeiling.min, num(c, 'pace.dailyVolume')), max: ENVELOPE.dailyCeiling.max }),
  },
  'pace.hourlyCap': {
    ...ROW, section: 'pace', unit: 'per-hour', risk: 'higher-is-riskier', applies: 'now',
    derive: (c: DeriveCtx) => CAUTION[c.intent.caution].cap,
    bounds: () => ({ min: G.hourlyCap.min, max: ENVELOPE.hourlyCap.max }),
  },
  'pace.dayVariation': {
    ...ROW, section: 'pace', unit: 'percent', risk: 'neutral', applies: 'replan',
    derive: (c: DeriveCtx) => VARIANCE_PCT[c.intent.consistency],
    bounds: () => ({ min: 0, max: ENVELOPE.dayVariation.max }),
  },
  'pace.restDayChance': {
    ...ROW, section: 'pace', unit: 'percent', risk: 'neutral', applies: 'replan',
    derive: (c: DeriveCtx) => REST_DAY_PCT[c.intent.consistency],
    bounds: () => ENVELOPE.restDayChance,
  },
  'pace.candidateBuffer': {
    ...ROW, section: 'pace', unit: 'count', risk: 'higher-is-riskier', applies: 'now', deps: ['pace.dailyVolume'],
    derive: (c: DeriveCtx) => Math.round(num(c, 'pace.dailyVolume') * POLICY.PLAN_BUFFER),
    bounds: () => ({ min: G.candidateBuffer.min, max: ENVELOPE.candidateBuffer.max }),
  },
  'sessions.perDayMin': {
    ...ROW, section: 'schedule', unit: 'count', risk: 'neutral', applies: 'replan',
    derive: (c: DeriveCtx) => RHYTHM[c.intent.rhythm].min,
    bounds: () => ENVELOPE.sessionsMin,
  },
  'sessions.perDayMax': {
    ...ROW, section: 'schedule', unit: 'count', risk: 'neutral', applies: 'replan', deps: ['sessions.perDayMin'],
    derive: (c: DeriveCtx) => RHYTHM[c.intent.rhythm].max,
    bounds: (c: DeriveCtx) => ({ min: num(c, 'sessions.perDayMin'), max: ENVELOPE.sessionsMax.max }),
  },
  'sessions.gapTypical': {
    ...ROW, section: 'timing', unit: 'seconds', risk: 'lower-is-riskier', applies: 'replan', needs: 'plan',
    deps: ['pace.hourlyCap'],
    derive: (c: DeriveCtx) => Math.round(c.math.gapTypicalSeconds(num(c, 'pace.hourlyCap'))),
    // Slower only: never below the plan's own typical pause.
    bounds: (_c: DeriveCtx, rec: unknown) =>
      ({ min: rec as number, max: (rec as number) * SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR }),
  },
  'sessions.gapMinimum': {
    ...ROW, section: 'timing', unit: 'seconds', risk: 'lower-is-riskier', applies: 'replan', needs: 'plan',
    deps: ['pace.hourlyCap', 'sessions.gapTypical'],
    derive: (c: DeriveCtx) => {
      const shape = derivePattern(patternOf(c.intent));
      return Math.round(c.math.gapMinimumSeconds({
        hourlyCap: num(c, 'pace.hourlyCap'), medianSeconds: shape.gapMedianSeconds, floorSeconds: shape.gapFloorSeconds,
        typicalSeconds: num(c, 'sessions.gapTypical'),
      }));
    },
    // Slower only, never under the burst floor of the effective cap, never above the typical pause.
    bounds: (c: DeriveCtx, rec: unknown) => ({
      min: Math.max(rec as number, burstFloorSeconds(num(c, 'pace.hourlyCap'))), max: num(c, 'sessions.gapTypical'),
    }),
  },
} satisfies Record<string, ParamSpec>;
