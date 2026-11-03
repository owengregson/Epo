import type { AwaySummary } from '../../shared/reopen-view';
import type { SqliteDriver } from '../driver/driver';
import type { MetaRepo } from './meta';

export type SweepMode = 'launch' | 'session' | 'check';

/** The notifications drawer's frontier: the newest server time read and the keys seen at it. */
export interface FeedWatermark {
  readonly atMs: number;
  readonly keysAtMs: readonly string[];
  readonly readAt: number;
  readonly filteredAt: number | null;
  readonly gap: { readonly fromAtMs: number; readonly toAtMs: number } | null;
}

/** The followers-head frontier: when the head was walked, its page size and the order self-check. */
export interface HeadFrontier {
  readonly walkedAt: number;
  readonly rowsPerPage: number | null;
  readonly order: {
    readonly verdict: 'newest-first' | 'unverified'; readonly pairs: number; readonly ordered: number; readonly at: number;
  };
  readonly contiguous: boolean;
}

export interface RequestsFrontier {
  readonly observedAt: number;
  readonly count: number;
  readonly complete: boolean;
  readonly verifiedDayKey: string | null;
}

/** The following check (step G): when the whole list was read, its count, and whether it was complete. */
export interface FollowingFrontier { readonly checkedAt: number; readonly count: number; readonly complete: boolean }

export interface SweepStamp { readonly id: number; readonly mode: SweepMode; readonly startedAt: number; readonly endedAt: number }

/** `meta.reopen_state` (spec §16.3); one writer, the frontier sweep, per step after its facts commit. */
export interface ReopenState {
  readonly v: 1;
  readonly feed: FeedWatermark | null;
  readonly head: HeadFrontier | null;
  readonly requests: RequestsFrontier | null;
  readonly lastSweep: SweepStamp | null;
  readonly lastCatchUp: AwaySummary | null;
  readonly following: FollowingFrontier | null;
}

/** How the repo reports a fault it recovers from (the facade logs it). */
export type StoreFault = (message: string, context: Record<string, unknown>) => void;

type Check = (v: unknown) => boolean;
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const str: Check = (v) => typeof v === 'string';
const bool: Check = (v) => typeof v === 'boolean';
const orNull = (c: Check): Check => (v) => v === null || c(v);
const oneOf = (...xs: readonly unknown[]): Check => (v) => xs.includes(v);
const listOf = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const shape = (fields: Record<string, Check>): Check => (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  && Object.entries(fields).every(([k, c]) => c((v as Record<string, unknown>)[k]));

const AWAY = shape({
  sweepId: num, from: num, to: num, isReturn: bool, followers: shape({ before: orNull(num), after: orNull(num) }),
  following: shape({ before: orNull(num), after: orNull(num), outsideEpo: orNull(num) }), newFollowers: num,
  followBacks: num, lostIdentified: num, unattributed: num, requestsWaiting: orNull(shape({ count: num, atLeast: bool })),
  gaps: shape({ feed: bool, head: bool }), backfilled: orNull(num), journalPending: num,
});
const STATE = shape({
  v: oneOf(1),
  feed: orNull(shape({ atMs: num, keysAtMs: listOf(str), readAt: num, filteredAt: orNull(num),
    gap: orNull(shape({ fromAtMs: num, toAtMs: num })) })),
  head: orNull(shape({ walkedAt: num, rowsPerPage: orNull(num), contiguous: bool,
    order: shape({ verdict: oneOf('newest-first', 'unverified'), pairs: num, ordered: num, at: num }) })),
  requests: orNull(shape({ observedAt: num, count: num, complete: bool, verifiedDayKey: orNull(str) })),
  lastSweep: orNull(shape({ id: num, mode: oneOf('launch', 'session', 'check'), startedAt: num, endedAt: num })),
  lastCatchUp: orNull(AWAY),
  following: orNull(shape({ checkedAt: num, count: num, complete: bool })),
});
const LEGACY_V1 = shape({ v: oneOf(1), lastActiveAt: orNull(num) });

/** JSON.parse that reports failure as `undefined`; every caller reports the fault itself. */
function parsed(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

/**
 * The reopen frontiers' home: a validated parse (a corrupt value logs an error and reads as absent:
 * a first-run sweep, no fabricated gains) and the one-time seed from the legacy `lifecycle_state`.
 */
export class ReopenStateRepo {
  constructor(
    protected readonly db: SqliteDriver,
    protected readonly meta: MetaRepo,
    protected readonly changed: () => void,
    private readonly fault: StoreFault,
  ) {}

  /** The stored frontier document, unparsed; `null` when none was written. */
  raw(): string | null {
    return this.meta.get('reopenState');
  }

  /** Replace the stored document; `null` deletes it. */
  setRaw(raw: string | null): void {
    this.meta.set('reopenState', raw);
  }

  get(): ReopenState | null {
    const raw = this.raw();
    if (raw === null) return null;
    const value = parsed(raw);
    if (STATE(value)) return value as ReopenState;
    this.fault('store: reopen_state unreadable, treated as absent', { length: raw.length });
    return null;
  }

  set(state: ReopenState): void {
    this.meta.setJson('reopenState', state);
    this.changed();
  }

  /**
   * Once, at the first build without a reopen state: the last sweep ends at the later of the v1
   * `lastActiveAt` and the carried settings stamp; `lifecycle_state` is then cleared, corrupt or not.
   */
  seedFromLegacy(carried: { readonly sweepLastRunAt: number | null }): ReopenState | null {
    return this.db.transaction(() => {
      if (this.raw() !== null) return this.get();
      const raw = this.meta.get('lifecycleState');
      let lastActiveAt: number | null = null;
      if (raw !== null) {
        const v1 = parsed(raw);
        this.meta.set('lifecycleState', null);
        if (!LEGACY_V1(v1)) {
          this.fault('store: lifecycle_state unreadable, nothing seeded', { length: raw.length });
          return null;
        }
        lastActiveAt = (v1 as { lastActiveAt: number | null }).lastActiveAt;
      }
      const stamps = [lastActiveAt, carried.sweepLastRunAt].filter((t): t is number => t !== null && Number.isFinite(t));
      if (stamps.length === 0) return null;
      const endedAt = Math.max(...stamps);
      const state: ReopenState = { v: 1, feed: null, head: null, requests: null, lastCatchUp: null, following: null,
        lastSweep: { id: 0, mode: 'check', startedAt: endedAt, endedAt } };
      this.set(state);
      return state;
    });
  }
}
