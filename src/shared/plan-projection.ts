/**
 * The day plan as the renderer sees it (spec §5.17): `EpoStatus.plan` rides the
 * throttled status push. Renderer-safe: the plan vocabulary is restated here as
 * literal unions (the kernel's own types stay in `src/kernel/plan`).
 */

/** Why the day's volume is what it is. */
export type PlanBinding = 'none' | 'band' | 'session-time' | 'light-day' | 'follow-bound' | 'day-off';

/** The event that drew or redrew the plan. */
export type ReplanCause =
  | 'day-start' | 'first-open' | 'settings' | 'demand' | 'boost-start' | 'boost-end' | 'clock' | 'repair';

/** Where one planned session stands. */
export type SessionState = 'done' | 'partial' | 'skipped' | 'before-open' | 'now' | 'next' | 'later';

/** Session pace as a word: one per pace band. */
export type PaceWord = 'relaxed' | 'normal' | 'quick';

export interface Progress {
  readonly planned: number;
  readonly done: number;
}

export interface PlanProjection {
  readonly day: {
    readonly key: string; readonly startsAt: number; readonly endsAt: number; readonly quietMinute: number;
    readonly light: boolean; readonly lateStart: boolean; readonly binding: PlanBinding;
    /** Only from the user's own days off (the posture keys on it). */
    readonly dayOff: boolean;
  };
  readonly revision: number;
  readonly cause: ReplanCause;
  readonly totals: {
    readonly planned: number; readonly done: number; readonly remaining: number;
    readonly automaticMax: number; readonly ceiling: number; readonly outside: number;
  };
  readonly kinds: { readonly follow: Progress; readonly unfollow: Progress; readonly accept: Progress };
  readonly reads: { readonly profiles: Progress; readonly pages: Progress; readonly checks: Progress };
  readonly sessions: readonly {
    readonly idx: number; readonly startAt: number; readonly endAt: number; readonly planned: number;
    readonly done: number; readonly state: SessionState; readonly mix: 'normal' | 'boost';
    readonly probation: boolean; readonly censusHost: boolean; readonly pace: PaceWord;
  }[];
  readonly now: { readonly sessionIdx: number | null; readonly nextAt: number | null; readonly closesAt: number | null };
  /** Advanced → Timing → "Today's plan in detail": the values the plan really uses. */
  readonly detail: {
    readonly caps: {
      readonly automaticMax: number; readonly day: number; readonly hour: number;
      readonly unfollowHour: number; readonly probationHour: number; readonly acceptsPerPass: number;
    };
    readonly sessions: readonly {
      readonly idx: number; readonly pace: number; readonly motion: number; readonly depth: number;
      readonly gap: {
        readonly targetMeanMs: number; readonly medianMs: number; readonly floorMs: number;
        readonly capMs: number; readonly timeScale: number;
      };
      readonly kinds: { readonly follow: number; readonly unfollow: number; readonly accept: number };
      readonly reads: { readonly profiles: number; readonly pages: number; readonly checks: number };
    }[];
  };
}

/** A session's pace factor as a word: a slower-than-reference session reads `relaxed`. */
export function paceLabel(pace: number): PaceWord {
  if (pace > 1.15) return 'relaxed';
  if (pace < 0.87) return 'quick';
  return 'normal';
}
