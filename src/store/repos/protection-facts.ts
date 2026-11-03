import type { AccountSuggestion, KeptRow } from '@/shared/settings-facts';
import type { SqliteDriver } from '../driver/driver';

/**
 * Read-only SQL behind the protection facts (spec §6.9, Appendix B.8): the accounts the own account follows
 * with their stored bios, account suggestions by prefix, and the kept table with its counts. Unknown stays
 * null (an absent bio, badge or follow-back edge), never a fabricated false.
 */

/** One followed account as the protection facts read it. */
export interface FollowingRow {
  readonly pk: string;
  readonly username: string | null;
  readonly bio: string | null;
  readonly isVerified: boolean | null;
  readonly followsUs: boolean | null;
}

const bool = (v: number | null): boolean | null => (v === null ? null : v !== 0);
const backOf = (status: string | null): boolean | null => (status === null ? null : status === 'active');
/** LIKE treats `_` and `%` as wildcards; usernames hold `_`. */
const likePrefix = (prefix: string): string => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const FOLLOWS_BACK = `(SELECT b.status FROM edges b WHERE b.src_pk = a_pk AND b.dst_pk = @own AND b.type = 'follows')`;
const WE_FOLLOW = `EXISTS (SELECT 1 FROM edges f WHERE f.src_pk = @own AND f.dst_pk = a_pk AND f.type = 'follows' AND f.status = 'active')`;

export class ProtectionFactsRepo {
  constructor(protected readonly db: SqliteDriver) {}

  /** Every account the own account follows (active edges), with its stored bio, badge and follow-back. */
  followingRows(ownPk: string): FollowingRow[] {
    const rows = this.db.prepare(
      `SELECT e.dst_pk AS pk, a.username AS username, a.bio AS bio, a.is_verified AS verified,
         ${FOLLOWS_BACK.replaceAll('a_pk', 'e.dst_pk')} AS back
       FROM edges e LEFT JOIN accounts a ON a.pk = e.dst_pk
       WHERE e.src_pk = @own AND e.type = 'follows' AND e.status = 'active'`,
    ).all({ own: ownPk }) as Array<{ pk: string; username: string | null; bio: string | null; verified: number | null; back: string | null }>;
    return rows.map((r) => ({ pk: r.pk, username: r.username, bio: r.bio, isVerified: bool(r.verified), followsUs: backOf(r.back) }));
  }

  /** Known accounts whose username starts with `prefix` (followed first, then the larger), at most `limit`. */
  suggest(ownPk: string, prefix: string, scope: 'following' | 'known', limit: number): (Omit<AccountSuggestion, 'protected'> & { readonly bio: string | null })[] {
    const rows = this.db.prepare(
      `SELECT a.pk AS pk, a.username AS username, a.followers AS followers, a.is_verified AS verified, a.bio AS bio,
         ${WE_FOLLOW.replaceAll('a_pk', 'a.pk')} AS you_follow, ${FOLLOWS_BACK.replaceAll('a_pk', 'a.pk')} AS back
       FROM accounts a
       WHERE a.username LIKE @prefix ESCAPE '\\' AND (@scope = 'known' OR ${WE_FOLLOW.replaceAll('a_pk', 'a.pk')})
       ORDER BY you_follow DESC, a.followers IS NULL, a.followers DESC, a.username
       LIMIT @limit`,
    ).all({ own: ownPk, prefix: likePrefix(prefix), scope, limit }) as Array<{
      pk: string; username: string; followers: number | null; verified: number | null; bio: string | null; you_follow: number; back: string | null;
    }>;
    return rows.map((r) => ({ pk: r.pk, username: r.username, youFollow: r.you_follow !== 0, followsYou: backOf(r.back),
      isVerified: bool(r.verified), followers: r.followers, bio: r.bio }));
  }

  /** One page of the kept records, the newest first, with the total. */
  keptPage(page: number, size: number): { rows: KeptRow[]; total: number } {
    const rows = this.db.prepare(
      `SELECT r.account_pk AS pk, a.username AS username, r.kept_reason AS reason, r.kept_match AS match,
         COALESCE(r.kept_at, r.reconciled_at, r.followed_at) AS kept_at, r.recheck_at AS recheck_at
       FROM follow_records r LEFT JOIN accounts a ON a.pk = r.account_pk
       WHERE r.state = 'kept'
       ORDER BY r.kept_at IS NULL, r.kept_at DESC, r.account_pk
       LIMIT @size OFFSET @offset`,
    ).all({ size, offset: page * size }) as Array<{
      pk: string; username: string | null; reason: string | null; match: string | null; kept_at: number | null; recheck_at: number | null;
    }>;
    return {
      rows: rows.map((r) => ({ pk: r.pk, username: r.username, reason: r.reason ?? '', match: r.match, keptAt: r.kept_at ?? 0, recheckAt: r.recheck_at })),
      total: this.keptCounts().total,
    };
  }

  /** How many records are kept, and how many of them only because a fact could not be read. */
  keptCounts(): { total: number; unreadable: number } {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN kept_reason LIKE 'unreadable-%' THEN 1 ELSE 0 END), 0) AS unreadable
       FROM follow_records WHERE state = 'kept'`,
    ).get() as { total: number; unreadable: number };
    return { total: r.total, unreadable: r.unreadable };
  }
}
