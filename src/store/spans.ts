/**
 * Spans — the persisted cause chain, and the corpus every derived constant is
 * fitted to.
 *
 * Two jobs, one table:
 *
 *  1. **Cause chains replace status fields.** `tick → verdict(pacing) →
 *     effect(follow) → refused(rate-limited) → recovery-entry → hold(rung 1)`
 *     is one `parent_id` walk. "Why is it parked" becomes a query rather than
 *     five correlated fields nobody can keep consistent. `reason` shares the
 *     halt/park/refusal vocabulary with {@link Chronos}, so a timer and the
 *     span that armed it name the same cause with the same string.
 *  2. **Spans feed the derivations.** Timeouts (`p99 × slack`) and poll
 *     intervals (`p50 / 4`) are measurements, not guesses;
 *     {@link SpanSink.percentile} is where the measurement comes from.
 *
 * Retention is a 50k-row ring. Ids sort lexicographically by time, so trimming
 * the ring is one indexed DELETE and "the oldest rows" needs no clock.
 */

import type { SqliteDriver, SqlValue } from './driver/driver';
import { SPANS } from './schema/manifest';
import { decodeRow, type RowOf, upsertSql } from './schema/tables';

/** How a span ended. The closed vocabulary the runtime's outcome algebra maps onto. */
export type SpanOutcome =
  | 'ok' | 'refused' | 'drifted' | 'ambiguous'
  | 'cancelled' | 'halted' | 'parked' | 'failed';

/** Small JSON payload; schema'd per span name by the caller. */
export type SpanAttrs = Readonly<Record<string, unknown>>;

export interface SpanOpenOptions {
  /** The span that CAUSED this one — the edge a cause-chain walk follows. */
  parent?: string;
  /** The abort-tree scope this work belongs to. */
  scope?: string;
  /** growth | prune-scan | prune-run | … */
  mode?: string;
  attrs?: SpanAttrs;
}

/** One row of the span log. */
export interface Span {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly scopeId: string;
  readonly name: string;
  readonly mode: string;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly outcome: SpanOutcome | undefined;
  readonly reason: string | undefined;
  readonly attrs: SpanAttrs;
}

export interface SpanSinkOptions {
  now?: () => number;
  rng?: () => number;
  /** Ring size. Defaults to {@link RING_ROWS}. */
  retain?: number;
}

/** The ring: enough for weeks of runs, small enough to never need a sweep job. */
export const RING_ROWS = 50_000;

/** Events kept inline on a span before the oldest are dropped (with a count). */
const MAX_INLINE_EVENTS = 32;

/** How many opens between ring trims — the trim is indexed, but not free. */
const TRIM_EVERY = 512;

