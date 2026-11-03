/**
 * The persisted Settings v2 document (spec §6.9, Appendix B.2), main only: plain
 * intent, sparse overrides `{value, setAt, basis}`, protection, preferences and
 * app state. Derived numbers are never stored; coercion lives in `doc-rules.ts`.
 */
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { Intent } from '@/shared/settings-intent';
import type { ParamValue, Prefs, ProtectionSettings, ProtectionState } from '@/shared/settings-model';
import type { ParamKey } from '@/shared/settings-params';
import type { MigrationNoteKind } from '@/shared/settings-view';

export interface OverrideEntry {
  /** What the user asked for; clamping happens at resolve time and is reported. */
  readonly value: ParamValue;
  readonly setAt: number;
  /** The recommendation when it was set: the override reads as stale once the recommendation moves. */
  readonly basis: ParamValue;
}

export type MigrationNote =
  | { readonly kind: 'bio-words-widened'; readonly words: number }
  | { readonly kind: 'verified-kept' }
  | { readonly kind: 'quiet-hours-derived' }
  | { readonly kind: 'quiet-hours-from-active-hours'; readonly start: number; readonly end: number }
  | { readonly kind: 'cleanup-own-follows-off' }
  | { readonly kind: 'cleanup-scheduled-now-gradual' }
  | { readonly kind: 'value-clamped'; readonly key: ParamKey; readonly from: number; readonly to: number }
  | { readonly kind: 'list-items-dropped'; readonly list: 'accounts' | 'words'; readonly count: number }
  | { readonly kind: 'legacy-pacing-retired' }
  /** off plus a schedule maps to the gentlest cleanup level. */
  | { readonly kind: 'cleanup-trickle-from-schedule' }
  | {
      readonly kind: 'faster-value-dropped';
      readonly key: 'pruneScan' | 'gapTypical' | 'gapMinimum' | 'checksEveryHours';
      readonly from: number;
    };

// The shared view restates the note kinds; both lists must stay one set.
type _NoteKindsAgree = [MigrationNote['kind']] extends [MigrationNoteKind]
  ? [MigrationNoteKind] extends [MigrationNote['kind']] ? true : never
  : never;
const _noteKindsAgree: _NoteKindsAgree = true;
void _noteKindsAgree;

export interface MigrationRecord {
  readonly at: number;
  readonly fromV1: { readonly mtimeMs: number; readonly sha256: string } | null;
  readonly notes: readonly MigrationNote[];
  /** The v1 sweep stamp, carried once to seed the reopen frontiers, then consumed. */
  readonly bookkeeping: {
    readonly forPk: string | null; readonly sweepLastRunAt: number | null;
    readonly sweepIntervalFactor: number | null; readonly pruneLastRunAt: number | null;
  } | null;
}

/** @transitional — the legacy pacer's knobs, deleted with every reader when the cadence switch lands. */
export interface LegacyCarry {
  readonly pacingModel: 'legacy' | 'organic';
  readonly minDelayMinutes: number;
  readonly maxDelayMinutes: number;
  readonly jitterPercent: number;
  readonly activeHoursStart: number;
  readonly activeHoursEnd: number;
}

export interface SettingsDocV2 {
  readonly v: 2;
  /** +1 on every persisted write. */
  readonly rev: number;
  readonly intent: Intent;
  /** '' = none. */
  readonly seed: string;
  readonly overrides: Readonly<Partial<Record<ParamKey, OverrideEntry>>>;
  readonly protection: ProtectionSettings;
  /** Persisted: a review survives restart. */
  readonly protectionState: ProtectionState;
  readonly prefs: Prefs;
  readonly app: {
    readonly mode: 'easy' | 'advanced'; readonly tourCompletedAt: number | null;
    readonly tourVersionSeen: string | null; readonly dismissedNotices: readonly string[];
  };
  readonly migration: MigrationRecord | null;
  /** @transitional — deleted with every reader when the cadence switch lands. */
  readonly legacyCarry: LegacyCarry | null;
}

/** The recommended choices: the balanced ordinals, derived quiet hours, cleanup of own follows off. */
export const RECOMMENDED_INTENT: Intent = {
  activity: 'moderate',
  caution: 'standard',
  rhythm: 'sessions',
  consistency: 'natural',
  dayShape: 'balanced',
  weeklyShape: 'realistic',
  quietHours: { kind: 'derived' },
  daysOff: [],
  patience: 'normal',
  mutuals: 'rotate',
  cleanup: 'off',
  audienceFocus: 'likely',
  audienceSize: 'everyday',
  preferPrivate: true,
};

/** A fresh install's document. */
export const DEFAULT_DOC: SettingsDocV2 = {
  v: 2,
  rev: 0,
  intent: RECOMMENDED_INTENT,
  seed: '',
  overrides: {},
  protection: { accounts: [], words: [], wordMatch: 'anywhere', keepVerified: true },
  protectionState: 'ready',
  prefs: {
    practice: false, acceptRequests: true, boost: { hours: SETTINGS_POLICY.BOOST.DEFAULT_HOURS, acceptRequests: true },
  },
  app: { mode: 'easy', tourCompletedAt: null, tourVersionSeen: null, dismissedNotices: [] },
  migration: null,
  legacyCarry: null,
};
