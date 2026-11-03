/**
 * The Settings v2 model shared by main and the renderer (Appendix B.1):
 * protection, preferences and parameter values. Pure, no imports.
 */

export interface ProtectedAccount {
  readonly pk: string | null;
  /** Normalized: trimmed, no '@', lowercase. */
  readonly username: string;
  /** pk and username confirmed together: the entry then matches by pk only. */
  readonly linkedAt: number | null;
  /** Display only. */
  readonly formerUsernames: readonly string[];
  readonly addedAt: number;
  readonly source: 'you' | 'migrated' | 'older-version' | 'prune-page';
  /** false: not a handle (migrated and kept, never dropped). */
  readonly valid: boolean;
}

export interface KeepWord {
  readonly text: string;
  readonly addedAt: number;
}

export interface ProtectionSettings {
  readonly accounts: readonly ProtectedAccount[];
  readonly words: readonly KeepWord[];
  readonly wordMatch: 'anywhere' | 'whole-word';
  readonly keepVerified: boolean;
}

export type ProtectionState = 'ready' | 'needs-review' | 'unavailable';

export interface Prefs {
  /** Engine name: dryRun. */
  readonly practice: boolean;
  /** Engine name: autoAcceptFollowRequests. */
  readonly acceptRequests: boolean;
  readonly boost: { readonly hours: number; readonly acceptRequests: boolean };
}

export interface RatioCurve {
  readonly hardLow: number;
  readonly bandLow: number;
  readonly peakLow: number;
  readonly peakHigh: number;
  readonly bandHigh: number;
  readonly hardHigh: number;
}

export type ParamValue = number | boolean | { readonly min: number; readonly max: number } | RatioCurve;
