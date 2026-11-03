/**
 * The frontier sweep (spec §9.2–9.6, ADR 0213): one writer of `meta.reopen_state`. Steps run in the
 * contract's order — profile, notifications (+ requests), followers head, following, consistency — each
 * decided by `decideStep` from the facts the earlier ones wrote, and each frontier is persisted only
 * after its step's facts commit. A failure ends its step only; a stop keeps the finished frontiers.
 */

import type { FeedFailure, FeedSource } from '../rim/feed-source';
import type { HeadWalkArgs, HeadWalkResult } from '../rim/followers-head';
import type { FollowingCheckResult } from '../rim/following-check';
import type { AwaySummary, CatchUpStepId, CatchUpView, StepState } from '../shared/reopen-view';
import type { FeedWatermark, ReopenState, SweepMode } from '../store/repos/reopen-state';
import type { Observation } from '../store/types';
import * as log from '../utils/logger';
import type { FollowbackAccepted, FollowbackEvent } from './followback-types';
import { decideStep, type StepDecision, type StepInputs, type SweepStepId } from './sweep-plan';

/** The plan at the sweep's start, as the sweep reads it. */
export interface SweepPlanView {
  readonly checkSpacingMs: number;
  readonly clockToleranceMs: number;
  readonly light: boolean;
  readonly catchUp: { readonly profiles: number; readonly notifications: number; readonly pages: number };
  /** Head-walk pages a session or check pass may read, and the following check's pages. */
  readonly checkPages: number;
  readonly followingPages: number;
  acceptsAllowed(pending: number): number;
  readonly planDayKey: string;
  readonly planDayStartsAt: number;
}

/** The counts a sweep window summarizes (the store computes them). */
export interface SweepTally {
  readonly followers: { readonly before: number | null; readonly after: number | null };
  readonly following: { readonly before: number | null; readonly after: number | null };
  readonly newFollowers: number;
  readonly followBacks: number;
  readonly lostIdentified: number;
  readonly unattributed: number;
  readonly requestsWaiting: number;
  readonly journalPending: number;
}

/** The store port: the frontiers, the reads that size the steps, and the per-fact appliers. */
export interface SweepFacts {
  state(): ReopenState | null;
  persist(s: ReopenState): void;
  ensureBaseline(at: number): void;
  lastHeaderAt(): number | null;
  /** The last verified-complete followers census, and the earliest a never-seen follower can have arrived. */
  censusAt(): number | null;
  gainFloor(at: number): number;
  /** Followers identified since the frontier, and the header's gains they leave unexplained (only with a header). */
  headNeed(frontierAt: number | null, withHeader: boolean): { identifiedSinceFrontier: number; unexplainedGains: number };
  /** The following count's change since `since` that Epo's writes do not explain (signed). */
  followingResidual(since: number | null): number;
  censusReadFollowingSince(t: number): boolean;
  activeRequests(): readonly string[];
  endRequest(pk: string, at: number): void;
  tally(from: number, to: number): SweepTally;
  applyEvent(e: FollowbackEvent & { readonly atMs: number }): void;
  applyUndated(e: FollowbackEvent): void;
  applyRequester(r: { readonly pk: string; readonly observation: Observation }, at: number): void;
  applyAccepted(a: FollowbackAccepted & { readonly at: number }): void;
  consistencyPass(now: number): number;
}

export interface SweepPorts {
  readonly clock: { now(): number };
  readonly ownPk: string;
  /** When this launch began (a launch sweep consumes a header observed since then). */
  readonly launchAt: number;
  readonly plan: { view(now: number): SweepPlanView };
  readonly header: {
    /** The landing, if it has not run behind the splash. */
    land(signal: AbortSignal): Promise<boolean>;
    visit(use: 'catch-up' | 'check', signal: AbortSignal): Promise<'ok' | 'read-budget' | 'failed'>;
  };
  readonly feed: FeedSource;
  readonly head: (a: HeadWalkArgs) => Promise<HeadWalkResult>;
  readonly following: (a: { readonly ownPk: string; readonly signal: AbortSignal }) => Promise<FollowingCheckResult>;
  readonly facts: SweepFacts;
  readonly autoAccept: () => boolean;
  readonly report?: (v: CatchUpView) => void;
  readonly onCaughtUp?: (s: AwaySummary) => void;
}

