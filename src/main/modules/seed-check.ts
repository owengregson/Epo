/**
 * The seed check (spec §13): typed results, and never a visit nobody asked for. A handle the store saw
 * within one weekly cycle of plan-days answers from the store; a busy tab queues the handle (the latest
 * wins, logged) and it runs once when the tab owner frees the tab; a real visit takes a profile read permit.
 */

import { ActionAbortedError } from '@/adapter/errors';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { ReadPermit } from '@/governors/read-budget';
import type { PlanDayClock } from '@/kernel/plan';
import type { BuiltGraph } from '@/main/services/graph-types';
import type { TabActivity } from '@/main/tab-activity';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import type { SeedCheckResult, SeedQueueReason } from '@/shared/seed-check';
import type { SeedStatus } from '@/shared/settings-facts';
import { WEEKDAYS } from '@/shared/settings-intent';
import { normalizeHandle } from '@/shared/unfollow-protection';
import type { AccountState, EdgeType } from '@/store/types';
import * as logger from '@/utils/logger';

export interface SeedCheckDeps {
  /** The veil's hold registry (the visit holds `seed-check`). */
  activity: Pick<TabActivity, 'with'>;
  /** Track the op so teardown drains it before closing the store. */
  trackManualOp<T>(run: () => Promise<T>): Promise<T>;
  /** The open graph, or null while the session is closed (a check never builds one). */
  graph(): BuiltGraph | null;
  /** Why a manual op may not touch the tab now (R3), or null. */
  busyDriverReason(): string | null;
  setManualDriving(on: boolean): void;
  resumeDesiredRun(): void;
  /** The seed status moved (queued, checking, settled): the facts projection re-pushes. */
  changed?(): void;
  /** The plan-day boundary the freshness window counts in (the calendar day until the plan's clock swaps in). */
  planDay?: Pick<PlanDayClock, 'window'>;
  /** The profile read permit a visit takes (absent: the graph does not expose its read budget yet). */
  readPermit?(graph: BuiltGraph): ReadPermit;
  now?(): number;
}

/** What the seed status reads from the store. */
export interface SeedStoreView {
  readonly ownPk: string;
  pkByUsername(username: string): string | null;
  getAccount(pk: string): AccountState | null;
  getEdge(srcPk: string, dstPk: string, type: EdgeType): { readonly status: 'active' | 'removed' } | null;
}

export const seedStoreView = (graph: BuiltGraph): SeedStoreView => ({
  ownPk: graph.ownPk,
  pkByUsername: (u) => graph.store.pkByUsername(u),
  getAccount: (pk) => graph.store.getAccount(pk),
  getEdge: (s, d, t) => graph.store.getEdge(s, d, t),
});

/** The tab owner's busy reasons as queue reasons. */
const QUEUE_REASON: Readonly<Record<string, SeedQueueReason>> = {
  'runtime-not-ready': 'runtime-blocked', offline: 'offline', starting: 'starting', 'manual-running': 'manual',
  'engine-running': 'engine', 'prune-running': 'prune',
};

type Unreadable = Extract<SeedCheckResult, { kind: 'unreadable' }>['why'];

export class SeedCheckService {
  private queued: { readonly handle: string; readonly why: SeedQueueReason } | null = null;
  private checking: string | null = null;
  /** This session's evidence-backed verdict: the only source of `gone`. */
  private gone: { readonly handle: string; readonly at: number; readonly evidence: 'profile-absent' | 'page-text' } | null = null;
  private readonly planDay: Pick<PlanDayClock, 'window'>;
  private readonly now: () => number;

  constructor(private readonly d: SeedCheckDeps) {
    this.planDay = d.planDay ?? calendarPlanDayClock();
    this.now = d.now ?? Date.now;
  }

  /** A check on explicit intent: from the store when fresh, queued while the tab is busy, else one visit. */
  async check(raw: string): Promise<SeedCheckResult> {
    const { handle, valid } = normalizeHandle(raw);
    if (!valid) return { kind: 'invalid-handle' };
    const graph = this.d.graph();
    if (graph === null) return this.enqueue(handle, 'signed-out');
    const stored = this.fromStore(seedStoreView(graph), handle);
    if (stored !== null) {
      if (this.queued?.handle === handle) this.queued = null;
      return stored;
    }
    const busy = this.d.busyDriverReason();
    if (busy !== null) return this.enqueue(handle, QUEUE_REASON[busy] ?? 'runtime-blocked');
    const permit = this.d.readPermit?.(graph);
    if (permit !== undefined && !permit.allowed) return this.enqueue(handle, 'read-budget');
    if (this.queued?.handle === handle) this.queued = null;
    this.checking = handle;
    this.d.changed?.();
    return this.d.trackManualOp(() => this.d.activity.with('seed-check', () => this.visit(graph, handle)));
  }

