/**
 * The store-derived Settings facts (spec §6.9, Appendix B.6): the seed status,
 * protection counts, the kept table and account suggestions. A projection row,
 * so it is honest-unknown (`built: false`) before the store opens. Pure types.
 */
import type { SeedQueueReason } from './seed-check';

export interface SettingsFacts {
  /** false before the store opens: every field is honest-unknown. */
  readonly built: boolean;
  readonly seed: SeedStatus;
  readonly ownAccount: { readonly isPrivate: boolean | null };
  readonly protection: ProtectionFacts | null;
  readonly cleanup: {
    readonly census: {
      readonly at: number; readonly candidates: number; readonly protectedAmong: number;
      readonly verifiedComplete: boolean; readonly tooLarge: boolean;
    } | null;
  } | null;
}

export interface ProtectionFacts {
  /** Accounts Epo has seen you follow (active edges). */
  readonly followingKnown: number | null;
  readonly protectedFollowing: number;
  readonly byRule: { readonly account: number; readonly verified: number; readonly bioWord: number };
  /** Folded word → count. */
  readonly byWord: Readonly<Record<string, number>>;
  /** Followed accounts with no stored bio. */
  readonly bioUnread: number;
  readonly entries: Readonly<Record<string, {
    readonly status: 'linked' | 'not-seen' | 'not-followed' | 'invalid';
    readonly currentUsername: string | null; readonly youFollow: boolean | null; readonly followsYou: boolean | null;
  }>>;
  readonly kept: { readonly total: number; readonly unreadable: number };
}

export type SeedStatus =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unseen'; readonly handle: string }
  | {
      readonly kind: 'seen'; readonly handle: string; readonly pk: string; readonly currentUsername: string;
      readonly observedAt: number; readonly followers: number | null; readonly isPrivate: boolean | null;
      readonly followersVisible: boolean | null;
    }
  | { readonly kind: 'checking'; readonly handle: string }
  | { readonly kind: 'queued'; readonly handle: string; readonly why: SeedQueueReason }
  | { readonly kind: 'gone'; readonly handle: string; readonly at: number; readonly evidence: 'profile-absent' | 'page-text' };

export interface AccountSuggestion {
  readonly pk: string;
  readonly username: string;
  readonly youFollow: boolean;
  readonly followsYou: boolean | null;
  readonly isVerified: boolean | null;
  readonly followers: number | null;
  readonly protected: boolean;
}
export type SuggestResult = { readonly kind: 'ok'; readonly rows: readonly AccountSuggestion[] } | { readonly kind: 'unavailable' };

export interface KeptRow {
  readonly pk: string;
  readonly username: string | null;
  readonly reason: string;
  readonly match: string | null;
  readonly keptAt: number;
  readonly recheckAt: number | null;
}
export type KeptPageResult =
  | { readonly kind: 'ok'; readonly rows: readonly KeptRow[]; readonly total: number }
  | { readonly kind: 'unavailable' };
