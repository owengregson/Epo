import { BOUNDS } from '../../kernel/policy';
import { type PatternSettings, PERSONAS, type PersonaId, resolvePattern } from '../pattern-map';
import type { Settings } from './settings-v1-types';

// --- The one knob table -------------------------------------------------------
//
// Every knob is declared ONCE here, with its default and its safe range in the
// same line. `DEFAULT_SETTINGS` is projected out of it and `sanitizeSettings`
// applies it, so a new knob cannot ship with a default but no clamp (or the
// reverse) — and `satisfies` below makes a knob missing from either the
// `Settings` interface or this table a compile error.

/** How one knob's stored value is repaired: never a throw, always the nearest safe value. */
export interface Rule<T> {
  fallback: T;
  coerce(raw: unknown): T;
}

const clamp = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
};

/** A real-valued knob, clamped into `[min, max]`. */
const num = (fallback: number, min: number, max: number): Rule<number> => ({
  fallback,
  coerce: (v) => clamp(v, fallback, min, max),
});

/** An integer knob: clamped, then rounded. */
const int = (fallback: number, min: number, max: number): Rule<number> => ({
  fallback,
  coerce: (v) => Math.round(clamp(v, fallback, min, max)),
});

const bool = (fallback: boolean): Rule<boolean> => ({
  fallback,
  coerce: (v) => (typeof v === 'boolean' ? v : fallback),
});

const str = (fallback: string): Rule<string> => ({
  fallback,
  coerce: (v) => (typeof v === 'string' ? v : fallback).trim(),
});

/** A list of strings; anything else (a hand-edited object, null) reads as empty. */
const strList = (): Rule<string[]> => ({
  fallback: [],
  coerce: (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []),
});

/** An epoch-ms timestamp, or null when absent/garbage. */
const epoch = (): Rule<number | null> => ({
  fallback: null,
  coerce: (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null),
});

/** A closed set of stored values; anything else degrades to `fallback`. */
const oneOf = <T extends string>(allowed: readonly T[], fallback: T): Rule<T> => ({
  fallback,
  coerce: (v) => (typeof v === 'string' && allowed.includes(v as T) ? (v as T) : fallback),
});

/** Allowed values for each qualitative knob (for sanitizing a hand-edited file). */
const PATTERN_ALLOWED = {
  activityLevel: ['minimal', 'light', 'moderate', 'active', 'aggressive'],
  consistency: ['clockwork', 'natural', 'erratic'],
  rhythm: ['trickle', 'sessions', 'bursts'],
  dayShape: ['morning', 'balanced', 'evening', 'nightowl', 'business'],
  weeklyShape: ['uniform', 'weekdays', 'weekends', 'realistic'],
  caution: ['cautious', 'standard', 'bold'],
  cleanup: ['off', 'trickle', 'steady', 'deep'],
  patience: ['quick', 'normal', 'patient'],
} as const;

export const PERSONA_IDS: readonly PersonaId[] = [
  'casual',
  'balanced',
  'grower',
  'nineToFive',
  'nightOwl',
  'custom',
];

/** Coerce a possibly hand-edited pattern object into a valid PatternSettings. */
export function sanitizePattern(raw: unknown): PatternSettings {
  const base = PERSONAS.balanced;
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = <K extends keyof PatternSettings>(k: K): PatternSettings[K] => {
    const allowed = PATTERN_ALLOWED[k] as readonly string[];
    const v = r[k];
    return (typeof v === 'string' && allowed.includes(v) ? v : base[k]) as PatternSettings[K];
  };
  return {
    activityLevel: pick('activityLevel'),
    consistency: pick('consistency'),
    rhythm: pick('rhythm'),
    dayShape: pick('dayShape'),
    weeklyShape: pick('weeklyShape'),
    caution: pick('caution'),
    cleanup: pick('cleanup'),
    patience: pick('patience'),
  };
}

/** The `balanced` persona IS the historical numeric default set — one home for both. */
const BALANCED = resolvePattern(PERSONAS.balanced);

