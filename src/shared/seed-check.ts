/**
 * The seed check's typed result (spec §13): only an evidence-backed
 * `not-found` is a verdict; `queued` and `unreadable` never read as "not found".
 * The `seed:check` wire keeps the older shape until the Settings stage lands,
 * mapped down by {@link toLegacySeedCheck}. Pure.
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

/** The older wire shape the current Settings view reads (`r.exists`, `r.reason`). */
export interface LegacySeedCheck {
  ok: boolean;
  exists: boolean;
  followersVisible: boolean;
  isPrivate: boolean;
  reason?: string;
}

/** The refusal reasons the older shape carried, per queue reason. */
const QUEUED_REASON: Readonly<Record<SeedQueueReason, string>> = {
  engine: 'engine-running',
  prune: 'prune-running',
  manual: 'manual-running',
  'runtime-blocked': 'runtime-not-ready',
  offline: 'offline',
  'signed-out': 'not-logged-in',
  'read-budget': 'read-budget',
  starting: 'runtime-not-ready',
};

/** Map a typed result down to the older wire shape, reason strings included. */
export function toLegacySeedCheck(r: SeedCheckResult): LegacySeedCheck {
  const refused = (reason: string): LegacySeedCheck =>
    ({ ok: false, exists: false, followersVisible: false, isPrivate: false, reason });
  switch (r.kind) {
    case 'ok':
      return {
        ok: true, exists: true, followersVisible: r.followersVisible, isPrivate: r.isPrivate,
        reason: r.followersVisible ? undefined : 'private',
      };
    case 'not-found':
      return refused('not-found');
    case 'queued':
      return refused(QUEUED_REASON[r.why]);
    case 'unreadable':
      return refused(r.why === 'walled' || r.why === 'challenge' ? 'blocked' : r.why === 'signed-out' ? 'not-logged-in' : 'error');
    case 'invalid-handle':
      return refused('empty');
  }
}
