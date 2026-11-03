/**
 * What the settings core reads from the plan core's kernel (spec §5.4, §5.10, §6.2): the effective gap at
 * pace 1, the day law and its maximum, the retry limit. One port, so the parameter catalog, the view and
 * the migration basis take these numbers from one place; main supplies the kernel-backed implementation.
 */

import type { OrdinalPattern } from '@/kernel/derive';
import { CAUTION, derivePattern } from '@/kernel/derive';
import { ENVELOPE } from '@/kernel/derive-envelope';
import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { AudienceSize, Intent } from '@/shared/settings-intent';
import type { RatioCurve } from '@/shared/settings-model';

/** The reference gap shape and the cap the effective gap is solved for. */
export interface GapInputs {
  readonly hourlyCap: number;
  /** The reference shape's median and floor at time-scale 1, seconds. */
  readonly medianSeconds: number;
  readonly floorSeconds: number;
  /** The effective typical gap (an override, or the recommendation), seconds. */
  readonly typicalSeconds: number;
}

/** The plan core's numbers the settings core shows and bounds with. */
export interface PlanMath {
  /** The effective typical gap at pace 1: `3600 s · CEILING_HEADROOM / H / BEAT_MIN` (seconds). */
  gapTypicalSeconds(hourlyCap: number): number;
  /** The plan's gap floor at pace 1 (the reference floor time-scaled toward the typical gap), seconds. */
  gapMinimumSeconds(g: GapInputs): number;
  /** The most Epo does automatically in a day at a daily target. */
  automaticDayMax(operatingRate: number): number;
  /** The day law's 10th percentile, median and 90th percentile. */
  dayLaw(i: { readonly operatingRate: number; readonly dayVariationPct: number; readonly restDayPct: number }):
    { readonly low: number; readonly typical: number; readonly high: number };
  /** Attempts before an account is skipped. */
  retryLimit(): number;
}

/** The v2 recommendations the slower-only and bucket rows compare against (the settings core supplies them). */
export interface MigrationBasis {
  /** The recommended effective typical gap at pace 1 (seconds). */
  gapTypicalSeconds(intent: Intent): number;
  /** The recommended effective gap floor at pace 1 (seconds). */
  gapMinimumSeconds(intent: Intent): number;
  /** The briskest check spacing an override may ask for (hours). */
  readonly checksEveryHoursMin: number;
  readonly audienceSize: Readonly<Record<AudienceSize, { readonly min: number; readonly max: number }>>;
  /** The 'likely' follow-back curve. */
  readonly likelyCurve: RatioCurve;
  /** The private-account edge `preferPrivate` adds. */
  readonly privateEdge: number;
  /** The highest refill threshold that still has an effect. */
  readonly refillMax: number;
  /** The interim recommendations while the plan port is not registered. */
  readonly interim: { readonly cleanupPerDay: number; readonly censusEveryDays: number; readonly checksEveryHours: number };
}

/** The kernel's ordinal pattern for an intent. */
export function patternOf(i: Intent): OrdinalPattern {
  return {
    activityLevel: i.activity, consistency: i.consistency, rhythm: i.rhythm, dayShape: i.dayShape,
    weeklyShape: i.weeklyShape, caution: i.caution, cleanup: i.cleanup, patience: i.patience,
  };
}

/** The production migration basis (spec §6.10): the kernel's recommendations, the gaps from the plan math. */
export function migrationBasis(math: PlanMath): MigrationBasis {
  const gap = (i: Intent): GapInputs => {
    const shape = derivePattern(patternOf(i));
    const hourlyCap = CAUTION[i.caution].cap;
    return { hourlyCap, medianSeconds: shape.gapMedianSeconds, floorSeconds: shape.gapFloorSeconds, typicalSeconds: math.gapTypicalSeconds(hourlyCap) };
  };
  const { AUDIENCE_SIZE, RATIO_CURVE, PRIVATE_EDGE, INTERIM } = SETTINGS_POLICY;
  return {
    gapTypicalSeconds: (i) => Math.round(gap(i).typicalSeconds),
    gapMinimumSeconds: (i) => Math.round(math.gapMinimumSeconds(gap(i))),
    checksEveryHoursMin: ENVELOPE.checksEveryHours.min,
    audienceSize: AUDIENCE_SIZE,
    likelyCurve: RATIO_CURVE,
    privateEdge: PRIVATE_EDGE,
    refillMax: EXPLORATION_POLICY.queuedPerSource,
    interim: { cleanupPerDay: INTERIM.pruneDailyLimit, censusEveryDays: INTERIM.pruneScheduleDays, checksEveryHours: INTERIM.followbackSweepHours },
  };
}
