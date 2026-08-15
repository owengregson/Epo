/**
 * Qualitative pattern model (§5.6). Users tune *behavior* — eight ordinal knobs and a
 * handful of named personas — instead of raw distribution numbers. This pure,
 * renderer-safe module maps those qualitative choices to the numeric pacing config the
 * SessionPlanner / governors consume AND to the circadian λ(t) profile. The settings
 * layer materializes the numbers from here; the settings-page live preview drives the
 * same functions, so what the user sees is exactly what the engine will do.
 */

import type { CircadianBump, CircadianProfile } from '../timing/circadian';
import { CIRCADIAN } from '../timing/config';

export type PersonaId =
  | 'casual'
  | 'balanced'
  | 'grower'
  | 'nineToFive'
  | 'nightOwl'
  | 'custom';

/** The eight ordinal knobs the primary settings UI writes. */
export interface PatternSettings {
  activityLevel: 'minimal' | 'light' | 'moderate' | 'active' | 'aggressive';
  consistency: 'clockwork' | 'natural' | 'erratic';
  rhythm: 'trickle' | 'sessions' | 'bursts';
  dayShape: 'morning' | 'balanced' | 'evening' | 'nightowl' | 'business';
  weeklyShape: 'uniform' | 'weekdays' | 'weekends' | 'realistic';
  caution: 'cautious' | 'standard' | 'bold';
  cleanup: 'off' | 'trickle' | 'steady' | 'deep';
  patience: 'quick' | 'normal' | 'patient';
}

/** The numeric pacing knobs derived from a PatternSettings (display units). */
export interface ResolvedPattern {
  dailyOperatingRate: number;
  dailyHardCeiling: number;
  dailyVolumeVariancePct: number;
  restDayChancePct: number;
  sessionsPerDayMin: number;
  sessionsPerDayMax: number;
  gapMedianSeconds: number;
  gapFloorSeconds: number;
  hourlyVelocityCap: number;
  weaveEnabled: boolean;
  maxUnfollowFractionPerSession: number;
  maxWaitForFollowbackDays: number;
  holdAfterFollowbackDays: number;
  /** Candidates queued per plan — a buffer above the daily follow target. */
  dailyPlanSize: number;
}

// --- Mapping tables (each ordinal → a value). Tuned so `balanced` reproduces the
//     historical numeric defaults; see the persona test. ---

// Daily FOLLOW plan per activity level. Unfollows, follow-back checks, and reads are
// weaved in on top and do NOT count against this (they're bounded by the velocity guard
// and the prune cap). The top of the range plans ~100 follows/day — near the established-
// account safe ceiling (~100–150/day); the velocity guard keeps the per-hour rate safe.
const ACTIVITY: Record<PatternSettings['activityLevel'], number> = {
  minimal: 15,
  light: 30,
  moderate: 50,
  active: 75,
  aggressive: 100,
};
const VARIANCE_PCT: Record<PatternSettings['consistency'], number> = {
  clockwork: 12,
  natural: 28,
  erratic: 45,
};
const REST_DAY_PCT: Record<PatternSettings['consistency'], number> = {
  clockwork: 0,
  natural: 8,
  erratic: 18,
};
const RHYTHM: Record<
  PatternSettings['rhythm'],
  { min: number; max: number; gapMedianSeconds: number }
> = {
  trickle: { min: 5, max: 9, gapMedianSeconds: 180 },
  sessions: { min: 3, max: 6, gapMedianSeconds: 95 },
  bursts: { min: 2, max: 4, gapMedianSeconds: 55 },
};
const CAUTION: Record<PatternSettings['caution'], { cap: number; floorSeconds: number }> = {
  cautious: { cap: 14, floorSeconds: 60 },
  standard: { cap: 22, floorSeconds: 45 },
  bold: { cap: 30, floorSeconds: 35 },
};
// Cleanup controls the WEAVE intensity (whether/how much to unfollow non-followers in the
// stream). The daily unfollow CAP stays a separate manual setting (edited in the Prune view).
const CLEANUP: Record<PatternSettings['cleanup'], { weave: boolean; fraction: number }> = {
  off: { weave: false, fraction: 0 },
  trickle: { weave: true, fraction: 0.25 },
  steady: { weave: true, fraction: 0.5 },
  deep: { weave: true, fraction: 0.7 },
};
const PATIENCE: Record<PatternSettings['patience'], { waitDays: number; holdDays: number }> = {
  quick: { waitDays: 2, holdDays: 1 },
  normal: { waitDays: 4, holdDays: 2 },
  patient: { waitDays: 7, holdDays: 4 },
};

