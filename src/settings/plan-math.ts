/**
 * The production plan math (spec §5.4, §5.10): the settings core's numbers read straight from the plan
 * core's kernel — the gap solve, the day law and its maximum, the retry limit — so Settings shows what
 * the plan draws. `tests/settings/plan-math.test.ts` pins every member to the plan for the same intent.
 */
import { retryLimit } from '@/kernel/derive-lifecycle';
import { fromPercent, referenceGapShape } from '@/kernel/plan/caps';
import { effectiveGapAtPace1 } from '@/kernel/plan/gap';
import type { PlanIntent } from '@/kernel/plan/types';
import { automaticDayMax, dayLawQuantiles } from '@/kernel/plan/volume';
import { MS_PER_SECOND } from '@/kernel/units';
import type { GapInputs, PlanMath } from './basis';
import { effectiveFromV1 } from './effective';
import { toPlanIntent } from './plan-intent';
import { DEFAULT_SETTINGS } from './v1/settings-v1';

let reference: PlanIntent | null = null;

/**
 * A complete intent with the fields one solve reads replaced. The gap solve reads the cap, the shape,
 * the overrides and the session size; the day law reads the target, its spread and the rest-day chance.
 */
function intentWith(fields: Partial<PlanIntent>): PlanIntent {
  reference ??= toPlanIntent(effectiveFromV1(DEFAULT_SETTINGS));
  return { ...reference, ...fields };
}

function gapIntent(g: GapInputs, typicalSeconds: number | null): PlanIntent {
  return intentWith({
    hourlyCap: g.hourlyCap, gap: referenceGapShape(g.medianSeconds, g.floorSeconds),
    gapTargetOverrideMs: typicalSeconds === null ? null : typicalSeconds * MS_PER_SECOND, gapFloorOverrideMs: null,
    operatingRate: g.operatingRate, sessions: g.sessions,
  });
}

export const KERNEL_PLAN_MATH: PlanMath = {
  gapTypicalSeconds: (g) => effectiveGapAtPace1(gapIntent(g, null)).typicalMs / MS_PER_SECOND,
  gapMinimumSeconds: (g, typicalSeconds) => effectiveGapAtPace1(gapIntent(g, typicalSeconds)).minimumMs / MS_PER_SECOND,
  automaticDayMax,
  dayLaw: ({ operatingRate, dayVariationPct, restDayPct }) => {
    const q = dayLawQuantiles(intentWith({
      operatingRate, volumeSigma: fromPercent(dayVariationPct), restDayProbability: fromPercent(restDayPct),
    }));
    return { low: q.p10, typical: q.median, high: q.p90 };
  },
  retryLimit: () => retryLimit(),
};
