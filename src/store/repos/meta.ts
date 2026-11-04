import type { SqliteDriver } from '../driver/driver';

/**
 * Every durable scalar the app keeps in the `meta` key/value table (migration
 * 5), with each key string written exactly once. A new durable scalar is one
 * line here plus its accessor on `KnowledgeStore` — never a fresh column and
 * never a raw string at a call site.
 */
export const META_KEYS = {
  /** Inter-action paced-delay deadline, epoch ms. */
  actionDelayDeadlineAt: 'action_delay_deadline_at',
  /** The retired planner's snapshot: read once to migrate the day plan's phase, then cleared. */
  pacingState: 'pacing_state',
  /** Per-install 32-bit noise seed, drawn once on first access. */
  installEntropy: 'install_entropy',
  /** Recovery-ladder state; opaque JSON owned by RecoverySupervisor. */
  recoveryState: 'recovery_state',
  /** Last CLOSED recovery incident; opaque JSON owned by recovery.ts. */
  recoveryLastIncident: 'recovery_last_incident',
  /** Moment follower measurement began — the stock/growth boundary. */
  followersBaselineAt: 'followers_baseline_at',
  /** Set-once marker that a FIRST complete followers census has run. */
  followersCensusAt: 'followers_census_at',
  /** Last COMPLETE prune census; JSON `PruneCensusRecord`. */
  pruneLastCensus: 'prune_last_census',
  lifecycleState: 'lifecycle_state',
  sourceFrontierState: 'source_frontier_state',
  lifecycleHealthState: 'lifecycle_health_state',
  readBudgetState: 'read_budget_state',
  /** The day plan, its phase offset and the Boost window; raw JSON validated by the plan service. */
  planState: 'plan_state',
  /** The reopen frontiers; raw JSON owned by the frontier sweep. */
  reopenState: 'reopen_state',
  /** Set-once stamp of the follower change log's deterministic backfill. */
  followerChangesBackfilledAt: 'follower_changes_backfilled_at',
  /** The surface latency reservoir; raw JSON owned by the surface sink. */
  surfaceMeter: 'surface_meter',
} as const;

export type MetaKey = keyof typeof META_KEYS;

/**
 * The `meta` table, behind a typed key manifest. Holds no policy: callers on
 * the `KnowledgeStore` facade own defaults, logging, and mutation pulses.
 */
export class MetaRepo {
  constructor(private readonly db: SqliteDriver) {}

  /** The stored string, or `null` when the key is unset. */
  get(key: MetaKey): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEYS[key]) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Upsert; `null` deletes the key. */
  set(key: MetaKey, value: string | null): void {
    if (value === null) {
      this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(META_KEYS[key]);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(META_KEYS[key], value);
  }

  /** Set-once write: an existing value is never overwritten (baseline semantics). */
  setOnce(key: MetaKey, value: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`)
      .run(META_KEYS[key], value);
  }

  /**
   * The stored value parsed as a finite number. `null` when unset OR when the
   * stored text does not parse — a corrupt scalar reads as absent, never as a
   * fabricated `0`/`NaN` that would silently skew a deadline or baseline.
   */
  number(key: MetaKey): number | null {
    const raw = this.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /** Store a number; `null` deletes the key. */
  setNumber(key: MetaKey, value: number | null): void {
    this.set(key, value === null ? null : String(value));
  }

  /**
   * The stored value parsed as JSON. A corrupt own-write THROWS out of
   * `JSON.parse` rather than fabricating an empty record (no silent catches).
   */
  json<T>(key: MetaKey): T | null {
    const raw = this.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  /** Store a JSON-encoded value; `null` deletes the key. */
  setJson(key: MetaKey, value: unknown): void {
    this.set(key, value === null ? null : JSON.stringify(value));
  }
}
