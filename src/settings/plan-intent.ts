/**
 * The plan's inputs from live settings (ADR 0607, spec §5.3): `toPlanIntent` maps the effective
 * settings onto the kernel's `PlanIntent` (the read-allowance bridge pattern); the kernel never sees
 * Settings. `intentDigest` is the fingerprint every re-plan and preview keys on. Both are pure.
 */

import { dayShapeBumps, overnightFloor, weeklyWeights } from '../kernel/derive';
import { EMPIRICAL } from '../kernel/fundamentals';
import { cleanupShare, fromPercent, probationHourlyCap, referenceGapShape, unfollowHourlyCap } from '../kernel/plan/caps';
import { intentDigest } from '../kernel/plan/digest';
import type { PlanIntent } from '../kernel/plan/types';
import { POLICY, SCALES } from '../kernel/policy';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_SECOND } from '../kernel/units';
import type { EffectiveSettings } from './effective';

export { intentDigest };

const orNull = (v: number | null, unit: number): number | null => (v === null ? null : v * unit);

export function toPlanIntent(e: EffectiveSettings): PlanIntent {
  const p = e.pattern;
  return {
    operatingRate: e.dailyOperatingRate,
    hardCeiling: e.dailyHardCeiling,
    hourlyCap: e.hourlyVelocityCap,
    probationHourlyCap: probationHourlyCap(e.hourlyVelocityCap, p.caution),
    unfollowHourlyCap: Math.min(e.hourlyVelocityCap, unfollowHourlyCap(p.caution)),
    sessions: { min: e.sessionsPerDayMin, max: e.sessionsPerDayMax },
    gap: referenceGapShape(e.gapMedianSeconds, e.gapFloorSeconds),
    gapTargetOverrideMs: orNull(e.gapTargetOverrideSeconds, MS_PER_SECOND),
    gapFloorOverrideMs: orNull(e.gapFloorOverrideSeconds, MS_PER_SECOND),
    volumeSigma: fromPercent(e.dailyVolumeVariancePct),
    restDayProbability: fromPercent(e.restDayChancePct),
    consistencyScale: SCALES.consistency[p.consistency],
    cleanupShare: cleanupShare(p.cleanup, e.weaveEnabled),
    cleanupPerDayCap: e.cleanupPerDayOverride,
    patienceWaitMs: (e.censusEveryDaysOverride ?? e.maxWaitForFollowbackDays) * MS_PER_DAY,
    checkSpacingOverrideMs: orNull(e.checkSpacingHoursOverride, MS_PER_HOUR),
    acceptRequests: e.autoAcceptFollowRequests,
    shape: {
      bumps: dayShapeBumps(p.dayShape),
      overnightFloor: overnightFloor(p.dayShape),
      weekdayWeights: weeklyWeights(p.weeklyShape),
      weekendShiftHours: EMPIRICAL.HUMAN_CIRCADIAN.weekendShiftHours,
    },
    quietHours: e.quietHours,
    daysOff: [...e.daysOff],
    tempoOverrides: { ...e.tempoOverrides },
    planBuffer: POLICY.PLAN_BUFFER,
  };
}
