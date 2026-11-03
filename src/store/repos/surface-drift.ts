import type { SqliteDriver } from '../driver/driver';
import type { DriftState } from '../schema/surface-tables';
import type { MetaRepo } from './meta';

/** One drift signature (migration 16): a path pattern and types, never a value. */
export interface DriftRow {
  signature: string;
  surfaceId: string;
  endpoint: string;
  cls: string;
  path: string;
  /** JSON of types, operation names and counts. */
  detail: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seen: number;
  sample: string | null;
  hintPattern: string | null;
  witnesses: number;
  contradictions: number;
  witnessKeys: string[];
  state: DriftState;
  cleanReads: number;
}

/** One plan-day × surface × endpoint row of read counters. */
export interface HealthRow {
  day: string;
  surfaceId: string;
  endpoint: string;
  canonical: number;
  normalized: number;
  recovered: number;
  failed: number;
  walls: number;
  rowIssues: number;
  fieldIssues: number;
  shadowDisagreed: number;
  lastReadAt: number | null;
  lastOkAt: number | null;
  lastFailAt: number | null;
}

/** Counters to add to one health row, with the newest read, ok and failure times they carry. */
export type HealthDelta = Omit<HealthRow, 'day' | 'surfaceId' | 'endpoint' | 'lastReadAt' | 'lastOkAt' | 'lastFailAt'> & {
  readAt: number | null; okAt: number | null; failAt: number | null;
};

/** What a signature upsert carries; the detail is already JSON. */
export interface DriftUpsert {
  signature: string; surfaceId: string; endpoint: string; cls: string; path: string; detail: string; at: number;
  sample?: string | null; hintPattern?: string | null;
}

type SqlRow = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const optText = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function keysOf(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    // A corrupt witness list counts as empty: witnesses only ever promote a hint, never a verdict.
    return [];
  }
}

/** The recovery role a recovered signature's detail names; a corrupt detail names none, so it never yields a hint. */
function roleOf(detail: unknown): unknown {
  try {
    return (JSON.parse(String(detail)) as { role?: unknown }).role;
  } catch {
    return undefined;
  }
}

const driftRow = (r: SqlRow): DriftRow => ({
  signature: String(r.signature), surfaceId: String(r.surface_id), endpoint: String(r.endpoint), cls: String(r.cls),
  path: String(r.path), detail: String(r.detail), firstSeenAt: num(r.first_seen_at), lastSeenAt: num(r.last_seen_at),
  seen: num(r.seen), sample: optText(r.sample), hintPattern: optText(r.hint_pattern), witnesses: num(r.witnesses),
  contradictions: num(r.contradictions), witnessKeys: keysOf(r.witness_keys), state: String(r.state) as DriftState,
  cleanReads: num(r.clean_reads),
});

const healthRow = (r: SqlRow): HealthRow => ({
  day: String(r.day), surfaceId: String(r.surface_id), endpoint: String(r.endpoint), canonical: num(r.canonical),
  normalized: num(r.normalized), recovered: num(r.recovered), failed: num(r.failed), walls: num(r.walls),
  rowIssues: num(r.row_issues), fieldIssues: num(r.field_issues), shadowDisagreed: num(r.shadow_disagreed),
  lastReadAt: optNum(r.last_read_at), lastOkAt: optNum(r.last_ok_at), lastFailAt: optNum(r.last_fail_at),
});

/** Classes a clean read never resolves: a shadow disagreement stays until an update replaces the surface. */
const STICKY = `('shadow-disagreed')`;
/** Classes evicted first when an endpoint holds too many signatures. */
const INFORMATIONAL = new Set(['novel-key', 'normalized', 'enum-novel', 'graphql-partial', 'graphql-error']);

/**
 * Persisted drift signatures, per-plan-day surface health (migration 16) and the latency meter
 * (`meta.surface_meter`). Bounds and day keys arrive as method arguments (spec §14 C24): the
 * store computes no day and imports no kernel value. Every write bumps `revision`.
 */
export class SurfaceDriftRepo {
  private rev = 0;

  constructor(
    protected readonly db: SqliteDriver,
    protected readonly meta: MetaRepo,
    protected readonly changed: () => void,
  ) {}

  /** Bumped by every write; the status summary's revision rides it. */
  get revision(): number {
    return this.rev;
  }

  private wrote(): void {
    this.rev += 1;
    this.changed();
  }

  /** The row for one signature, or null. */
  signatureOf(signature: string): DriftRow | null {
    const r = this.db.prepare(`SELECT * FROM surface_drift WHERE signature = ?`).get(signature) as SqlRow | undefined;
    return r === undefined ? null : driftRow(r);
  }