export interface SweepResult {
  readonly mode: SweepMode;
  readonly steps: CatchUpView['steps'];
  readonly summary: AwaySummary | null;
}

const ORDER: readonly SweepStepId[] = ['profile', 'notifications', 'followers-head', 'following', 'consistency'];
const SHOWN: readonly CatchUpStepId[] = ['profile', 'notifications', 'followers-head'];
const EMPTY: ReopenState = { v: 1, feed: null, head: null, requests: null, lastSweep: null, lastCatchUp: null, following: null };
const IDLE: CatchUpView = { state: 'idle', mode: null, skipped: null, isReturn: false, since: null, startedAt: null,
  finishedAt: null, steps: SHOWN.map((id) => ({ id, step: { state: 'pending' } })), summary: null };

const FEED_WHY: Record<string, Extract<StepState, { state: 'failed' }>['why']> = {
  'read-budget': 'read-budget', walled: 'walled', 'feed-shape-drift': 'drift', 'control-not-located': 'tab',
  'no-response': 'unreadable', 'body-unreadable': 'unreadable', aborted: 'aborted',
};
const feedWhy = (r: FeedFailure): Extract<StepState, { state: 'failed' }>['why'] =>
  FEED_WHY[r] ?? (r.startsWith('sentinel:') ? 'walled' : 'unreadable');
const headWhy = (o: HeadWalkResult['outcome']): Extract<StepState, { state: 'failed' }>['why'] =>
  o === 'read-budget' ? 'read-budget' : o === 'shape-mismatch' ? 'drift' : o === 'stopped' ? 'aborted'
    : o.startsWith('sentinel:') ? 'walled' : 'unreadable';

/** The per-sweep working set the steps share. */
interface Pass {
  state: ReopenState;
  headerThisSweep: boolean;
  feedGapThisSweep: boolean;
  headGap: boolean;
  outsideEpo: number | null;
}

export class FrontierSweep {
  private current: CatchUpView = IDLE;

  constructor(private readonly p: SweepPorts) {}

  /** The last sweep as the status shows it (pure). */
  view(): CatchUpView { return this.current; }

  /** The plan's check anchor (spec C11): the last sweep's end, never a read debit. */
  lastSweepEndedAt(): number | null { return this.p.facts.state()?.lastSweep?.endedAt ?? null; }

