/**
 * The protection reconciler (spec §7.5): one store transaction over the kept records, no Instagram
 * traffic. Exit 1 returns a record no rule protects anymore; Exit 2 sends an unreadable one back to
 * be read at its plan-paced re-check. A paused index moves nothing.
 */

import type { Clock } from '../governors/clock';
import type { PlanDayClock } from '../kernel/plan';
import { type ProtectionIndex, type ProtectionSubject, protectionVerdict } from '../shared/unfollow-protection';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { KeptMove } from '../store/repos/follow-records';
import type { FollowRecord } from '../store/types';
import * as log from '../utils/logger';
import { type KeptStore, keptStampFor, releaseTarget, storedSubject } from './protection-gate';
import type { ProtectionPort } from './protection-port';

export type ReapplyReason = 'rules' | 'day-roll';

/** Records still kept after the pass, returned to the lifecycle, and sent back to be read. */
export interface ReapplyResult { readonly kept: number; readonly released: number; readonly rechecking: number }

export interface ProtectionReconcilerDeps {
  store: KeptStore & Pick<KnowledgeStore, 'followRecordsByState' | 'getTarget'>;
  port: ProtectionPort;
  clock: Clock;
  /** The one plan-day boundary: a new plan-day key is the day-roll pass. */
  dayClock: PlanDayClock;
}

/** Everything the predicate reads from an index, as one comparable key. */
function rulesKey(idx: ProtectionIndex): string {
  return JSON.stringify([idx.state, [...idx.pks].sort(), [...idx.usernames].sort(), idx.words, idx.wordMatch, idx.keepVerified]);
}

export class ProtectionReconciler {
  private applied: { readonly rules: string; readonly day: string } | null = null;
  private keyed: { readonly idx: ProtectionIndex; readonly key: string } | null = null;

  constructor(private readonly d: ProtectionReconcilerDeps) {}

  /** Re-judge every kept record against the live rules and its stored facts, in one transaction. */
  reapply(reason: ReapplyReason): ReapplyResult {
    const records = this.d.store.followRecordsByState('kept');
    const idx = this.d.port.index();
    if (idx.state !== 'ready') return { kept: records.length, released: 0, rechecking: 0 };
    const now = this.d.clock.now();
    const moves = records.flatMap((rec) => this.judge(rec, idx, now) ?? []);
    this.d.store.followRecords.review(moves);
    const released = moves.filter((m) => m.move === 'release').length;
    const rechecking = moves.filter((m) => m.move === 'recheck').length;
    if (moves.length > 0) log.info('protection: kept records re-judged', { reason, released, rechecking, restamped: moves.length - released - rechecking });
    return { kept: records.length - released - rechecking, released, rechecking };
  }

  /** Reapply when the rules or the plan-day changed since the last pass; the first pass is the graph's open. */
  sync(now: number): ReapplyResult | null {
    const rules = this.rulesKeyOf(this.d.port.index());
    const day = this.d.dayClock.dayKey(now);
    const last = this.applied;
    if (last !== null && last.rules === rules && last.day === day) return null;
    const result = this.reapply(last !== null && last.day === day ? 'rules' : 'day-roll');
    this.applied = { rules, day };
    return result;
  }

  private rulesKeyOf(idx: ProtectionIndex): string {
    if (this.keyed === null || this.keyed.idx !== idx) this.keyed = { idx, key: rulesKey(idx) };
    return this.keyed.key;
  }

  /** The move one kept record needs, or null when it stays as it is. */
  private judge(rec: FollowRecord, idx: ProtectionIndex, now: number): KeptMove | null {
    const pk = rec.accountPk;
    if (rec.keptReason === 'source' && this.isSource(pk)) return null;
    const stored = storedSubject(this.d.store, pk);
    const verdict = protectionVerdict(stored, idx);
    if (verdict.kind === 'protected') {
      if (rec.keptReason === verdict.by && rec.keptMatch === verdict.match) return null;
      return { pk, move: 'keep', stamp: keptStampFor(verdict, now, 0, this.d.port) };
    }
    if (rec.keptReason === 'unreadable-bio' || rec.keptReason === 'unreadable-verified') {
      // Judge the evidence it was kept on: the fact the click could not read stays unread.
      const unread: ProtectionSubject = rec.keptReason === 'unreadable-bio'
        ? { ...stored, bio: undefined } : { ...stored, isVerified: undefined };
      if (protectionVerdict(unread, idx).kind === 'clear') return { pk, move: 'release', to: releaseTarget(rec) };
      return rec.recheckAt !== undefined && rec.recheckAt <= now ? { pk, move: 'recheck' } : null;
    }
    return { pk, move: 'release', to: releaseTarget(rec) };
  }

  /** A chain target or the retained starting account. */
  private isSource(pk: string): boolean {
    return this.d.store.getTarget(pk) !== null || this.d.store.getAccount(pk)?.role === 'retained_target';
  }
}
