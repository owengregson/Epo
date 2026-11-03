import { randomUUID } from 'node:crypto';
import type { SqliteDriver } from '../driver/driver';
import type {
  EffectChannel, EffectIntent, EffectSettlement, FollowRecord, MutationAction, MutationTally,
} from '../types';
import type { FollowRecordRepo } from './follow-records';
import type { LedgerRepo } from './ledgers';
import type { RelationshipRepo } from './relationships';

interface IntentRow {
  id: string;
  account_pk: string;
  username: string;
  action: MutationAction;
  channel: EffectChannel;
  state: EffectIntent['state'];
  created_at: number;
  dispatched_at: number | null;
  settled_at: number | null;
  result: EffectIntent['result'];
  attempts: number;
  next_attempt_at: number | null;
}

const decode = (r: IntentRow): EffectIntent => ({
  id: r.id, accountPk: r.account_pk, username: r.username, action: r.action,
  channel: r.channel, state: r.state, createdAt: r.created_at,
  dispatchedAt: r.dispatched_at, settledAt: r.settled_at, result: r.result,
  attempts: r.attempts, nextAttemptAt: r.next_attempt_at,
});

/** The rate governor's write union: one row per write at or after `@since`. */
const UNION_SINCE = `
  SELECT at, action AS kind, 0 AS manual FROM action_ledger WHERE at >= @since
  UNION ALL SELECT at, 'unfollow', 0 FROM prune_ledger WHERE at >= @since AND result IN ('ok','fail')
  UNION ALL SELECT COALESCE(dispatched_at, created_at), action, channel = 'manual' FROM effect_intents
    WHERE state IN ('dispatched','uncertain') AND COALESCE(dispatched_at, created_at) >= @since
  UNION ALL SELECT dispatched_at, action, channel = 'manual' FROM effect_intents
    WHERE state = 'settled' AND result IN ('external','cancelled','expired') AND dispatched_at IS NOT NULL
      AND dispatched_at >= @since AND COALESCE(ledger, 'none') = 'none'
  UNION ALL SELECT settled_at, action, channel = 'manual' FROM effect_intents
    WHERE state = 'settled' AND action = 'accept-request' AND result IN ('ok','fail')
      AND COALESCE(ledger, 'none') = 'none' AND settled_at >= @since`;

/** Write-ahead effects survive an acknowledgement loss. Settlement is idempotent. */
export class EffectIntentRepo {
  constructor(private readonly db: SqliteDriver, private readonly deps: {
    records: FollowRecordRepo; relationships: RelationshipRepo; ledgers: LedgerRepo; changed: () => void;
  }) {}

