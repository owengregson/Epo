/**
 * Chronos — every deadline, hold and cadence in the app as one durable row.
 *
 * docs/PRINCIPLES.md §3 ("schedules are durable") is a rule each caller
 * currently re-implements against its own meta key: stamp a last-run, compare
 * it at boot, remember to serve the REMAINDER of a hold rather than restarting
 * it. Chronos makes it a property of one query. `due(now)` returns everything
 * whose absolute deadline has passed, oldest first, so work that came due while
 * the app was closed comes back FIRST — it cannot be forgotten by a caller who
 * did not think to check.
 *
 * Two disciplines keep it honest:
 *
 *  - `due_at` is ABSOLUTE, with any timing noise already applied. A restart
 *    reads the instant, never a remaining duration, so a relaunch mid-hold can
 *    never act sooner than the wall it was backing off from.
 *  - Persist a timer IFF losing it would let the app act sooner than it should.
 *    `hold | cadence | deadline` persist; idle beats, scroll rests and other
 *    sub-cadence waits stay in memory, where losing them across a relaunch is
 *    the correct behaviour.
 *
 * The promise half of the design (`await(id, scope)`) belongs to the runtime
 * kernel in wave B. What lives here is its durable substrate plus
 * {@link Chronos.awaitable}, which hands a caller the absolute deadline so it
 * can wait through its own sleep today.
 */

import type { SqliteDriver } from './driver/driver';
import { TIMERS } from './schema/manifest';
import { decodeRow, type RowOf, upsertSql } from './schema/tables';

/** What the timer is for. All three persist; nothing else does. */
export type TimerKind = 'deadline' | 'cadence' | 'hold';

/** What a relaunch owes a timer that came due while the app was closed. */
export type OverduePolicy = 'run-once' | 'skip' | 'catch-up';

/** One armed timer, as the store holds it. */
export interface Timer {
  readonly id: string;
  /** The owning scope. `cancel()` takes an id OR an owner prefix. */
  readonly owner: string;
  readonly kind: TimerKind;
  /** ParkReason | HaltReason | RefusalCause — the vocabulary spans share. */
  readonly reason: string;
  readonly armedAt: number;
  /** ABSOLUTE epoch ms, noise already applied. */
  readonly dueAt: number;
  /** The pre-noise interval, so a derivation test can audit the draw. */
  readonly baseMs: number;
  readonly noiseClass: string;
  /** Boundary seed key: a restart redraws the SAME instant. */
  readonly seed: string | undefined;
  readonly cadenceMs: number | undefined;
  readonly lastRunAt: number | undefined;
  readonly overduePolicy: OverduePolicy;
  readonly generation: number;
  readonly spanId: string | undefined;
}

/** What {@link Chronos.arm} takes. Give `dueAt` or `inMs`, never neither. */
export interface TimerSpec {
  id: string;
  owner: string;
  kind: TimerKind;
  reason: string;
  /** Absolute deadline. Takes precedence over `inMs`. */
  dueAt?: number;
  /** Relative deadline from the injected clock. */
  inMs?: number;
  /** Pre-noise interval; defaults to the relative distance actually armed. */
  baseMs?: number;
  noiseClass?: string;
  seed?: string;
  cadenceMs?: number;
  lastRunAt?: number;
  overduePolicy?: OverduePolicy;
  generation?: number;
  spanId?: string;
}

/** A repeating timer, as {@link Chronos.cadence} reports it. */
export interface Cadence {
  readonly id: string;
  readonly everyMs: number;
  /** ABSOLUTE next-due instant — in the PAST when the app missed a turn. */
  readonly dueAt: number;
  readonly lastRunAt: number | undefined;
  /** True when `dueAt` has already passed: §3's "run it first" signal. */
  readonly overdue: boolean;
}

export interface ChronosOptions {
  /** Wall clock; injectable so a suite can pin every deadline. */
  now?: () => number;
}

type TimerRow = RowOf<typeof TIMERS>;

const ARM_SQL = upsertSql(TIMERS, {
  conflict: ['id'],
  // A re-arm replaces the schedule but never forgets that the timer has RUN;
  // that stamp is what makes a cadence resume rather than restart.
  expr: { last_run_at: 'COALESCE(excluded.last_run_at, timers.last_run_at)' },
});

const SELECT = `SELECT ${Object.keys(TIMERS.columns).join(', ')} FROM timers`;

const toTimer = (row: TimerRow): Timer => {
  const v = decodeRow(TIMERS, row);
  return {
    id: v.id,
    owner: v.owner,
    kind: v.kind as TimerKind,
    reason: v.reason,
    armedAt: v.armed_at,
    dueAt: v.due_at,
    baseMs: v.base_ms,
    noiseClass: v.noise_class,
    seed: v.seed,
    cadenceMs: v.cadence_ms,
    lastRunAt: v.last_run_at,
    overduePolicy: v.overdue_policy as OverduePolicy,
    generation: v.generation,
    spanId: v.span_id,
  };
};

export class Chronos {
  private readonly now: () => number;