/** Crockford base32: sortable, case-insensitive, no ambiguous glyphs. */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const enc = (n: number, len: number): string => {
  let out = '';
  let v = Math.max(0, Math.floor(n));
  for (let i = 0; i < len; i++) {
    out = B32[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
};

type SpanRow = RowOf<typeof SPANS>;

const INSERT_SQL = upsertSql(SPANS, { conflict: ['id'] });

const SELECT = `SELECT ${Object.keys(SPANS.columns).join(', ')} FROM spans`;

const parseAttrs = (raw: string): SpanAttrs => {
  // A span's own write is the only writer; a corrupt one is a real defect and
  // must surface, not be swallowed into an empty object.
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'object' && parsed !== null ? (parsed as SpanAttrs) : {};
};

const toSpan = (row: SpanRow): Span => {
  const v = decodeRow(SPANS, row);
  return {
    id: v.id,
    parentId: v.parent_id,
    scopeId: v.scope_id,
    name: v.name,
    mode: v.mode,
    startedAt: v.started_at,
    endedAt: v.ended_at,
    outcome: v.outcome as SpanOutcome | undefined,
    reason: v.reason,
    attrs: parseAttrs(v.attrs),
  };
};

export class SpanSink {
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly retain: number;
  /** Monotonic within one millisecond, so ids sort by time even under a fake clock. */
  private lastMs = -1;
  private seq = 0;
  private opens = 0;

  constructor(
    private readonly db: SqliteDriver,
    opts: SpanSinkOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    this.retain = opts.retain ?? RING_ROWS;
  }

  /**
   * A sortable id: 10 chars of millisecond, 4 of in-millisecond sequence, 6 of
   * randomness. Lexicographic order IS time order, which is what lets the ring
   * trim by id and a cause chain read in the order it happened.
   */
  private mint(at: number): string {
    if (at === this.lastMs) this.seq += 1;
    else {
      this.lastMs = at;
      this.seq = 0;
    }
    return enc(at, 10) + enc(this.seq, 4) + enc(this.rng() * 32 ** 6, 6);
  }

  /** Open a span. Returns its id — the handle `close`/`event` take. */
  open(name: string, opts: SpanOpenOptions = {}): string {
    const at = this.now();
    const id = this.mint(at);
    this.db.prepare(INSERT_SQL).run({
      id,
      parent_id: opts.parent ?? null,
      scope_id: opts.scope ?? 'root',
      name,
      mode: opts.mode ?? 'none',
      started_at: at,
      ended_at: null,
      outcome: null,
      reason: null,
      attrs: JSON.stringify(opts.attrs ?? {}),
    });
    this.opens += 1;
    if (this.opens % TRIM_EVERY === 0) this.trim();
    return id;
  }

  /**
   * Close a span with its outcome and, where the outcome has one, the reason —
   * a HaltReason / ParkReason / RefusalCause from the same vocabulary a timer
   * records. A span already closed is NOT reopened: the first verdict stands.
   */
  close(id: string, outcome: SpanOutcome, reason?: string): void {
    this.db
      .prepare(
        `UPDATE spans SET ended_at = @at, outcome = @outcome, reason = @reason
         WHERE id = @id AND ended_at IS NULL`,
      )
      .run({ id, at: this.now(), outcome, reason: reason ?? null });
  }

  /**
   * Annotate a span with something that happened inside it — what `log.info`
   * calls become once the console is a sink rather than the record. Kept
   * inline and BOUNDED: past {@link MAX_INLINE_EVENTS} the oldest go and a
   * `droppedEvents` count replaces them, so one pathological loop can never
   * inflate a row without limit.
   */
  event(id: string, attrs: SpanAttrs): void {
    const row = this.db.prepare(`SELECT attrs FROM spans WHERE id = ?`).get<{ attrs: string }>(id);
    if (row === undefined) return;
    const current = { ...parseAttrs(row.attrs) } as Record<string, unknown>;
    const events = Array.isArray(current.events) ? [...(current.events as unknown[])] : [];
    events.push({ at: this.now(), ...attrs });
    const dropped = Math.max(0, events.length - MAX_INLINE_EVENTS);
    if (dropped > 0) {
      events.splice(0, dropped);
      const prior = current.droppedEvents;
      current.droppedEvents = (typeof prior === 'number' ? prior : 0) + dropped;
    }
    current.events = events;
    this.db
      .prepare(`UPDATE spans SET attrs = @attrs WHERE id = @id`)
      .run({ id, attrs: JSON.stringify(current) });
  }

  get(id: string): Span | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get<SpanRow>(id);
    return row === undefined ? null : toSpan(row);
  }

  /** A span's direct children, oldest first — one step of a cause-chain walk. */
  childrenOf(id: string): Span[] {
    return this.db
      .prepare(`${SELECT} WHERE parent_id = ? ORDER BY id ASC`)
      .all<SpanRow>(id)
      .map(toSpan);
  }

  /**
   * The chain from `id` up to its root, nearest cause first. THE answer to
   * "why is it parked", as a value.
   */
  causeChain(id: string): Span[] {
    const chain: Span[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = id;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      const span = this.get(cursor);
      if (span === null) break;
      chain.push(span);
      cursor = span.parentId;
    }
    return chain;
  }

  /** The most recent spans, newest first; optionally one name only. */
  recent(opts: { name?: string; limit?: number } = {}): Span[] {
    const args = { name: opts.name ?? null, limit: opts.limit ?? 100 };
    return this.db
      .prepare(`${SELECT} WHERE (@name IS NULL OR name = @name) ORDER BY id DESC LIMIT @limit`)
      .all<SpanRow>(args)
      .map(toSpan);
  }

  count(): number {
    return this.db.prepare(`SELECT COUNT(*) AS c FROM spans`).get<{ c: number }>()?.c ?? 0;
  }

  /**
   * The `p`-th percentile (nearest-rank, `p` in [0,1]) of a measured quantity
   * over spans named `name`. `field` is `'duration'` (the closed span's wall
   * time) or the key of a numeric attribute.
   *
   * This is the seam the derived constants read: `timeout(op) = p99 × slack`
   * and `pollEvery(op) = p50 / 4` stop being hand-picked the moment enough
   * spans exist to answer. `null` when nothing has been measured — absence of
   * evidence never becomes a fabricated number.
   */
  percentile(name: string, field: string, p: number, opts: { since?: number } = {}): number | null {
    if (!(p >= 0 && p <= 1)) throw new Error(`spans.percentile: p must be in [0,1], got ${p}`);
    const value =
      field === 'duration'
        ? 'CAST(ended_at - started_at AS REAL)'
        : `CAST(json_extract(attrs, '$.' || @field) AS REAL)`;
    const where =
      `WHERE name = @name AND started_at >= @since AND ${value} IS NOT NULL` +
      (field === 'duration' ? ' AND ended_at IS NOT NULL' : '');
    // Bind EXACTLY the placeholders the SQL uses: `@field` only exists on the
    // attribute branch, and an unknown named parameter is an error, not a hint.
    const args: Record<string, SqlValue> = { name, since: opts.since ?? 0 };
    if (field !== 'duration') args.field = field;
    const n = this.db.prepare(`SELECT COUNT(*) AS c FROM spans ${where}`).get<{ c: number }>(args)?.c ?? 0;
    if (n === 0) return null;
    // LIMIT/OFFSET are bound as plain integers: SQLite refuses arithmetic ON a
    // parameter in the OFFSET clause with a datatype mismatch.
    const offset = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
    const row = this.db
      .prepare(`SELECT ${value} AS v FROM spans ${where} ORDER BY v ASC LIMIT 1 OFFSET @offset`)
      .get<{ v: number }>({ ...args, offset });
    return row?.v ?? null;
  }

  /**
   * Hold the ring at `retain` rows by dropping the oldest. Runs every
   * {@link TRIM_EVERY} opens rather than on each one — the DELETE is indexed,
   * but the sub-select is not free at a scan's write rate.
   */
  trim(): number {
    const offset = this.retain - 1;
    const oldest = this.db
      .prepare(`SELECT id FROM spans ORDER BY id DESC LIMIT 1 OFFSET @offset`)
      .get<{ id: string }>({ offset });
    if (oldest === undefined) return 0;
    return this.db.prepare(`DELETE FROM spans WHERE id < ?`).run(oldest.id).changes;
  }
}
