import { ACCOUNTS } from '../schema/manifest';
import { upsertSql } from '../schema/tables';
import { boolToInt, orNull } from '../sql-values';
import type { AccountState } from '../types';

/** A bound value SQLite accepts for one `accounts` column. */
type ColumnValue = string | number | null;

/**
 * One column of the `accounts` projection table, from the WRITE side.
 *
 * `read` is what the `observe()` upsert binds for it. A column with no `read`
 * is still part of the table but is written by its own path — `role` by
 * {@link KnowledgeStore.setRole}, `enrich_failed_at` by the failure marker and
 * by the heal clause in the upsert's `ON CONFLICT` tail.
 */
export interface AccountColumn {
  column: string;
  read?: (state: AccountState) => ColumnValue;
}

/**
 * Every column of `accounts`, with the projection field each one binds.
 *
 * The COLUMNS themselves are declared once in `schema/tables.ts` (types,
 * nullability, defaults, the boot-time `PRAGMA table_info` assertion); this
 * array adds the only thing a table def cannot know — which part of an
 * `AccountState` each column carries. The two are checked against each other
 * at module load, so adding a column to the manifest without teaching the
 * upsert about it fails immediately rather than silently writing NULLs.
 */
export const ACCOUNT_COLUMNS: AccountColumn[] = [
  { column: 'pk', read: (s) => s.pk },
  { column: 'username', read: (s) => orNull(s.username) },
  { column: 'enrichment', read: (s) => s.enrichment },
  { column: 'followers', read: (s) => orNull(s.followers) },
  { column: 'following', read: (s) => orNull(s.following) },
  { column: 'ratio', read: (s) => orNull(s.ratio) },
  { column: 'mutuals', read: (s) => orNull(s.mutuals) },
  { column: 'is_private', read: (s) => boolToInt(s.isPrivate) },
  { column: 'is_verified', read: (s) => boolToInt(s.isVerified) },
  { column: 'activity_signal', read: (s) => orNull(s.activitySignal) },
  { column: 'bio', read: (s) => orNull(s.bio) },
  { column: 'stats_observed_at', read: (s) => orNull(s.statsObservedAt) },
  { column: 'stats_source', read: (s) => orNull(s.statsSource) },
  { column: 'first_seen_at', read: (s) => s.firstSeenAt },
  { column: 'last_seen_at', read: (s) => s.lastSeenAt },
  // Written elsewhere; listed so this array still describes the whole table.
  { column: 'role' },
  { column: 'enrich_failed_at' },
];

// The bridge between the two declarations, checked once at load.
{
  const declared = new Set(Object.keys(ACCOUNTS.columns));
  const mapped = new Set(ACCOUNT_COLUMNS.map((c) => c.column));
  const missing = [...declared].filter((c) => !mapped.has(c));
  const extra = [...mapped].filter((c) => !declared.has(c));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `store: the accounts write manifest disagrees with schema/tables.ts ` +
        `(unmapped: ${missing.join(', ') || 'none'}; unknown: ${extra.join(', ') || 'none'})`,
    );
  }
}

/** The columns `observe()` binds, in manifest order. */
const UPSERT = ACCOUNT_COLUMNS.filter((c): c is Required<AccountColumn> => c.read !== undefined);

/**
 * The account upsert, generated from the table def plus the manifest order —
 * so the column list, the `VALUES` list, the `ON CONFLICT … SET` list and the
 * bound parameters cannot drift out of step the way four hand-maintained lists
 * did.
 *
 * The tail is hand-written on purpose: a successful stats read heals the
 * enrichment-failure marker (the account is demonstrably fetchable again),
 * which is POLICY, not a column mapping, and generated SQL is the wrong place
 * for policy.
 */
export const ACCOUNT_UPSERT_SQL = upsertSql(ACCOUNTS, {
  columns: UPSERT.map((c) => c.column),
  conflict: ['pk'],
  tail: [
    `enrich_failed_at = CASE WHEN excluded.followers IS NOT NULL
                             THEN NULL ELSE accounts.enrich_failed_at END`,
  ],
});

/** The bound parameters for {@link ACCOUNT_UPSERT_SQL}, keyed by column name. */
export const accountUpsertParams = (state: AccountState): Record<string, ColumnValue> =>
  Object.fromEntries(UPSERT.map((c) => [c.column, c.read(state)]));