  /** Record one sighting. A new or resolved signature is a first sighting; a repeat counts and restarts its clean run. */
  upsertSignal(s: DriftUpsert): { firstSighting: boolean; row: DriftRow } {
    const before = this.signatureOf(s.signature);
    if (before === null) {
      this.db.prepare(
        `INSERT INTO surface_drift (signature, surface_id, endpoint, cls, path, detail, first_seen_at, last_seen_at,
          sample, hint_pattern) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(s.signature, s.surfaceId, s.endpoint, s.cls, s.path, s.detail, s.at, s.at, s.sample ?? null,
        s.hintPattern ?? null);
    } else {
      this.db.prepare(
        `UPDATE surface_drift SET seen = seen + 1, last_seen_at = MAX(last_seen_at, ?), detail = ?, clean_reads = 0,
          state = CASE WHEN state = 'resolved' THEN 'open' ELSE state END,
          first_seen_at = CASE WHEN state = 'resolved' THEN ? ELSE first_seen_at END,
          sample = COALESCE(sample, ?), hint_pattern = COALESCE(?, hint_pattern) WHERE signature = ?`,
      ).run(s.at, s.detail, s.at, s.sample ?? null, s.hintPattern ?? null, s.signature);
    }
    this.wrote();
    return { firstSighting: before === null || before.state === 'resolved', row: this.signatureOf(s.signature) as DriftRow };
  }

  /** Attach a scrubbed sample to a signature that has none. */
  setSample(signature: string, sample: string): void {
    this.db.prepare(`UPDATE surface_drift SET sample = ? WHERE signature = ? AND sample IS NULL`).run(sample, signature);
    this.wrote();
  }

  /** Samples stored on signatures first seen at or after `since` (the plan-day's start). */
  samplesSince(surfaceId: string, since: number): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS n FROM surface_drift WHERE surface_id = ? AND sample IS NOT NULL AND first_seen_at >= ?`,
    ).get(surfaceId, since) as SqlRow;
    return num(r.n);
  }

  /**
   * One witnessed subject for a hint: a disagreement contradicts it for good; enough distinct agreeing
   * subjects with no contradiction make it consistent.
   */
  witness(signature: string, subject: string, agreed: boolean, at: number, consistentAfter: number): DriftRow | null {
    const row = this.signatureOf(signature);
    if (row === null) return null;
    if (!agreed) {
      this.db.prepare(`UPDATE surface_drift SET contradictions = contradictions + 1, state = 'contradicted',
        last_seen_at = MAX(last_seen_at, ?) WHERE signature = ?`).run(at, signature);
    } else if (!row.witnessKeys.includes(subject)) {
      const keys = [...row.witnessKeys, subject].slice(-consistentAfter);
      const witnesses = row.witnesses + 1;
      const state = row.state === 'open' && row.contradictions === 0 && witnesses >= consistentAfter ? 'consistent' : row.state;
      this.db.prepare(`UPDATE surface_drift SET witnesses = ?, witness_keys = ?, state = ? WHERE signature = ?`)
        .run(witnesses, JSON.stringify(keys), state, signature);
    }
    this.wrote();
    return this.signatureOf(signature);
  }

  /** Count clean canonical reads of an endpoint (one path, or all); resolve what reached `resolveAfter`. */
  noteCleanRead(surfaceId: string, endpoint: string, path: string | null, at: number, resolveAfter: number, reads = 1): number {
    const where = `surface_id = ? AND endpoint = ? AND state != 'resolved' AND cls NOT IN ${STICKY}${path === null ? '' : ' AND path = ?'}`;
    const args = path === null ? [surfaceId, endpoint] : [surfaceId, endpoint, path];
    const bumped = this.db.prepare(`UPDATE surface_drift SET clean_reads = clean_reads + ? WHERE ${where}`).run(reads, ...args);
    if (bumped.changes === 0) return 0;
    const resolved = this.db.prepare(
      `UPDATE surface_drift SET state = 'resolved', last_seen_at = MAX(last_seen_at, ?) WHERE ${where} AND clean_reads >= ?`,
    ).run(at, ...args, resolveAfter);
    this.wrote();
    return resolved.changes;
  }

  /** Add counters to one plan-day's health row. */
  addHealth(day: string, surfaceId: string, endpoint: string, d: HealthDelta): void {
    this.db.prepare(
      `INSERT INTO surface_health (day, surface_id, endpoint, canonical, normalized, recovered, failed, walls, row_issues,
        field_issues, shadow_disagreed, last_read_at, last_ok_at, last_fail_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, surface_id, endpoint) DO UPDATE SET canonical = canonical + excluded.canonical,
        normalized = normalized + excluded.normalized, recovered = recovered + excluded.recovered,
        failed = failed + excluded.failed, walls = walls + excluded.walls, row_issues = row_issues + excluded.row_issues,
        field_issues = field_issues + excluded.field_issues, shadow_disagreed = shadow_disagreed + excluded.shadow_disagreed,
        last_read_at = MAX(COALESCE(last_read_at, excluded.last_read_at), COALESCE(excluded.last_read_at, last_read_at)),
        last_ok_at = MAX(COALESCE(last_ok_at, excluded.last_ok_at), COALESCE(excluded.last_ok_at, last_ok_at)),
        last_fail_at = MAX(COALESCE(last_fail_at, excluded.last_fail_at), COALESCE(excluded.last_fail_at, last_fail_at))`,
    ).run(day, surfaceId, endpoint, d.canonical, d.normalized, d.recovered, d.failed, d.walls, d.rowIssues, d.fieldIssues,
      d.shadowDisagreed, d.readAt, d.okAt, d.failAt);
    this.wrote();
  }

  /** Every signature of a surface that is not resolved, oldest first. */
  openSignatures(surfaceId: string): DriftRow[] {
    return (this.db.prepare(
      `SELECT * FROM surface_drift WHERE surface_id = ? AND state != 'resolved' ORDER BY first_seen_at, signature`,
    ).all(surfaceId) as SqlRow[]).map(driftRow);
  }

  /** Health rows of a surface from `sinceDay` on (`''` = every retained day). */
  health(surfaceId: string, sinceDay: string): HealthRow[] {
    return (this.db.prepare(`SELECT * FROM surface_health WHERE surface_id = ? AND day >= ? ORDER BY day, endpoint`)
      .all(surfaceId, sinceDay) as SqlRow[]).map(healthRow);
  }

  /** Hint patterns for an endpoint and role: consistent first, then open; contradicted never. */
  hintPatterns(surfaceId: string, endpoint: string, role: string): string[] {
    return (this.db.prepare(
      `SELECT hint_pattern, detail FROM surface_drift WHERE surface_id = ? AND endpoint = ? AND cls = 'recovered'
        AND hint_pattern IS NOT NULL AND state IN ('consistent', 'open')
        ORDER BY CASE state WHEN 'consistent' THEN 0 ELSE 1 END, last_seen_at DESC`,
    ).all(surfaceId, endpoint) as SqlRow[])
      .filter((r) => roleOf(r.detail) === role)
      .map((r) => String(r.hint_pattern));
  }

  /** Operation names learned for an endpoint (consistent unrouted hints only). */
  learnedOps(surfaceId: string): Array<{ op: string; kind: string }> {
    return (this.db.prepare(
      `SELECT hint_pattern, endpoint FROM surface_drift WHERE surface_id = ? AND cls = 'unrouted' AND state = 'consistent'
        AND hint_pattern IS NOT NULL ORDER BY last_seen_at DESC`,
    ).all(surfaceId) as SqlRow[]).map((r) => ({ op: String(r.hint_pattern), kind: String(r.endpoint) }));
  }

  /** An update shipped: every unresolved signature of another surface id is resolved. */
  resolveOtherSurfaces(activeSurfaceId: string, at: number): number {
    const r = this.db.prepare(`UPDATE surface_drift SET state = 'resolved', last_seen_at = MAX(last_seen_at, ?)
      WHERE surface_id != ? AND state != 'resolved'`).run(at, activeSurfaceId);
    if (r.changes > 0) this.wrote();
    return r.changes;
  }

  /**
   * Retention: health rows beyond the newest `healthDays` plan-days, resolved signatures last seen before
   * `resolvedBefore`, and signatures past `maxPerEndpoint` (informational ones first, then the oldest).
   */
  prune(keep: { healthDays: number; resolvedBefore: number; maxPerEndpoint: number }): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM surface_health WHERE day NOT IN
        (SELECT DISTINCT day FROM surface_health ORDER BY day DESC LIMIT ?)`).run(keep.healthDays);
      this.db.prepare(`DELETE FROM surface_drift WHERE state = 'resolved' AND last_seen_at < ?`).run(keep.resolvedBefore);
      const rows = (this.db.prepare(`SELECT signature, endpoint, cls, last_seen_at FROM surface_drift`).all() as SqlRow[]);
      const byEndpoint = new Map<string, SqlRow[]>();
      for (const r of rows) byEndpoint.set(String(r.endpoint), [...(byEndpoint.get(String(r.endpoint)) ?? []), r]);
      const drop = this.db.prepare(`DELETE FROM surface_drift WHERE signature = ?`);
      for (const group of byEndpoint.values()) {
        const rank = (r: SqlRow): number => (INFORMATIONAL.has(String(r.cls)) ? 0 : 1);
        group.sort((a, b) => rank(a) - rank(b) || num(a.last_seen_at) - num(b.last_seen_at));
        for (const r of group.slice(0, Math.max(0, group.length - keep.maxPerEndpoint))) drop.run(String(r.signature));
      }
    });
    this.wrote();
  }

  /** The persisted latency reservoir (`meta.surface_meter`), raw. */
  meter(): string | null {
    return this.meta.get('surfaceMeter');
  }

  setMeter(raw: string): void {
    this.meta.set('surfaceMeter', raw);
  }
}