  constructor(
    private readonly db: SqliteDriver,
    opts: ChronosOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Arm (or re-arm) a timer. IDEMPOTENT BY ID — a second `arm` with the same
   * id replaces the schedule rather than creating a rival row, which is what
   * lets a boot path re-declare every timer it owns without deduplicating by
   * hand. Returns the row it wrote, so a caller has the ABSOLUTE deadline
   * synchronously and the UI can count down before anything is awaited.
   */
  arm(spec: TimerSpec): Timer {
    const at = this.now();
    const dueAt = spec.dueAt ?? at + (spec.inMs ?? 0);
    if (spec.dueAt === undefined && spec.inMs === undefined) {
      throw new Error(`chronos.arm(${spec.id}): needs dueAt or inMs`);
    }
    this.db.prepare(ARM_SQL).run({
      id: spec.id,
      owner: spec.owner,
      kind: spec.kind,
      reason: spec.reason,
      armed_at: at,
      due_at: dueAt,
      base_ms: spec.baseMs ?? Math.max(0, dueAt - at),
      noise_class: spec.noiseClass ?? 'none',
      seed: spec.seed ?? null,
      cadence_ms: spec.cadenceMs ?? null,
      last_run_at: spec.lastRunAt ?? null,
      overdue_policy: spec.overduePolicy ?? 'run-once',
      generation: spec.generation ?? 0,
      span_id: spec.spanId ?? null,
    });
    const armed = this.peek(spec.id);
    if (armed === null) throw new Error(`chronos.arm(${spec.id}): row vanished after write`);
    return armed;
  }

  /**
   * THE §3 primitive: everything already due at `now`, OLDEST FIRST. A freshly
   * launched app feeds this into its first tick, so an overdue sweep or
   * scheduled prune is the first thing it decides about — never one interval
   * later.
   */
  due(now: number = this.now()): Timer[] {
    return this.db
      .prepare(`${SELECT} WHERE due_at <= @now ORDER BY due_at ASC, id ASC`)
      .all<TimerRow>({ now })
      .map(toTimer);
  }

  /**
   * Declare a repeating timer. On first call it is due one interval out; on
   * every later call — including the first after a relaunch — it is due one
   * interval after its LAST RUN, which is how a cadence that came due while
   * the app was closed comes back overdue instead of restarting its wait.
   */
  cadence(
    id: string,
    everyMs: number,
    opts: { owner?: string; reason?: string; overduePolicy?: OverduePolicy } = {},
  ): Cadence {
    const at = this.now();
    const existing = this.peek(id);
    const lastRunAt = existing?.lastRunAt;
    const anchor = lastRunAt ?? existing?.armedAt ?? at;
    const timer = this.arm({
      id,
      owner: opts.owner ?? existing?.owner ?? id,
      kind: 'cadence',
      reason: opts.reason ?? existing?.reason ?? 'cadence',
      dueAt: anchor + everyMs,
      baseMs: everyMs,
      cadenceMs: everyMs,
      lastRunAt,
      overduePolicy: opts.overduePolicy ?? existing?.overduePolicy ?? 'run-once',
      generation: existing?.generation ?? 0,
    });
    return {
      id,
      everyMs,
      dueAt: timer.dueAt,
      lastRunAt: timer.lastRunAt,
      overdue: timer.dueAt <= at,
    };
  }

  /** The armed row, or `null`. Never throws — an absent timer is a value. */
  peek(id: string): Timer | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get<TimerRow>(id);
    return row === undefined ? null : toTimer(row);
  }

  /**
   * The ABSOLUTE deadline a caller must wait until, or `null` when nothing is
   * armed under that id. This is the half of the kernel's `await(id, scope)`
   * that the store can honestly own: the instant. The promise, the abort tree
   * and the `elapsed | cancelled | superseded` resolution are the runtime's,
   * in wave B.
   */
  awaitable(id: string): number | null {
    return this.peek(id)?.dueAt ?? null;
  }

  /**
   * Cancel by exact id, exact owner, or owner PREFIX — so closing a scope
   * cancels every timer beneath it in one call. Returns how many rows went.
   */
  cancel(idOrOwnerPrefix: string): number {
    return this.db
      .prepare(`DELETE FROM timers WHERE id = @k OR owner = @k OR owner GLOB @k || '*'`)
      .run({ k: idOrOwnerPrefix }).changes;
  }

  /**
   * Mark a timer as having RUN at `ranAt`. A cadence advances (stamping
   * `last_run_at`, bumping the generation, and re-dating from the run rather
   * than from the old deadline, so a late run does not compound its lateness);
   * a one-shot deadline or hold is spent, and its row goes. Returns the
   * surviving row, or `null` when the timer is spent or was never armed.
   */
  complete(id: string, ranAt: number = this.now()): Timer | null {
    const timer = this.peek(id);
    if (timer === null) return null;
    if (timer.cadenceMs === undefined) {
      this.db.prepare(`DELETE FROM timers WHERE id = ?`).run(id);
      return null;
    }
    this.db
      .prepare(
        `UPDATE timers SET last_run_at = @at, due_at = @due, generation = generation + 1
         WHERE id = @id`,
      )
      .run({ id, at: ranAt, due: ranAt + timer.cadenceMs });
    return this.peek(id);
  }

  /** Every armed timer, soonest first — the honest surface for a "what's next" panel. */
  list(): Timer[] {
    return this.db
      .prepare(`${SELECT} ORDER BY due_at ASC, id ASC`)
      .all<TimerRow>()
      .map(toTimer);
  }
}
