/**
 * Tier 2 — the settings envelope (ADR 0608, spec §6.2): the most permissive value the kernel derives anywhere
 * on the ordinal grid or in the plan's own draws bounds every Advanced row's risky side. Computed once.
 * Plain-number inputs; kernel siblings only.
 */

import {
  type ActivityLevel, type Caution, type Cleanup, type Consistency, type DayShape, derivePattern, type OrdinalPattern,
  type Patience, type Rhythm, type WeeklyShape,
} from './derive';
import { EMPIRICAL } from './fundamentals';
import { BOUNDS, POLICY, PREFERENCES, SCALES } from './policy';
import { SETTINGS_POLICY } from './settings-policy';
import { scaleAbove } from './tempo';
import { MS_PER_HOUR, MS_PER_SECOND } from './units';

export type EnvelopeKey =
  | 'dailyVolume' | 'dailyCeiling' | 'hourlyCap' | 'dayVariation' | 'restDayChance' | 'candidateBuffer'
  | 'sessionsMin' | 'sessionsMax' | 'gapTypical' | 'gapFloor' | 'waitDays' | 'holdDays' | 'cleanupShare'
  | 'checksEveryHours';

export interface Interval { readonly min: number; readonly max: number }

/** The recommended ordinals the 30-point grid varies one knob at a time around. */
export const GRID_BASE: OrdinalPattern = {
  activityLevel: 'moderate', consistency: 'natural', rhythm: 'sessions', dayShape: 'balanced',
  weeklyShape: 'realistic', caution: 'standard', cleanup: 'steady', patience: 'normal',
};

const keysOf = <T extends object>(o: T): (keyof T)[] => Object.keys(o) as (keyof T)[];

/** The 30 grid points: every value of every knob, the others at {@link GRID_BASE}. */
export function gridPoints(): OrdinalPattern[] {
  const knobs: { [K in keyof OrdinalPattern]: readonly OrdinalPattern[K][] } = {
    activityLevel: keysOf(SCALES.activity) as ActivityLevel[],
    consistency: keysOf(SCALES.consistency) as Consistency[],
    rhythm: keysOf(SCALES.rhythm) as Rhythm[],
    dayShape: ['balanced', ...keysOf(PREFERENCES.dayShape)] as DayShape[],
    weeklyShape: ['realistic', ...keysOf(PREFERENCES.weeklyShape)] as WeeklyShape[],
    caution: keysOf(SCALES.caution) as Caution[],
    cleanup: keysOf(PREFERENCES.cleanup) as Cleanup[],
    patience: keysOf(PREFERENCES.patience) as Patience[],
  };
  return keysOf(knobs).flatMap((knob) => knobs[knob].map((value) => ({ ...GRID_BASE, [knob]: value })));
}

/**
 * The check spacing at a pace factor, in hours: the check tempo's prior (two session boundaries) scaled
 * above its floor (one boundary), as the plan draws it (a law pins it to the tempo spec).
 */
export function checkSpacingHours(pace: number): number {
  const boundary = EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value;
  return scaleAbove(2 * boundary, boundary, pace) / MS_PER_HOUR;
}

const hull = (xs: readonly number[]): Interval => ({ min: Math.min(...xs), max: Math.max(...xs) });

function computeEnvelope(): Readonly<Record<EnvelopeKey, Interval>> {
  const d = gridPoints().map(derivePattern);
  const of = (f: (x: (typeof d)[number]) => number): Interval => hull(d.map(f));
  const sessions = hull(d.flatMap((x) => [x.sessionsPerDayMin, x.sessionsPerDayMax]));
  return {
    dailyVolume: of((x) => x.dailyOperatingRate),
    dailyCeiling: of((x) => x.dailyHardCeiling),
    hourlyCap: of((x) => x.hourlyVelocityCap),
    dayVariation: of((x) => x.dailyVolumeVariancePct),
    restDayChance: of((x) => x.restDayChancePct),
    candidateBuffer: of((x) => x.dailyPlanSize),
    sessionsMin: sessions,
    sessionsMax: sessions,
    gapTypical: of((x) => x.gapMedianSeconds),
    gapFloor: of((x) => x.gapFloorSeconds),
    waitDays: of((x) => x.maxWaitForFollowbackDays),
    holdDays: of((x) => x.holdAfterFollowbackDays),
    // `deep` behaves as `steady` under the per-session unfollow bound (it left the intent vocabulary).
    cleanupShare: of((x) => Math.min(x.maxUnfollowFractionPerSession, BOUNDS.PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION)),
    // The briskest and the slowest spacing the plan's own pace draw produces.
    checksEveryHours: {
      min: checkSpacingHours(BOUNDS.NOISE.BEAT_MIN_FACTOR), max: checkSpacingHours(BOUNDS.NOISE.BEAT_MAX_FACTOR),
    },
  };
}

export const ENVELOPE: Readonly<Record<EnvelopeKey, Interval>> = computeEnvelope();

/** The shortest gap a cap sanctions: `⌈3600 s / (cap × BURST_TOLERANCE)⌉` (today's derived gap floor). */
export function burstFloorSeconds(hourlyCap: number): number {
  return Math.ceil(MS_PER_HOUR / (hourlyCap * POLICY.BURST_TOLERANCE) / MS_PER_SECOND);
}

/** The rung of the lowest vocabulary step that already reaches `value` (past the last step: the last rung). */
function rungFor<K extends string>(value: number, steps: Readonly<Record<K, number>>, rungs: Readonly<Record<K, number>>): number {
  const ordered = keysOf(steps).sort((a, b) => steps[a] - steps[b]);
  const at = ordered.find((k) => value <= steps[k]) ?? ordered[ordered.length - 1];
  return rungs[at];
}

/** The risk level: the higher of the daily rung (volume against the activity plans) and the hourly rung. */
export function riskRung(e: { readonly dailyVolume: number; readonly hourlyCap: number }): 0 | 1 | 2 | 3 {
  const plans = Object.fromEntries(keysOf(SCALES.activity).map((a) => [a, derivePattern({ ...GRID_BASE, activityLevel: a }).dailyOperatingRate]));
  const caps = Object.fromEntries(keysOf(SCALES.caution).map((c) => [c, derivePattern({ ...GRID_BASE, caution: c }).hourlyVelocityCap]));
  const daily = rungFor(e.dailyVolume, plans as Record<ActivityLevel, number>, SETTINGS_POLICY.RISK_RUNG.activity);
  const hourly = rungFor(e.hourlyCap, caps as Record<Caution, number>, SETTINGS_POLICY.RISK_RUNG.caution);
  return Math.max(daily, hourly) as 0 | 1 | 2 | 3;
}

/** Epo's largest automatic day as a share of the lowest daily follow limit Instagram is known to apply. */
export function shareOfLowWall(automaticDayMax: number): number {
  return automaticDayMax / EMPIRICAL.FOLLOW_WALL_PER_DAY.low;
}