  async run(mode: SweepMode, signal: AbortSignal): Promise<SweepResult> {
    const { clock, facts } = this.p;
    const startedAt = clock.now();
    facts.ensureBaseline(startedAt);
    const stored = facts.state();
    const pass: Pass = { state: stored ?? EMPTY, headerThisSweep: false, feedGapThisSweep: false, headGap: false, outsideEpo: null };
    const from = pass.state.lastSweep?.endedAt ?? null;
    const plan = this.p.plan.view(startedAt);
    const budget = mode === 'launch' ? { ...plan.catchUp, followingPages: 0 }
      : { profiles: 1, notifications: 1, pages: plan.checkPages, followingPages: plan.followingPages };
    // On the upgrade launch (no reopen state yet) the head has no frontier: one page initializes it.
    const frontierAt = stored === null ? null : (pass.state.head?.walkedAt ?? facts.censusAt());
    const steps = new Map<CatchUpStepId, StepState>(SHOWN.map((id) => [id, { state: 'pending' }]));
    const publish = (state: CatchUpView['state'], summary: AwaySummary | null = null): void => {
      this.current = { state, mode, skipped: null, isReturn: mode === 'launch', since: from, startedAt,
        finishedAt: state === 'done' ? clock.now() : null, steps: SHOWN.map((id) => ({ id, step: steps.get(id) as StepState })), summary };
      this.p.report?.(this.current);
    };
    const mark = (id: SweepStepId, s: StepState): void => {
      if ((SHOWN as readonly string[]).includes(id)) steps.set(id as CatchUpStepId, s);
    };
    const inputs = (): StepInputs => {
      const requests = facts.activeRequests().length;
      const need = facts.headNeed(frontierAt, pass.headerThisSweep);
      return { now: clock.now(), mode, light: plan.light, launchAt: this.p.launchAt, checkSpacingMs: plan.checkSpacingMs,
        clockToleranceMs: plan.clockToleranceMs, state: pass.state, lastHeaderAt: facts.lastHeaderAt(),
        headerThisSweep: pass.headerThisSweep, budget, feedGapThisSweep: pass.feedGapThisSweep,
        need: { ...need, rowsPerPage: pass.state.head?.rowsPerPage ?? null, pagesAvailable: budget.pages },
        followingResidual: facts.followingResidual(pass.state.following?.checkedAt ?? null),
        planDayStartsAt: plan.planDayStartsAt, planDayKey: plan.planDayKey,
        censusReadFollowingToday: facts.censusReadFollowingSince(plan.planDayStartsAt),
        // The pending count is the panel's own rows (the accept loop ends with them), so the plan's caps alone bound it.
        autoAccept: this.p.autoAccept(), acceptsAllowed: plan.acceptsAllowed(Number.POSITIVE_INFINITY), activeRequestEdges: requests };
    };
    publish('running');
    for (const id of ORDER) {
      if (signal.aborted) break;
      const decision = decideStep(id, inputs());
      if (!decision.run) {
        mark(id, { state: 'skipped', why: decision.why });
        continue;
      }
      mark(id, { state: 'running' });
      publish('running');
      mark(id, await this.step(decision, mode, pass, frontierAt, plan, signal));
    }
    if (signal.aborted) {
      publish('idle');
      return { mode, steps: this.current.steps, summary: null };
    }
    const endedAt = clock.now();
    // A first sweep summarizes from where measurement began.
    const summary = this.summarize(mode, pass, from ?? facts.gainFloor(startedAt), endedAt);
    pass.state = { ...pass.state, lastSweep: { id: (pass.state.lastSweep?.id ?? 0) + 1, mode, startedAt, endedAt },
      ...(mode === 'launch' ? { lastCatchUp: summary } : {}) };
    facts.persist(pass.state);
    publish('done', summary);
    log.info('engine.frontier-sweep: sweep done', { mode, steps: this.current.steps.map((s) => `${s.id}:${s.step.state}`).join(' '),
      newFollowers: summary.newFollowers, followBacks: summary.followBacks, gaps: summary.gaps });
    if (mode === 'launch') this.p.onCaughtUp?.(summary);
    return { mode, steps: this.current.steps, summary };
  }

  /** One decided step; its frontier is persisted after its facts. */
  private async step(d: Extract<StepDecision, { run: true }>, mode: SweepMode, pass: Pass, frontierAt: number | null,
    plan: SweepPlanView, signal: AbortSignal): Promise<StepState> {
    const { clock, facts } = this.p;
    const use = mode === 'launch' ? 'catch-up' : 'check';
    const persist = (s: ReopenState): void => {
      pass.state = s;
      facts.persist(s);
    };
    switch (d.id) {
      case 'profile': {
        const fresh = (): boolean => (facts.lastHeaderAt() ?? Number.NEGATIVE_INFINITY) >= this.p.launchAt;
        if (mode === 'launch' && (fresh() || (await this.p.header.land(signal) && fresh()))) {
          pass.headerThisSweep = true;
          return { state: 'done', found: 0 };
        }
        if (mode === 'launch' && plan.catchUp.profiles <= 0) return { state: 'skipped', why: 'no-budget' };
        const r = await this.p.header.visit(use, signal);
        if (r === 'ok') pass.headerThisSweep = true;
        return r === 'ok' ? { state: 'done', found: 0 } : { state: 'failed', why: r === 'read-budget' ? 'read-budget' : 'unreadable' };
      }
      case 'notifications':
        return this.drawer(d, use, pass, plan, signal, persist);
      case 'followers-head': {
        const res = await this.p.head({ ownPk: this.p.ownPk, frontierAt, floor: facts.gainFloor(clock.now()),
          maxPages: d.maxPages ?? 0, use, prior: pass.state.head, signal });
        if (res.next === null) return { state: 'failed', why: headWhy(res.outcome) };
        const consumed = res.outcome !== 'gap';
        persist({ ...pass.state, head: res.next,
          feed: consumed && pass.state.feed !== null ? { ...pass.state.feed, gap: null } : pass.state.feed });
        pass.headGap = !consumed;
        return { state: 'done', found: res.newRows };
      }
      case 'following': {
        const res = await this.p.following({ ownPk: this.p.ownPk, signal });
        if (!res.ok) {
          log.info('engine.frontier-sweep: the following check ended early', { reason: res.reason });
          return { state: 'failed', why: res.reason === 'read-budget' ? 'read-budget' : 'unreadable' };
        }
        persist({ ...pass.state, following: { checkedAt: clock.now(), count: res.count, complete: true } });
        pass.outsideEpo = res.added - res.removed;
        return { state: 'done', found: res.added + res.removed };
      }
      case 'consistency':
        return { state: 'done', found: facts.consistencyPass(clock.now()) };
    }
  }

