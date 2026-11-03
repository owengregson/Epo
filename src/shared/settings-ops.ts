/**
 * The one write vocabulary of Settings v2 (spec §6.7, Appendix B.5): ops apply
 * atomically, in order, through the settings service; results are typed and a
 * `saved` result carries the ops that undo it. Renderer-safe types only.
 */
import type { Intent, IntentKey } from './settings-intent';
import type { KeepWord, ParamValue, ProtectedAccount } from './settings-model';
import type { ParamKey, SectionId } from './settings-params';
import type { SettingsView } from './settings-view';

type IntentOp = { [K in IntentKey]: { readonly op: 'intent'; readonly key: K; readonly value: Intent[K] } }[IntentKey];

export type SettingsOp =
  | IntentOp
  | { readonly op: 'override'; readonly key: ParamKey; readonly value: ParamValue }
  | { readonly op: 'clear-override'; readonly key: ParamKey }
  /** '' clears the seed. */
  | { readonly op: 'seed'; readonly handle: string }
  | {
      readonly op: 'protect-add';
      readonly entries: readonly { readonly username: string; readonly pk?: string }[];
      readonly source: ProtectedAccount['source'];
    }
  | { readonly op: 'protect-remove'; readonly match: { readonly pk?: string; readonly username?: string } }
  | { readonly op: 'protect-restore'; readonly accounts: readonly ProtectedAccount[]; readonly words: readonly KeepWord[] }
  | { readonly op: 'word-add'; readonly texts: readonly string[] }
  | { readonly op: 'word-remove'; readonly text: string }
  | { readonly op: 'protect-rule'; readonly rule: 'keepVerified'; readonly value: boolean }
  | { readonly op: 'protect-rule'; readonly rule: 'wordMatch'; readonly value: 'anywhere' | 'whole-word' }
  /** System only. */
  | { readonly op: 'protect-link'; readonly pk: string; readonly username: string; readonly at: number }
  | { readonly op: 'pref'; readonly key: 'practice' | 'acceptRequests' | 'boost.acceptRequests'; readonly value: boolean }
  | { readonly op: 'pref'; readonly key: 'boost.hours'; readonly value: number }
  | { readonly op: 'ui'; readonly mode: 'easy' | 'advanced' }
  | { readonly op: 'tour-completed'; readonly at: number }
  | { readonly op: 'tour-version-seen'; readonly version: string }
  | { readonly op: 'dismiss-notice'; readonly id: string }
  /** needs-review or unavailable → ready. */
  | { readonly op: 'acknowledge-protection' }
  /** Union only: additions made in an older build. */
  | { readonly op: 'import-older-version' }
  /** The recovery ops after a refused migration, and the deliberate re-migration. */
  | { readonly op: 'migration'; readonly action: 'retry' | 'start-from-recommended' | 'remigrate-from-v1' }
  /** System only. */
  | { readonly op: 'consume-bookkeeping' }
  | {
      readonly op: 'reset';
      readonly scope: { readonly kind: 'recommended' } | { readonly kind: 'section'; readonly section: SectionId };
    };

export type SettingsOpName = SettingsOp['op'];

export type SettingsSaveResult =
  | {
      readonly kind: 'saved'; readonly view: SettingsView; readonly adjustments: readonly Adjustment[];
      readonly conflicts: readonly OverrideConflict[]; readonly applies: readonly ApplyNote[];
      readonly inverse: readonly SettingsOp[];
    }
  /** Nothing changed. */
  | { readonly kind: 'not-saved'; readonly view: SettingsView; readonly detail: string }
  | {
      readonly kind: 'refused'; readonly view: SettingsView;
      readonly reason: 'invalid' | 'internal' | 'migration-pending' | 'protection-not-migrated';
      readonly detail: string;
    };

export interface Adjustment {
  readonly key: ParamKey | IntentKey | 'seed' | 'protection' | 'prefs.boost.hours';
  readonly requested: unknown;
  readonly applied: unknown;
  readonly because: 'above-safe-max' | 'below-safe-min' | 'kept-order' | 'coupled-bound' | 'not-an-option' | 'normalized';
}

export interface OverrideConflict {
  readonly key: ParamKey;
  readonly yours: ParamValue;
  readonly recommendedBefore: ParamValue;
  readonly recommendedNow: ParamValue;
}

export interface ApplyNote {
  readonly what: 'applies-now' | 'replanned-today' | 'from-tomorrow' | 'after-restart' | 'records-kept' | 'records-released';
  readonly count?: number;
}

export type SettingsPreviewResult =
  | {
      readonly kind: 'ok'; readonly view: SettingsView; readonly changes: readonly ChangeLine[];
      readonly conflicts: readonly OverrideConflict[]; readonly adjustments: readonly Adjustment[];
    }
  | { readonly kind: 'unavailable' };

export interface ChangeLine {
  readonly key: ParamKey | IntentKey | 'seed' | 'prefs.practice';
  readonly before: string | number | boolean;
  readonly after: string | number | boolean;
  readonly loosensUnfollows: boolean;
}
