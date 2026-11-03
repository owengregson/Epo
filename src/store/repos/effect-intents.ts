import { randomUUID } from 'node:crypto';
import type { SqliteDriver } from '../driver/driver';
import type { EffectChannel, EffectIntent, EffectSettlement, MutationAction } from '../types';
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

  /** Terminal intent detail is operational history; unresolved intent and outcome ledgers are durable. */
  pruneSettled(now: number): void {
    const cutoff = now - 90 * 24 * 60 * 60 * 1000;
    this.db.prepare(`DELETE FROM effect_intents WHERE state = 'settled' AND settled_at < ?
      AND (dispatched_at IS NULL OR dispatched_at < ?)`).run(cutoff, cutoff);
  }
}
