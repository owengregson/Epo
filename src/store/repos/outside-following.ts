import type { SqliteDriver } from '../driver/driver';
import { type EpoWrite, type OwnHeader, outsideCharges } from '../folds/growth';
import type { MetaRepo } from './meta';

export interface OutsideFollowingCheck {
  readonly at: number;
  readonly dayStart: number;
  readonly count: number;
  readonly added: number;
}
/** Epo's writes that landed (ledger rows and ledger-less intents), with the account's privacy. */
const EPO_WRITES = `
  SELECT w.account_pk AS accountPk, w.at AS at, w.action AS action, COALESCE(a.is_private, 0) AS private FROM (
    SELECT at, action, account_pk FROM action_ledger WHERE result = 'ok' AND at >= @since
    UNION ALL SELECT at, 'unfollow', account_pk FROM prune_ledger WHERE result = 'ok' AND at >= @since
    UNION ALL SELECT dispatched_at, action, account_pk FROM effect_intents
      WHERE state = 'settled' AND result IN ('ok', 'external') AND action IN ('follow', 'unfollow')
        AND COALESCE(ledger, 'none') = 'none' AND dispatched_at >= @since
  ) w LEFT JOIN accounts a ON a.pk = w.account_pk`;

interface OutsideFollowingState {
  readonly pending: readonly string[];
  readonly checks: readonly OutsideFollowingCheck[];
}

/** Partial reads retain discoveries; only a complete check dates them to its checked plan-day. */
export class OutsideFollowingRepo {
  constructor(private readonly meta: MetaRepo, private readonly changed: () => void,
    private readonly db: SqliteDriver, private readonly lookbackMs: number) {}

  private state(): OutsideFollowingState {
    const raw = this.meta.json<OutsideFollowingState>('outsideFollowing');
    if (raw === null) return { pending: [], checks: [] };
    if (!Array.isArray(raw.pending) || !raw.pending.every((pk) => typeof pk === 'string')
      || !Array.isArray(raw.checks) || !raw.checks.every((c) => [c.at, c.dayStart, c.count, c.added].every(Number.isFinite))) {
      throw new Error('Invalid outside following accounting');
    }
    return raw;
  }

  observe(pk: string): void {
    const s = this.state();
    if (s.pending.includes(pk)) return;
    this.meta.setJson('outsideFollowing', { ...s, pending: [...s.pending, pk] });
    this.changed();
  }

  complete(seen: ReadonlySet<string>, dayStart: number, at: number, retainSince: number): number {
    const s = this.state();
    // The first whole list establishes stock. Only changes since a complete baseline are exact actions.
    const added = s.checks.length === 0 ? 0 : s.pending.filter((pk) => seen.has(pk)).length;
    const checks = s.checks.filter((c, i) => i === 0 || c.at >= retainSince);
    checks.push({ at, dayStart, count: seen.size, added });
    this.meta.setJson('outsideFollowing', { pending: [], checks });
    this.changed();
    return added;
  }

  checks(): readonly OutsideFollowingCheck[] { return this.state().checks; }

  /** A landed Epo/manual follow without a managed record still belongs to Epo's action ledger. */
  epoFollowing(pk: string, removedAt: number | null): boolean {
    const last = this.checks().at(-1)?.at ?? Number.NEGATIVE_INFINITY;
    const w = this.db.prepare(`${EPO_WRITES} WHERE w.account_pk = @pk ORDER BY w.at DESC LIMIT 1`)
      .get<{ at: number; action: EpoWrite['action']; private: number }>({ pk, since: last - this.lookbackMs });
    if (w === undefined || w.action !== 'follow') return false;
    if (removedAt !== null && w.at < removedAt) return false;
    return w.at >= last || w.private === 1;
  }

  outsideIn(from: number, to: number): number {
    const lookback = from - this.lookbackMs;
    const writes = this.db.prepare(EPO_WRITES).all<{ at: number; action: EpoWrite['action']; private: number }>({ since: lookback })
      .map((w): EpoWrite => ({ at: w.at, action: w.action, private: w.private === 1 }));
    const checks = this.checks().filter((c) => c.at < to);
    const baseline = checks[0];
    const last = checks.at(-1);
    const headers = this.db.prepare('SELECT at, followers, following FROM own_counts WHERE at >= ? ORDER BY at')
      .all<OwnHeader>(lookback);
    const charge = (rows: readonly OwnHeader[], after: number) => outsideCharges(rows, writes)
      .filter((w) => w.from >= after && w.to > w.from && w.to < to).reduce((sum, w) => sum + w.charge, 0);
    if (baseline === undefined || last === undefined) return charge(headers, from);
    const anchor = (c: OutsideFollowingCheck): OwnHeader => ({ at: c.at, followers: 0, following: c.count });
    const before = charge([...headers.filter((h) => h.at < baseline.at), anchor(baseline)], from);
    const after = charge([...headers.filter((h) => h.at !== last.at), anchor(last)], Math.max(from, last.at));
    const exact = checks.filter((c) => c.dayStart >= from).reduce((sum, c) => sum + c.added, 0);
    return before + exact + after;
  }
}
