/**
 * The plain choices of Settings v2 (spec §6.9, Appendix B.1): every field is a
 * plan or engine input, none is a timing. Pure, no imports; a test pins each
 * tuple to the kernel's key set, so the kernel stays the source of meaning.
 */

export const ACTIVITY_LEVELS = ['minimal', 'light', 'moderate', 'active', 'aggressive'] as const;
export const CAUTIONS = ['cautious', 'standard', 'bold'] as const;
export const RHYTHMS = ['trickle', 'sessions', 'bursts'] as const;
export const CONSISTENCIES = ['clockwork', 'natural', 'erratic'] as const;
export const DAY_SHAPES = ['balanced', 'morning', 'evening', 'nightowl', 'business'] as const;
export const WEEKLY_SHAPES = ['realistic', 'uniform', 'weekdays', 'weekends'] as const;
export const PATIENCES = ['quick', 'normal', 'patient'] as const;
/** The kernel's cleanup keys without `deep` (retired from intent; it behaves as `steady`). */
export const CLEANUP_LEVELS = ['off', 'trickle', 'steady'] as const;
export const MUTUAL_POLICIES = ['rotate', 'keep'] as const;
export const AUDIENCE_FOCUSES = ['likely', 'wide'] as const;
export const AUDIENCE_SIZES = ['small', 'everyday', 'larger'] as const;

export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];
export type Caution = (typeof CAUTIONS)[number];
export type Rhythm = (typeof RHYTHMS)[number];
export type Consistency = (typeof CONSISTENCIES)[number];
export type DayShape = (typeof DAY_SHAPES)[number];
export type WeeklyShape = (typeof WEEKLY_SHAPES)[number];
export type Patience = (typeof PATIENCES)[number];
export type CleanupLevel = (typeof CLEANUP_LEVELS)[number];
export type MutualPolicy = (typeof MUTUAL_POLICIES)[number];
export type AudienceFocus = (typeof AUDIENCE_FOCUSES)[number];
export type AudienceSize = (typeof AUDIENCE_SIZES)[number];

/** Sun..Sat, the kernel's weekly-weights order; the UI renders Mon-first. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** The week's days by `DayOfWeek` index. */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Seven days off is Stop, not a plan: all but one day (the settings policy's `MAX_DAYS_OFF`). */
export const MAX_DAYS_OFF = WEEKDAYS.length - 1;

/** Local wall-clock minutes in [0, 1440) on the 30-minute grid; may wrap midnight; start ≠ end. */
export type QuietHours =
  | { readonly kind: 'derived' }
  | { readonly kind: 'custom'; readonly startMinute: number; readonly endMinute: number }
  | { readonly kind: 'none' };

export interface Intent {
  readonly activity: ActivityLevel;
  readonly caution: Caution;
  readonly rhythm: Rhythm;
  readonly consistency: Consistency;
  readonly dayShape: DayShape;
  readonly weeklyShape: WeeklyShape;
  readonly quietHours: QuietHours;
  readonly daysOff: readonly DayOfWeek[];
  readonly patience: Patience;
  readonly mutuals: MutualPolicy;
  readonly cleanup: CleanupLevel;
  readonly audienceFocus: AudienceFocus;
  readonly audienceSize: AudienceSize;
  readonly preferPrivate: boolean;
}
export type IntentKey = keyof Intent;

/** Every intent key once, in the document's order. */
export const INTENT_KEYS = [
  'activity', 'caution', 'rhythm', 'consistency', 'dayShape', 'weeklyShape', 'quietHours', 'daysOff',
  'patience', 'mutuals', 'cleanup', 'audienceFocus', 'audienceSize', 'preferPrivate',
] as const satisfies readonly IntentKey[];

/** Easy pace cards map to ordinals (product vocabulary, not numbers). */
export type PaceCardId = 'gentle' | 'balanced' | 'faster';
export const PACE_CARDS = {
  gentle: { activity: 'light', caution: 'cautious' },
  balanced: { activity: 'moderate', caution: 'standard' },
  faster: { activity: 'active', caution: 'standard' },
} as const satisfies Readonly<Record<PaceCardId, { readonly activity: ActivityLevel; readonly caution: Caution }>>;
