/**
 * What the Settings stage renders (spec §6.9, Appendix B.4): the view main
 * computes per revision (every number included), its previews and the basis
 * catalog. Renderer-safe types only.
 */
import type {
  ActivityLevel, AudienceFocus, AudienceSize, Caution, CleanupLevel, Consistency, DayOfWeek, DayShape,
  Intent, IntentKey, PaceCardId, Patience, Rhythm,
} from './settings-intent';
import type { ParamValue, Prefs, ProtectionSettings, ProtectionState, RatioCurve } from './settings-model';
import type { ApplyWhen, ParamKey, ParamKind, ParamRisk, ParamUnit, RiskLevel, SectionId } from './settings-params';

/** Set by main as each dependency is wired; the renderer hides what is not yet true. */
export interface SettingsCapabilities {
  readonly plan: boolean;
  readonly tempo: boolean;
  readonly boost: boolean;
  readonly protectionEverywhere: boolean;
}

export type SettingsHealth =
  | { readonly kind: 'ok' }
  | { readonly kind: 'migrated'; readonly at: number }
  | { readonly kind: 'restored-from-backup'; readonly quarantined: string }
  | { readonly kind: 'remigrated-from-v1'; readonly quarantined: string | null }
  | { readonly kind: 'defaults-after-unreadable'; readonly quarantined: string | null }
  | { readonly kind: 'migration-refused'; readonly detail: string };

/** The migration notes' kinds (the document's `MigrationNote` union keys on these). */
export type MigrationNoteKind =
  | 'bio-words-widened' | 'verified-kept' | 'quiet-hours-derived' | 'quiet-hours-from-active-hours'
  | 'cleanup-own-follows-off' | 'cleanup-scheduled-now-gradual' | 'value-clamped' | 'list-items-dropped'
  | 'legacy-pacing-retired' | 'cleanup-trickle-from-schedule' | 'faster-value-dropped';

export interface SettingsView {
  readonly rev: number;
  readonly health: SettingsHealth;
  readonly capabilities: SettingsCapabilities;
  readonly mode: 'easy' | 'advanced';
  readonly intent: Intent;
  readonly seed: string;
  readonly protection: ProtectionSettings;
  readonly protectionState: ProtectionState;
  readonly prefs: Prefs;
  readonly easy: EasyMatch;
  /** Numbers for every choice (instant hover, no IPC). */
  readonly options: OptionPreviews;
  readonly typical: TypicalDay;
  /** Every ParamKey whose capability is on. */
  readonly params: readonly ParamView[];
  readonly reads: ReadAllowanceView;
  readonly overrides: {
    readonly count: number; readonly stale: number;
    readonly bySection: Readonly<Partial<Record<SectionId, number>>>;
  };
  /** What other views may read. */
  readonly effective: EffectiveSummary;
  readonly notices: readonly SettingsNotice[];
  readonly app: { readonly tourCompletedAt: number | null };
}

export interface EasyMatch {
  readonly pace: PaceCardId | 'custom';
  /** custom ⇔ an `audience.followerRange` override. */
  readonly size: AudienceSize | 'custom';
  /** custom ⇔ an `audience.ratioCurve` override. */
  readonly focus: AudienceFocus | 'custom';
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
}

export type Feasibility =
  | { readonly kind: 'ok'; readonly reachablePerDay: number }
  | { readonly kind: 'short'; readonly reachablePerDay: number; readonly binding: 'hourly-cap' | 'active-time' };

export interface DayNumbers { readonly typical: number; readonly low: number; readonly high: number }

export interface PaceOption {
  readonly id: PaceCardId | ActivityLevel;
  readonly perDay: DayNumbers;
  readonly perHourMax: number;
  readonly shareOfLowWall: number;
  readonly risk: RiskLevel;
  readonly feasibility: Feasibility;
}

export interface ScheduleOption {
  readonly dayShape: DayShape;
  /** 24 hourly intensities, 0..1. */
  readonly intensity: readonly number[];
  readonly quiet: { readonly startMinute: number; readonly endMinute: number } | null;
  readonly feasibility: Feasibility;
}

export interface OptionPreviews {
  /** gentle, balanced, faster (Easy shows perDay only). */
  readonly paceCards: readonly PaceOption[];
  readonly activity: Readonly<Record<ActivityLevel, PaceOption>>;
  readonly caution: Readonly<Record<Caution, { readonly hourlyCap: number; readonly minGapSeconds: number }>>;
  readonly rhythm: Readonly<Record<Rhythm, {
    readonly sessions: { readonly min: number; readonly max: number }; readonly gapSeconds: number;
  }>>;
  readonly consistency: Readonly<Record<Consistency, { readonly variationPct: number; readonly restDayPct: number }>>;
  readonly schedule: readonly ScheduleOption[];
  readonly patience: Readonly<Record<Patience, { readonly waitDays: number; readonly holdDays: number }>>;
  readonly cleanup: Readonly<Record<CleanupLevel, { readonly share: number }>>;
  readonly size: Readonly<Record<AudienceSize, { readonly min: number; readonly max: number }>>;
  readonly focus: Readonly<Record<AudienceFocus, RatioCurve>>;
  readonly boostHours: { readonly choices: readonly number[]; readonly min: number; readonly max: number };
}