/** Map the eight qualitative knobs to the numeric pacing config. */
export function resolvePattern(p: PatternSettings): ResolvedPattern {
  const mean = ACTIVITY[p.activityLevel];
  const rhythm = RHYTHM[p.rhythm];
  const caution = CAUTION[p.caution];
  const cleanup = CLEANUP[p.cleanup];
  const patience = PATIENCE[p.patience];
  const gapMedianSeconds = rhythm.gapMedianSeconds;
  return {
    dailyOperatingRate: mean,
    dailyHardCeiling: Math.round(mean * 1.3),
    dailyVolumeVariancePct: VARIANCE_PCT[p.consistency],
    restDayChancePct: REST_DAY_PCT[p.consistency],
    sessionsPerDayMin: rhythm.min,
    sessionsPerDayMax: rhythm.max,
    gapMedianSeconds,
    gapFloorSeconds: Math.min(caution.floorSeconds, gapMedianSeconds),
    hourlyVelocityCap: caution.cap,
    weaveEnabled: cleanup.weave,
    maxUnfollowFractionPerSession: cleanup.fraction,
    maxWaitForFollowbackDays: patience.waitDays,
    holdAfterFollowbackDays: patience.holdDays,
    dailyPlanSize: Math.round(mean * 1.2), // queue a buffer above the daily follow target
  };
}

// --- Circadian shape from dayShape / weeklyShape ---

const DAY_SHAPE_BUMPS: Record<PatternSettings['dayShape'], CircadianBump[]> = {
  morning: [
    { centerHour: 8, amplitude: 0.9, widthHours: 1.8 },
    { centerHour: 12.5, amplitude: 0.5, widthHours: 2 },
    { centerHour: 18, amplitude: 0.5, widthHours: 3 },
  ],
  balanced: CIRCADIAN.BUMPS.map((b) => ({ ...b })),
  evening: [
    { centerHour: 8, amplitude: 0.3, widthHours: 1.6 },
    { centerHour: 13, amplitude: 0.45, widthHours: 2 },
    { centerHour: 19, amplitude: 1.0, widthHours: 3.2 },
  ],
  nightowl: [
    { centerHour: 11, amplitude: 0.4, widthHours: 2 },
    { centerHour: 16, amplitude: 0.5, widthHours: 2.5 },
    { centerHour: 22, amplitude: 1.0, widthHours: 3.2 },
  ],
  business: [
    { centerHour: 10, amplitude: 0.8, widthHours: 2.5 },
    { centerHour: 15, amplitude: 0.9, widthHours: 3.0 },
    { centerHour: 19, amplitude: 0.3, widthHours: 2.0 },
  ],
};

const WEEKLY_WEIGHTS: Record<PatternSettings['weeklyShape'], number[]> = {
  // Sun..Sat (Date.getDay order).
  uniform: [1, 1, 1, 1, 1, 1, 1],
  weekdays: [0.6, 1.1, 1.1, 1.1, 1.1, 1.1, 0.6],
  weekends: [1.3, 0.85, 0.85, 0.85, 0.85, 0.9, 1.3],
  realistic: [...CIRCADIAN.DAY_OF_WEEK_WEIGHTS],
};

/** Build the circadian profile for the chosen day/week shape and per-install phase offset. */
export function patternCircadianProfile(p: PatternSettings, phaseOffsetHours: number): CircadianProfile {
  return {
    bumps: DAY_SHAPE_BUMPS[p.dayShape].map((b) => ({ ...b })),
    overnightFloor: p.dayShape === 'nightowl' ? 0.06 : CIRCADIAN.OVERNIGHT_FLOOR,
    dayOfWeekWeights: [...WEEKLY_WEIGHTS[p.weeklyShape]],
    weekendShiftHours: CIRCADIAN.WEEKEND_SHIFT_HOURS,
    phaseOffsetHours,
  };
}

// --- Personas (named bundles). `custom` has no bundle — it means user-tuned knobs. ---

export const PERSONAS: Record<Exclude<PersonaId, 'custom'>, PatternSettings> = {
  casual: {
    activityLevel: 'light',
    consistency: 'natural',
    rhythm: 'trickle',
    dayShape: 'evening',
    weeklyShape: 'realistic',
    caution: 'cautious',
    cleanup: 'trickle',
    patience: 'normal',
  },
  balanced: {
    activityLevel: 'moderate',
    consistency: 'natural',
    rhythm: 'sessions',
    dayShape: 'balanced',
    weeklyShape: 'realistic',
    caution: 'standard',
    cleanup: 'steady',
    patience: 'normal',
  },
  grower: {
    activityLevel: 'active',
    consistency: 'natural',
    rhythm: 'sessions',
    dayShape: 'balanced',
    weeklyShape: 'realistic',
    caution: 'bold',
    cleanup: 'steady',
    patience: 'quick',
  },
  nineToFive: {
    activityLevel: 'moderate',
    consistency: 'clockwork',
    rhythm: 'sessions',
    dayShape: 'business',
    weeklyShape: 'weekdays',
    caution: 'standard',
    cleanup: 'steady',
    patience: 'normal',
  },
  nightOwl: {
    activityLevel: 'moderate',
    consistency: 'natural',
    rhythm: 'bursts',
    dayShape: 'nightowl',
    weeklyShape: 'realistic',
    caution: 'standard',
    cleanup: 'trickle',
    patience: 'patient',
  },
};

/** The pattern bundle for a named persona. */
export function personaPattern(id: Exclude<PersonaId, 'custom'>): PatternSettings {
  return { ...PERSONAS[id] };
}
