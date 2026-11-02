/**
 * SQL row shapes and their mappers to domain types.
 *
 * A row is what SQLite returns — snake_case, `null` for absent, `0`/`1` for
 * booleans. A domain type is what the rest of the app reads. Keeping the two
 * apart in one place is why no caller ever sees a raw column name, and why
 * `PRAGMA` drift shows up as a type error in exactly one file.
 */

import { boolOrUndef, numOrUndef, strOrUndef } from './sql-values';
import type {
  AccountState,
  Edge,
  EdgeType,
  EnrichmentLevel,
  FollowRecord,
  FollowState,
  Source,
  Target,
} from './types';

export interface AccountRow {
  pk: string;
  username: string | null;
  enrichment: string;
  followers: number | null;
  following: number | null;
  ratio: number | null;
  mutuals: number | null;
  is_private: number | null;
  is_verified: number | null;
  activity_signal: number | null;
  bio: string | null;
  role: string | null;
  enrich_failed_at: number | null;
  stats_observed_at: number | null;
  stats_source: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

export interface EdgeRow {
  src_pk: string;
  dst_pk: string;
  type: string;
  first_seen_at: number;
  last_confirmed_at: number;
  status: string;
}

export interface FollowRecordRow {
  account_pk: string;
  target_pk: string | null;
  state: string;
  followed_at: number | null;
  followed_back_at: number | null;
  hold_until: number | null;
  unfollow_due_at: number | null;
  retry_count: number;
  score: number | null;
  abandoned_at: number | null;
  healed_at: number | null;
  reconciled_at: number | null;
  followback_observed_at: number | null;
  unfollow_reason: string | null;
  queued_at: number | null;
  decision_version: string | null;
}

export interface TargetRow {
  account_pk: string;
  source: string;
  status: string;
  chain_index: number | null;
  exhausted_at: number | null;
}

export const rowToState = (row: AccountRow): AccountState => ({
  pk: row.pk,
  username: strOrUndef(row.username),
  enrichment: row.enrichment as EnrichmentLevel,
  followers: numOrUndef(row.followers),
  following: numOrUndef(row.following),
  ratio: numOrUndef(row.ratio),
  mutuals: numOrUndef(row.mutuals),
  isPrivate: boolOrUndef(row.is_private),
  isVerified: boolOrUndef(row.is_verified),
  activitySignal: numOrUndef(row.activity_signal),
  bio: strOrUndef(row.bio),
  role: strOrUndef(row.role),
  enrichFailedAt: numOrUndef(row.enrich_failed_at),
  statsObservedAt: numOrUndef(row.stats_observed_at),
  statsSource: strOrUndef(row.stats_source) as Source | undefined,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
});

export const rowToEdge = (row: EdgeRow): Edge => ({
  srcPk: row.src_pk,
  dstPk: row.dst_pk,
  type: row.type as EdgeType,
  firstSeenAt: row.first_seen_at,
  lastConfirmedAt: row.last_confirmed_at,
  status: row.status as 'active' | 'removed',
});

export const rowToTarget = (row: TargetRow): Target => ({
  accountPk: row.account_pk,
  source: row.source as Target['source'],
  status: row.status as Target['status'],
  chainIndex: row.chain_index,
  exhaustedAt: numOrUndef(row.exhausted_at),
});

export const rowToFollowRecord = (row: FollowRecordRow): FollowRecord => ({
  accountPk: row.account_pk,
  targetPk: row.target_pk,
  state: row.state as FollowState,
  followedAt: numOrUndef(row.followed_at),
  followedBackAt: numOrUndef(row.followed_back_at),
  holdUntil: numOrUndef(row.hold_until),
  unfollowDueAt: numOrUndef(row.unfollow_due_at),
  retryCount: row.retry_count,
  score: numOrUndef(row.score),
  abandonedAt: numOrUndef(row.abandoned_at),
  healedAt: numOrUndef(row.healed_at),
  reconciledAt: numOrUndef(row.reconciled_at),
  followbackObservedAt: numOrUndef(row.followback_observed_at),
  unfollowReason: strOrUndef(row.unfollow_reason) as FollowRecord['unfollowReason'],
  queuedAt: numOrUndef(row.queued_at),
  decisionVersion: strOrUndef(row.decision_version),
});