export interface TypicalDay {
  /** The day law's p10 / median / p90, never a median scaled by a spread. */
  readonly perDay: DayNumbers;
  /** The most Epo does automatically in a day. */
  readonly automaticMax: number;
  readonly ceiling: number;
  /** Shown in Advanced only. */
  readonly perHourMax: number;
  readonly sessions: { readonly min: number; readonly max: number };
  readonly shareOfLowWall: number;
  readonly risk: RiskLevel;
  readonly feasibility: Feasibility;
  /** The week ahead; null until the plan capability is on. */
  readonly week: readonly PlanPreviewDay[] | null;
}

export interface PlanPreviewDay {
  readonly dayKey: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly restDay: boolean;
  readonly dayOff: boolean;
  readonly total: number;
  readonly follows: number;
  readonly unfollows: number;
  readonly sessions: readonly { readonly startAt: number; readonly endAt: number; readonly budget: number }[];
}

export interface ParamView {
  readonly key: ParamKey;
  readonly section: SectionId;
  readonly kind: ParamKind;
  readonly unit: ParamUnit;
  readonly step: number;
  /** Effective. */
  readonly value: ParamValue;
  /** Derived from intent and the effective upstreams. */
  readonly recommended: ParamValue;
  readonly override: {
    readonly requested: ParamValue; readonly setAt: number; readonly clamped: boolean;
    readonly stale: boolean; readonly basis: ParamValue;
  } | null;
  readonly bounds: ParamBounds;
  readonly risk: ParamRisk;
  readonly applies: ApplyWhen;
  readonly source: 'derived' | 'recommended' | 'plan';
  readonly inactive: 'mutuals-kept' | 'cleanup-off' | null;
  readonly provenance: readonly ProvenanceStep[];
}

export type ParamBounds =
  | { readonly kind: 'number' | 'range' | 'curve'; readonly min: number; readonly max: number }
  | { readonly kind: 'bool' };

export type ProvenanceStep =
  | { readonly kind: 'fundamental'; readonly key: string; readonly value: number; readonly unit: string; readonly rev: string }
  | { readonly kind: 'policy'; readonly key: string; readonly value: number }
  | { readonly kind: 'choice'; readonly intent: IntentKey; readonly value: string }
  | { readonly kind: 'param'; readonly key: ParamKey; readonly value: number }
  | { readonly kind: 'op'; readonly op: 'times' | 'divide' | 'round' | 'ceil' | 'min' | 'max' };

/** The read allowance per plan-day (read-only), with its trailing-24 h backstop. */
export interface ReadAllowanceView {
  readonly profiles: number;
  readonly explorationProfiles: number;
  readonly listPages: number;
  readonly explorationPages: number;
  readonly notifications: number;
  readonly window: 'plan-day';
  readonly backstop: 'trailing-24h';
}

/** One row of the Under-the-hood catalog: every kernel tier-1 entry. */
export interface BasisRow {
  readonly id: string;
  readonly group: 'fundamental' | 'policy' | 'bound' | 'derived' | 'registry' | 'motion';
  readonly value: number | string;
  readonly unit: string | null;
  readonly tier: string | null;
  readonly src: string | null;
  readonly rev: string | null;
  readonly module: string;
  readonly guard: string | null;
}
export type BasisResult = { readonly kind: 'ok'; readonly rows: readonly BasisRow[] } | { readonly kind: 'unavailable' };

export interface EffectiveSummary {
  readonly seed: string;
  readonly practice: boolean;
  readonly acceptRequests: boolean;
  readonly waitDays: number;
  /** null: people who follow back are kept. */
  readonly holdDays: number | null;
  readonly dailyVolume: number;
  readonly dailyCeiling: number;
  readonly hourlyCap: number;
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
  readonly daysOff: readonly DayOfWeek[];
  readonly cleanup: CleanupLevel;
  readonly boostDefaultHours: number;
}

export interface SettingsNotice {
  readonly id: string;
  readonly tone: 'info' | 'warning' | 'error';
  readonly kind:
    | MigrationNoteKind | 'migrated' | 'restored-backup' | 'unreadable-defaults' | 'needs-review'
    | 'older-version-changed' | 'override-stale' | 'everything-in-advanced' | 'migration-refused';
  readonly data: Readonly<Record<string, string | number>>;
  readonly dismissible: boolean;
}
