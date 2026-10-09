/**
 * Qualitative pattern model (§5.6). Users tune *behavior* — eight ordinal knobs and a
 * handful of named personas — instead of raw distribution numbers. This pure,
 * renderer-safe module maps those qualitative choices to the numeric pacing config the
 * SessionPlanner / governors consume AND to the circadian λ(t) profile. The settings
 * layer materializes the numbers from here; the settings-page live preview drives the
 * same functions, so what the user sees is exactly what the engine will do.
 *
 * This file is now a SHIM over `src/kernel/derive.ts` (ADR 0605): the level tables it
 * used to hand-write are derived from the empirical wall/human-behaviour quantities and
 * the policy dials — `{14, 22, 30}` per hour is `round(60 × 0.37 × k_caution)`,
 * `{15 … 100}` per day is `round(150 × 0.37 × k_activity)`, the gap medians are the
 * human within-session median scaled by rhythm. The two tables that express PREFERENCE
 * rather than physics (cleanup, patience) and the named day/week caricatures live in
 * `src/kernel/policy.ts`. The PUBLIC API here is unchanged.
 */

import { dayShapeBumps, derivePattern, overnightFloor, weeklyWeights } from '../kernel/derive';
import type { CircadianProfile } from '../timing/circadian';
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

/**
 * Map the eight qualitative knobs to the numeric pacing config.
 *
 * Every number this returns is derived (see `src/kernel/derive.ts`): the daily plan and
 * hourly cap from the observed walls at the chosen safety margin, the gap median from
 * the human within-session median, the gap floor from the burst tolerance at that cap,
 * variance and rest-day chance from the human day-volume statistics.
 */
export function resolvePattern(p: PatternSettings): ResolvedPattern {
  return derivePattern(p);
}

/** Build the circadian profile for the chosen day/week shape and per-install phase offset. */
export function patternCircadianProfile(
  p: PatternSettings,
  phaseOffsetHours: number,
): CircadianProfile {
  return {
    bumps: dayShapeBumps(p.dayShape),
    overnightFloor: overnightFloor(p.dayShape),
    dayOfWeekWeights: weeklyWeights(p.weeklyShape),
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