  begin(input: {
    accountPk: string; username: string; action: MutationAction; channel: EffectChannel; at: number;
  }): EffectIntent {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM effect_intents
        WHERE account_pk = ? AND action = ? AND channel = ? AND state <> 'settled'`)
        .get<IntentRow>(input.accountPk, input.action, input.channel);
      if (existing) return decode(existing);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO effect_intents
        (id, account_pk, username, action, channel, state, created_at)
        VALUES (?, ?, ?, ?, ?, 'prepared', ?)`).run(
        id, input.accountPk, input.username, input.action, input.channel, input.at,
      );
      return this.get(id) as EffectIntent;
    });
  }

  get(id: string): EffectIntent | null {
    const row = this.db.prepare('SELECT * FROM effect_intents WHERE id = ?').get<IntentRow>(id);
    return row ? decode(row) : null;
  }

  pending(): EffectIntent[] {
    return this.db.prepare("SELECT * FROM effect_intents WHERE state <> 'settled' ORDER BY created_at, id")
      .all<IntentRow>().map(decode);
  }

  /** Open intents due for their settlement read at `now` (no park, or a park served), the oldest first. */
  due(now: number): EffectIntent[] {
    return this.db.prepare(`SELECT * FROM effect_intents WHERE state IN ('dispatched','uncertain')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, id`).all<IntentRow>(now).map(decode);
  }

  /** Park an open intent after `attempts` readings, with its record's park in the same transaction. */
  park(id: string, p: { attempts: number; nextAttemptAt: number }, record: FollowRecord | null): boolean {
    const moved = this.db.transaction(() => {
      const run = this.db.prepare(`UPDATE effect_intents SET attempts = ?, next_attempt_at = ?
        WHERE id = ? AND state IN ('dispatched','uncertain')`).run(p.attempts, p.nextAttemptAt, id);
      if (Number(run.changes) === 0) return false;
      if (record !== null) this.deps.records.upsert(record);
      return true;
    });
    if (moved) this.deps.changed();
    return moved;
  }

  /** Every unsettled intent of one account, whatever its verb or channel. */
  unsettledFor(pk: string): EffectIntent[] {
    return this.db.prepare(`SELECT * FROM effect_intents WHERE account_pk = ? AND state <> 'settled'
      ORDER BY created_at, id`).all<IntentRow>(pk).map(decode);
  }

  /** Unfollow intents created since `since` and cancelled with no dispatch: reviews that pressed nothing (spec §9.7). */
  nonDispatchReviewsSince(since: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM effect_intents WHERE action = 'unfollow' AND state = 'settled'
      AND result = 'cancelled' AND dispatched_at IS NULL AND created_at >= ?`).get<{ n: number }>(since) as { n: number }).n;
  }

  /** Settle the `prepared` intents created before `before` as cancelled: interrupted before any dispatch (spec §9.8). */
  cancelInterruptedPrepared(before: number): number {
    const run = this.db.prepare(`UPDATE effect_intents SET state = 'settled', settled_at = ?, result = 'cancelled',
      ledger = 'none' WHERE state = 'prepared' AND created_at < ?`).run(before, before);
    const n = Number(run.changes);
    if (n > 0) this.deps.changed();
    return n;
  }

  mark(id: string, state: 'dispatched' | 'uncertain', at: number): void {
    this.db.prepare(`UPDATE effect_intents SET state = ?, dispatched_at = COALESCE(dispatched_at, ?)
      WHERE id = ? AND state <> 'settled'`).run(state, at, id);
  }

  /** The caller's record/ledger/edge writes share this transaction with settlement. */
  settle(id: string, outcome: EffectSettlement): boolean {
    return this.db.transaction(() => {
      const intent = this.get(id);
      if (intent === null || intent.state === 'settled') return false;
      this.applySettlement(intent, outcome);
      this.db.prepare(`UPDATE effect_intents SET state = 'settled', settled_at = ?, result = ?, ledger = ?
        WHERE id = ?`).run(outcome.at, outcome.result, outcome.ledger ?? 'none', id);
      this.deps.changed();
      return true;
    });
  }

  private applySettlement(intent: EffectIntent, outcome: EffectSettlement): void {
    if (outcome.record) this.deps.records.upsert(outcome.record);
    if (outcome.edge) {
      const e = outcome.edge;
      this.deps.relationships.observeEdge(e.srcPk, e.dstPk, 'follows', e.active, e.observedAt ?? outcome.at);
    }
    if (outcome.result === 'ok' || outcome.result === 'fail') {
      if (outcome.ledger === 'growth') {
        this.deps.ledgers.recordAction(intent.accountPk, intent.action, outcome.result, outcome.at);
      } else if (outcome.ledger === 'prune') {
        this.deps.ledgers.recordPruneAction(intent.accountPk, outcome.result, outcome.at);
      }
    } else if (outcome.result === 'simulated' && outcome.ledger === 'prune') {
      this.deps.ledgers.recordPruneAction(intent.accountPk, 'simulated', outcome.at);
    }
  }

  /** Unknown dispatched writes reserve budget; acceptance without another ledger counts once. */
  additionalCountSince(since: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM effect_intents WHERE
      (state IN ('dispatched','uncertain') AND COALESCE(dispatched_at, created_at) >= ?)
      OR (state = 'settled' AND result IN ('external','cancelled','expired')
          AND dispatched_at IS NOT NULL AND dispatched_at >= ? AND COALESCE(ledger, 'none') = 'none')
      OR (state = 'settled' AND action = 'accept-request' AND result IN ('ok','fail')
          AND COALESCE(ledger, 'none') = 'none' AND settled_at >= ?)`)
      .get<{ n: number }>(since, since, since) as { n: number }).n;
  }

  /**
   * The account's write budget since `since`, by kind: the growth ledger, real
   * prune rows and the intents {@link additionalCountSince} counts (the rate
   * governor's union). `manual` counts the writes a manual intent made.
   */
  tallySince(since: number): MutationTally {
    const t: MutationTally = { all: 0, auto: 0, manual: 0, follow: 0, unfollow: 0, accept: 0 };
    for (const r of this.unionSince(since)) {
      t.all += 1;
      t.manual += r.manual;
      if (r.kind === 'accept-request') t.accept += 1;
      else if (r.kind === 'follow') t.follow += 1;
      else t.unfollow += 1;
    }
    // A manual write that reached a ledger is counted there, by the row settled with it.
    t.manual += (this.db.prepare(`SELECT COUNT(*) AS n FROM effect_intents
      WHERE channel = 'manual' AND state = 'settled' AND result IN ('ok','fail')
        AND COALESCE(ledger, 'none') <> 'none' AND settled_at >= ?`).get<{ n: number }>(since) as { n: number }).n;
    t.auto = t.all - t.manual;
    return t;
  }

  /** When each write in {@link tallySince}'s union happened, oldest first. */
  mutationTimesSince(since: number): number[] {
    return this.unionSince(since).map((r) => r.at);
  }

  /** Whether the union holds any write at all, however old: an install with a ledger. */
  hasAnyMutation(): boolean {
    return this.db.prepare(`SELECT EXISTS(${UNION_SINCE}) AS hit`).get<{ hit: number }>({ since: 0 })?.hit === 1;
  }

  private unionSince(since: number): Array<{ at: number; kind: string; manual: number }> {
    return this.db.prepare(`${UNION_SINCE} ORDER BY 1`).all<{ at: number; kind: string; manual: number }>({ since });
  }

  /** Terminal intent detail is operational history; unresolved intent and outcome ledgers are durable. */
  pruneSettled(now: number, retentionMs: number): void {
    const cutoff = now - retentionMs;
    this.db.prepare(`DELETE FROM effect_intents WHERE state = 'settled' AND settled_at < ?
      AND (dispatched_at IS NULL OR dispatched_at < ?)`).run(cutoff, cutoff);
  }
}
