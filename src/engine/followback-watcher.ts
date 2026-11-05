/**
 * The follow-back appliers (spec §9.3–9.4): every fact a sweep step reads is applied the moment it
 * arrives — a dated follow event, an undated one, a requester row, an accepted request — and the
 * store-only consistency pass moves a managed record whose follow-back the graph already holds.
 * Nothing here reads Instagram; the frontier sweep feeds it.
 */

import type { Clock } from '../governors/clock';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { FollowRecord, Observation } from '../store/types';
import { info, warn } from '../utils/logger';
import type { FollowbackAccepted, FollowbackConfig, FollowbackEvent } from './followback-types';

export type { FollowbackAccepted, FollowbackConfig, FollowbackEvent } from './followback-types';

/** Channel evidence for an open accept intent: the journal's zero-read settlement (spec §9.8). */
export interface ChannelEvidence {
  readonly follower?: { readonly pk: string; readonly atMs: number };
  readonly stillRequesting?: { readonly pk: string; readonly at: number };
}

interface FollowbackDeps {
  store: KnowledgeStore;
  clock: Clock;
  /** Our own account PK — the destination of every "follows us" edge. */
  ownPk: string;
  cfg: FollowbackConfig;
  /** Settle an open accept intent from channel evidence (the journal's `settleFromChannels`). */
  settleChannels?: (e: ChannelEvidence) => void;
}

export class FollowbackWatcher {
  private readonly store: KnowledgeStore;
  private readonly clock: Clock;
  private readonly ownPk: string;
  private cfg: FollowbackConfig;
  private readonly settleChannels?: (e: ChannelEvidence) => void;

  constructor(deps: FollowbackDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.ownPk = deps.ownPk;
    this.cfg = deps.cfg;
    this.settleChannels = deps.settleChannels;
  }

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: FollowbackConfig): void {
    this.cfg = cfg;
  }

  /** A record a follow-back can still move: waiting, or queued for no follow-back with none seen. */
  private canDetect(r: FollowRecord): boolean {
    return r.state === 'pending_followback' || (r.state === 'unfollow_queued' && r.unfollowReason === 'no-followback'
      && r.followedBackAt === undefined && r.followbackObservedAt === undefined);
  }

  /**
   * Move one record to `followed_back`: exact at `at`, else after `after` (the interval's lower bound);
   * the hold runs from `holdFrom`, never before our own follow. A kept record only gets the stamp.
   */
  private markFollowedBack(rec: FollowRecord, at: number | null, observedAt: number, after: number | null,
    holdFrom: number = at ?? observedAt): void {
    if (rec.state === 'kept') {
      this.store.upsertFollowRecord({ ...rec, followedBackAt: at ?? rec.followedBackAt, followbackObservedAt: observedAt });
      return;
    }
    const anchor = Math.max(holdFrom, rec.followedAt ?? 0);
    this.store.upsertFollowRecord({
      ...rec,
      state: 'followed_back',
      followedBackAt: at ?? rec.followedBackAt,
      followbackAfter: at === null ? after ?? rec.followbackAfter : rec.followbackAfter,
      followbackObservedAt: observedAt,
      reconciledAt: observedAt,
      holdUntil: anchor + this.cfg.holdAfterFollowbackMs,
      unfollowDueAt: undefined,
      unfollowReason: undefined,
    });
  }

  private observeName(pk: string, username: string | null, at: number): void {
    if (username !== null) this.store.observe({ accountPk: pk, observedAt: at, source: 'activity-feed', fields: { username } });
  }

  /** A fresh dated follow event: an exact change row, the managed record at the exact time, an accept settled. */
  applyEvent(e: FollowbackEvent & { readonly atMs: number }): void {
    this.observeName(e.pk, e.username, e.atMs);
    this.store.observeOwnFollowerEvent(e.pk, this.ownPk, e.atMs);
    const rec = this.store.getFollowRecord(e.pk);
    // A historical event enriches history but never contradicts a later negative observation.
    if (rec !== null && this.canDetect(rec) && this.store.getEdge(e.pk, this.ownPk, 'follows')?.status === 'active') {
      this.markFollowedBack(rec, e.atMs, this.clock.now(), null);
    }
    this.settleChannels?.({ follower: { pk: e.pk, atMs: e.atMs } });
  }

  /** An undated event: its name only; a managed record moves unless its edge was seen removed. */
  applyUndated(e: FollowbackEvent): void {
    const now = this.clock.now();
    this.observeName(e.pk, e.username, now);
    const rec = this.store.getFollowRecord(e.pk);
    if (rec !== null && this.canDetect(rec) && this.store.getEdge(e.pk, this.ownPk, 'follows')?.status !== 'removed') {
      this.markFollowedBack(rec, null, now, null);
    }
  }

  /** A requester row: its account facts and an open `requests` edge; an accept still listed did not land. */
  applyRequester(r: { readonly pk: string; readonly observation: Observation }, at: number): void {
    this.store.observe(r.observation);
    this.store.observeEdge(r.pk, this.ownPk, 'requests', true, at);
    this.settleChannels?.({ stillRequesting: { pk: r.pk, at } });
  }

  /** An accepted request: they follow us from the accept (an exact row); a managed requester followed back. */
  applyAccepted(a: FollowbackAccepted & { readonly at: number }): void {
    if (a.pk === null) {
      warn('followback: accepted request has no resolved pk', { username: a.username });
      return;
    }
    this.store.observe({ accountPk: a.pk, observedAt: a.at, source: 'friend-requests', fields: { username: a.username } });
    this.store.observeOwnFollowerEvent(a.pk, this.ownPk, a.at, 'accept');
    const rec = this.store.getFollowRecord(a.pk);
    if (rec !== null && this.canDetect(rec)) this.markFollowedBack(rec, a.at, a.at, null);
  }

  /**
   * Store-only (spec §9.3): a managed record whose follower edge is active with a gain ending at or after
   * our follow moves to `followed_back` with that gain's interval. Returns how many moved.
   */
  consistencyPass(now: number): number {
    let moved = 0;
    for (const rec of this.store.activeFollowRecords()) {
      if (!this.canDetect(rec) && rec.state !== 'kept') continue;
      if (rec.state === 'kept' && rec.followbackObservedAt !== undefined) continue;
      if (this.store.getEdge(rec.accountPk, this.ownPk, 'follows')?.status !== 'active') continue;
      const gain = this.store.growth.latestGain(rec.accountPk);
      if (gain === null || gain.hi < (rec.followedAt ?? 0)) continue;
      const exact = gain.lo === gain.hi ? gain.hi : null;
      this.markFollowedBack(rec, exact, now, exact === null ? Math.max(gain.lo, rec.followedAt ?? 0) : null, gain.hi);
      moved += 1;
    }
    if (moved > 0) info('followback: the graph already held follow-backs', { moved });
    return moved;
  }
}
