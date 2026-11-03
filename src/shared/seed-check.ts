/**
 * The seed check's typed result (spec §13), as `seed:check` answers it: only an evidence-backed
 * `not-found` is a verdict; `queued` and `unreadable` never read as "not found". Pure.
 */

export type SeedQueueReason =
  | 'engine' | 'prune' | 'manual' | 'runtime-blocked' | 'offline' | 'signed-out' | 'read-budget' | 'starting';

export type SeedCheckResult =
  | {
      readonly kind: 'ok'; readonly pk: string; readonly isPrivate: boolean; readonly followersVisible: boolean;
      readonly followers: number | null; readonly observedAt: number; readonly fromStore: boolean;
    }
  | { readonly kind: 'not-found'; readonly evidence: 'profile-absent' | 'page-text'; readonly observedAt: number }
  | { readonly kind: 'queued'; readonly why: SeedQueueReason }
  | {
      readonly kind: 'unreadable';
      readonly why: 'walled' | 'signed-out' | 'challenge' | 'no-answer' | 'aborted' | 'drift' | 'error';
    }
  | { readonly kind: 'invalid-handle' };