  /** The tab is free: a queued handle runs once (it queues again if the tab turned busy meanwhile). */
  onTabFree(): void {
    const q = this.queued;
    if (q === null || this.checking !== null || this.d.busyDriverReason() !== null) return;
    void this.check(q.handle).catch((e: unknown) => logger.error('seed check: the queued check failed', { error: String(e) }));
  }

  /** The seed status projection: this session's queue and verdict, else the store's last-known profile. */
  status(store: SeedStoreView | null, raw: string): SeedStatus {
    const { handle } = normalizeHandle(raw);
    if (handle === '') return { kind: 'none' };
    if (store === null) return { kind: 'loading' };
    if (this.checking === handle) return { kind: 'checking', handle };
    if (this.queued?.handle === handle) return { kind: 'queued', handle, why: this.queued.why };
    if (this.gone?.handle === handle) return { kind: 'gone', handle, at: this.gone.at, evidence: this.gone.evidence };
    const pk = store.pkByUsername(handle);
    const account = pk === null ? null : store.getAccount(pk);
    if (pk === null || account === null) return { kind: 'unseen', handle };
    return {
      kind: 'seen', handle, pk, currentUsername: account.username ?? handle, observedAt: account.statsObservedAt ?? account.lastSeenAt,
      followers: account.followers ?? null, isPrivate: account.isPrivate ?? null,
      followersVisible: account.isPrivate === undefined ? null : !account.isPrivate || this.followed(store, pk),
    };
  }

  /** A stored profile observed within one weekly cycle of plan-days, with its privacy known. */
  private fromStore(store: SeedStoreView, handle: string): SeedCheckResult | null {
    const pk = store.pkByUsername(handle);
    const a = pk === null ? null : store.getAccount(pk);
    if (pk === null || a === null || a.isPrivate === undefined || a.statsObservedAt === undefined) return null;
    if (a.statsObservedAt < this.freshSince()) return null;
    return { kind: 'ok', pk, isPrivate: a.isPrivate, followersVisible: !a.isPrivate || this.followed(store, pk),
      followers: a.followers ?? null, observedAt: a.statsObservedAt, fromStore: true };
  }

  /** The start of the plan-day a weekly cycle back: today and the six plan-days before it. */
  private freshSince(): number {
    let w = this.planDay.window(this.now());
    for (let k = 1; k < WEEKDAYS.length; k++) w = this.planDay.window(w.startsAt - 1);
    return w.startsAt;
  }

  /** A private account's followers show to an account that follows it (or asked to, today's rule). */
  private followed(store: SeedStoreView, pk: string): boolean {
    return store.getEdge(store.ownPk, pk, 'follows')?.status === 'active' || store.getEdge(store.ownPk, pk, 'requests')?.status === 'active';
  }

  private enqueue(handle: string, why: SeedQueueReason): SeedCheckResult {
    this.queued = { handle, why };
    logger.info('seed check: queued until the tab is free', { handle, why });
    this.d.changed?.();
    return { kind: 'queued', why };
  }

  private async visit(graph: BuiltGraph, handle: string): Promise<SeedCheckResult> {
    this.d.setManualDriving(true);
    try {
      const sentinel = await graph.sentinel.check();
      if (sentinel !== 'ok') return this.unreadable(handle, sentinel === 'challenge' ? 'challenge' : sentinel === 'logged-out' ? 'signed-out' : 'walled');
      return this.settle(handle, await graph.profiles.visit(handle));
    } catch (e) {
      if (e instanceof ActionAbortedError) return this.unreadable(handle, 'aborted');
      logger.error('seed check: the visit failed', { handle, error: String(e) });
      return { kind: 'unreadable', why: 'error' };
    } finally {
      this.checking = null;
      this.d.setManualDriving(false);
      this.d.resumeDesiredRun();
      this.d.changed?.();
    }
  }

  private settle(handle: string, v: ProfileVisit): SeedCheckResult {
    if (v.ok) {
      if (this.gone?.handle === handle) this.gone = null;
      const isPrivate = v.obs.fields.isPrivate === true;
      return { kind: 'ok', pk: v.obs.accountPk, isPrivate, followers: v.obs.fields.followers ?? null, observedAt: v.obs.observedAt,
        followersVisible: !isPrivate || v.viewer.following === true || v.viewer.requested === true, fromStore: false };
    }
    if (v.kind === 'gone') {
      const evidence = v.evidence ?? 'page-text';
      this.gone = { handle, at: this.now(), evidence };
      logger.warn('seed check: the profile is not available', { handle, evidence });
      return { kind: 'not-found', evidence, observedAt: this.gone.at };
    }
    return this.unreadable(handle, v.kind === 'walled' ? 'walled' : v.kind === 'unanswered' && v.detail.drift !== undefined ? 'drift'
      : v.kind === 'unanswered' ? 'no-answer' : 'error');
  }

  private unreadable(handle: string, why: Unreadable): SeedCheckResult {
    logger.warn('seed check: no verdict', { handle, why });
    return { kind: 'unreadable', why };
  }
}