export const RULES = {
  seed: str(''),

  // Ratio bands. The piecewise ordering is enforced by ORDERINGS below.
  bandLow: num(0.9, 0, 100),
  bandHigh: num(1.5, 0, 100),
  peakLow: num(1.0, 0, 100),
  peakHigh: num(1.2, 0, 100),
  hardLow: num(0.5, 0, 100),
  hardHigh: num(3.0, 0, 100),

  minFollowers: int(50, 0, 10_000_000),
  maxFollowers: int(20_000, 1, 100_000_000),
  privateBoost: num(0.15, 0, 1),

  maxWaitForFollowbackDays: num(BALANCED.maxWaitForFollowbackDays, 0.25, 60),
  holdAfterFollowbackDays: num(BALANCED.holdAfterFollowbackDays, 0, 60),
  maxRetries: int(3, 0, 10),

  dailyHardCeiling: int(BALANCED.dailyHardCeiling, 1, 1000),
  dailyOperatingRate: int(BALANCED.dailyOperatingRate, 1, 500),
  // Legacy pacing knobs — the prune-scan / manual paths and the legacy model
  // only. The growth pace comes from the qualitative pattern.
  minDelayMinutes: num(3, 0.5, 240),
  maxDelayMinutes: num(7, 0.5, 480),
  jitterPercent: num(30, 0, 90),
  activeHoursStart: int(8, 0, 23),
  activeHoursEnd: int(22, 0, 23),

  // The notifications-based check is one click + one request, cheap enough to
  // run hourly (the old whole-list paged sweep budgeted for multi-hour gaps).
  followbackSweepHours: num(1, 0.5, 168),
  sweepLastRunAt: epoch(),
  // The retired sweep factor's range, kept verbatim so a v1 file still coerces as it always did (ADR 0607).
  sweepIntervalFactor: num(1, BOUNDS.SETTINGS_V1.SWEEP_FACTOR_MIN, BOUNDS.SETTINGS_V1.SWEEP_FACTOR_MAX),
  autoAcceptFollowRequests: bool(true),

  dailyPlanSize: int(BALANCED.dailyPlanSize, 1, 200),
  lowWaterCandidates: int(5, 0, 100),
  minFollowBackRate: num(0.15, 0, 1),
  minPoolSize: int(300, 0, 1_000_000),

  dryRun: bool(false),

  pruneWhitelist: strList(),
  pruneBioFilterWords: strList(),
  pruneDailyLimit: int(50, 1, 1000),
  pruneScheduleDays: num(0, 0, 365),
  pruneLastRunAt: epoch(),
  // Matched to the widely-used console tool's scan cadence (~1.5–3.3 s per
  // 50-user API page): with the direct list walk this completes ~3200
  // followers in a few minutes while staying inside its proven rate band.
  pruneScanMinSeconds: num(1, 0.5, 300),
  pruneScanMaxSeconds: num(3, 0.5, 600),

  // Both models are valid stored values (an explicit 'legacy' from an existing
  // install is respected); anything else degrades to the default.
  pacingModel: oneOf(['legacy', 'organic'] as const, 'organic'),
  dailyVolumeVariancePct: num(BALANCED.dailyVolumeVariancePct, 0, 60),
  restDayChancePct: num(BALANCED.restDayChancePct, 0, 30),
  sessionsPerDayMin: int(BALANCED.sessionsPerDayMin, 1, 12),
  sessionsPerDayMax: int(BALANCED.sessionsPerDayMax, 1, 12),
  gapMedianSeconds: num(BALANCED.gapMedianSeconds, 30, 600),
  gapFloorSeconds: num(BALANCED.gapFloorSeconds, 15, 300),
  hourlyVelocityCap: int(BALANCED.hourlyVelocityCap, 3, 40),
  weaveEnabled: bool(BALANCED.weaveEnabled),
  maxUnfollowFractionPerSession: num(BALANCED.maxUnfollowFractionPerSession, 0, 1),

  // The qualitative pair is re-decided wholesale after the per-knob pass (see
  // the persona block in `sanitizeSettings`); these rules only supply defaults.
  persona: oneOf(PERSONA_IDS, 'balanced'),
  pattern: { fallback: { ...PERSONAS.balanced }, coerce: sanitizePattern } as Rule<PatternSettings>,

  tourCompletedAt: epoch(),
} satisfies { [K in keyof Settings]: Rule<Settings[K]> };

/**
 * Pairs that must stay ordered after the per-knob clamps: `[a, b]` lifts `a` to
 * at least `b`. Applied in sequence, so the ratio band's five links compose
 * into hardLow ≤ bandLow ≤ peakLow ≤ peakHigh ≤ bandHigh ≤ hardHigh.
 */
export const AT_LEAST: ReadonlyArray<readonly [NumericKnob, NumericKnob]> = [
  ['bandLow', 'hardLow'],
  ['peakLow', 'bandLow'],
  ['peakHigh', 'peakLow'],
  ['bandHigh', 'peakHigh'],
  ['hardHigh', 'bandHigh'],
  ['maxFollowers', 'minFollowers'],
  ['dailyHardCeiling', 'dailyOperatingRate'],
  ['maxDelayMinutes', 'minDelayMinutes'],
  ['pruneScanMaxSeconds', 'pruneScanMinSeconds'],
  ['sessionsPerDayMax', 'sessionsPerDayMin'],
];

/** Pairs where `a` must not exceed `b` (the gap floor never passes the median). */
export const AT_MOST: ReadonlyArray<readonly [NumericKnob, NumericKnob]> = [
  ['gapFloorSeconds', 'gapMedianSeconds'],
];

/** Knob names whose value is a plain number (the only ones the orderings touch). */
export type NumericKnob = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];