  /** The drawer pass: per-fact appliers, the requests verdict from a complete panel, the watermark after. */
  private async drawer(d: Extract<StepDecision, { run: true }>, use: 'catch-up' | 'check', pass: Pass, plan: SweepPlanView,
    signal: AbortSignal, persist: (s: ReopenState) => void): Promise<StepState> {
    const { clock, facts } = this.p;
    const prior: FeedWatermark | null = pass.state.feed;
    const listed = new Set<string>();
    const res = await this.p.feed.fetchSince(prior, { use, signal, panel: d.panel ?? null,
      onEvent: (e) => (e.atMs === null ? facts.applyUndated(e) : facts.applyEvent({ ...e, atMs: e.atMs })),
      onUndated: (e) => facts.applyUndated(e),
      onRequester: (r) => {
        listed.add(r.pk);
        facts.applyRequester(r, clock.now());
      },
      onAccepted: (a) => facts.applyAccepted(a) });
    const now = clock.now();
    if (!res.ok) {
      // A failure ends this step only: the watermark is kept; an opened drawer stamps its read time.
      if (res.opened) persist({ ...pass.state, feed: { ...(prior ?? { atMs: 0, keysAtMs: [], filteredAt: null, gap: null }), readAt: now } });
      return { state: 'failed', why: feedWhy(res.reason) };
    }
    const r = res.requesters;
    const complete = r.source === 'panel' && r.complete;
    // The only absence verdict on requests: a complete panel without them.
    if (complete) for (const pk of facts.activeRequests()) if (!listed.has(pk)) facts.endRequest(pk, now);
    pass.feedGapThisSweep = res.next.gap !== null && JSON.stringify(res.next.gap) !== JSON.stringify(prior?.gap ?? null);
    persist({ ...pass.state, feed: res.next, requests: { observedAt: now,
      count: r.source === 'none' ? facts.activeRequests().length : r.count, complete,
      verifiedDayKey: complete ? plan.planDayKey : pass.state.requests?.verifiedDayKey ?? null } });
    return { state: 'done', found: res.fresh };
  }

  private summarize(mode: SweepMode, pass: Pass, from: number, to: number): AwaySummary {
    const t = this.p.facts.tally(from, to);
    const requests = pass.state.requests;
    return { sweepId: (pass.state.lastSweep?.id ?? 0) + 1, from, to, isReturn: mode === 'launch',
      followers: t.followers, following: { ...t.following, outsideEpo: pass.outsideEpo },
      newFollowers: t.newFollowers, followBacks: t.followBacks, lostIdentified: t.lostIdentified, unattributed: t.unattributed,
      requestsWaiting: t.requestsWaiting > 0 || (requests !== null && requests.count > 0)
        ? { count: Math.max(t.requestsWaiting, requests?.count ?? 0), atLeast: requests?.complete !== true } : null,
      gaps: { feed: (pass.state.feed?.gap ?? null) !== null, head: pass.headGap },
      backfilled: null, journalPending: t.journalPending };
  }
}
