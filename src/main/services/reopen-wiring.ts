/**
 * The reopen wiring: the follow-back appliers and the frontier sweep over the notifications drawer, the
 * followers head and the following check (spec §9), with the sweep's cadence anchored on its own persisted end.
 */

import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { Engine } from '@/engine/engine';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { FrontierSweep, type SweepPlanView } from '@/engine/frontier-sweep';
import type { SweepCadence } from '@/engine/ports';
import type { SystemClock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { ReadBudget } from '@/governors/read-budget';
import { checkSpacingMs } from '@/kernel/plan/reads';
import { BOUNDS_REENTRY } from '@/kernel/reentry-policy';
import { CLOCK_TOLERANCE_MS } from '@/kernel/tempo-policy';
import { type CatchUpAdmission, type CatchUpState, catchUpAdmission, catchUpStep } from '@/main/modules/catch-up';
import { AdapterBackedFollowNotifications } from '@/rim/follow-notifications';
import { storeHeadFacts, walkFollowersHead } from '@/rim/followers-head';
import { checkFollowing, storeFollowingFacts } from '@/rim/following-check';
import { settleFromChannels } from '@/rim/journal-settlement';
import type { ListPageWalker } from '@/rim/list-page-walker';
import { toPlanIntent } from '@/settings/plan-intent';
import { type Settings, toFollowbackConfig } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { GraphBuildDeps, WiringParts } from './graph-types';
import type { createMutationPolicy } from './mutation-policy';
import type { PlanWiring } from './plan-wiring';
import { type ReopenStatusDeps, reopenContributors } from './reopen-status';
import { sweepFacts } from './sweep-facts';

/** What the sweep is built from (the graph's shared pieces). */
export interface FollowbackWiring {
  store: KnowledgeStore;
  clock: SystemClock;
  ownPk: string;
  settings: Settings;
  readBudget: ReadBudget;
  policy: ReturnType<typeof createMutationPolicy>;
  adapter: InstagramAdapter;
  reader: Reader;
  sentinel: Sentinel;
  /** The composed list walker the head walk and the following check page with. */
  walker: ListPageWalker;
  /** The plan service, its plan-day boundary (spec §4.4) and its tempo (the drawer's waits follow the session). */
  plan: Pick<PlanWiring, 'service' | 'dayClock' | 'tempo'>;
  rate: Pick<RateGovernor, 'actionsInLastHour'>;
}

/** The appliers (live config), the frontier sweep the engine runs, its cadence, and the reopen parts. */
export interface FollowbackParts {
  readonly watcher: FollowbackWatcher;
  readonly sweep: FrontierSweep;
  /** The catch-up step and the reopen status contributors, once the engine (its recovery ladder) exists. */
  parts(engine: Pick<Engine, 'status'>): WiringParts;
  readonly cadence: SweepCadence;
}

/** The plan at an instant, as the sweep reads it: spacing, Boost, the catch-up and check pages, the accepts. */
function sweepPlan(d: Pick<GraphBuildDeps, 'plan'>, w: FollowbackWiring): { view(now: number): SweepPlanView } {
  return {
    view: (now) => {
      const v = w.plan.service.view(now);
      return {
        checkSpacingMs: checkSpacingMs(v.tempo, toPlanIntent(d.plan.settings.effective())),
        clockToleranceMs: CLOCK_TOLERANCE_MS, light: v.checkLight(), catchUp: v.plan.reads.catchUp,
        checkPages: v.open?.readsLeft.checkPages ?? BOUNDS_REENTRY.FRONTIER_PAGES_MAX, followingPages: v.plan.reads.following,
        acceptsAllowed: (pending) => v.acceptsAllowed(pending, w.rate.actionsInLastHour()),
        planDayKey: w.plan.dayClock.dayKey(now), planDayStartsAt: v.window.startsAt,
      };
    },
  };
}

/**
 * Once, at the first build without a reopen state (spec §9.11): the v1 sweep stamp the settings migration carried
 * for this account and the legacy lifecycle_state seed the last sweep's end; the settings then drop the stamp.
 */
export function seedReopenState(store: Pick<KnowledgeStore, 'reopen'>, ownPk: string, bk: GraphBuildDeps['bookkeeping']): void {
  const carried = bk?.take() ?? null;
  const mine = carried !== null && (carried.forPk === null || carried.forPk === ownPk) ? carried : null;
  store.reopen.seedFromLegacy({ sweepLastRunAt: mine?.sweepLastRunAt ?? null });
  if (mine !== null) bk?.consume();
}

/** The follow-back appliers and the frontier sweep over the drawer, the head walk and the following check. */
export function wireFollowback(d: GraphBuildDeps, w: FollowbackWiring): FollowbackParts {
  const { store, clock, ownPk, settings, readBudget, policy, adapter, reader, sentinel, walker } = w;
  seedReopenState(store, ownPk, d.bookkeeping);
  const feed = new AdapterBackedFollowNotifications({ readBudget, ownPk, canAccept: policy.canAccept,
    onAccepted: policy.onAccepted, tab: d.tab, actor: adapter.actor, reader, sentinel, store,
    abortSignal: d.driverSignal, reporter: d.reporter, tempo: w.plan.tempo });
  const watcher = new FollowbackWatcher({ store, clock, ownPk, cfg: toFollowbackConfig(settings),
    // An open accept settles from what the drawer saw, with zero reads (spec §9.8).
    settleChannels: (e) => { settleFromChannels({ store, ownPk, now: clock.now() }, e); } });
  const facts = sweepFacts(store, ownPk, watcher);
  const sweep = new FrontierSweep({
    clock, ownPk, launchAt: clock.now(), plan: sweepPlan(d, w), feed, facts,
    header: {
      // BL's landing when it did not run behind the splash; then at most one own-profile visit.
      land: async (signal) => {
        if (d.launch === undefined) return false;
        await d.launch.land(signal);
        return true;
      },
      visit: async () => {
        const r = await policy.refreshOwnStats();
        return r.ok ? 'ok' : r.reason === 'read-budget' ? 'read-budget' : 'failed';
      },
    },
    head: (a) => walkFollowersHead({ walker, facts: storeHeadFacts(store, ownPk), clock, sentinel }, a),
    following: (a) => checkFollowing({ walker, facts: storeFollowingFacts(store, ownPk), clock, sentinel }, a),
    autoAccept: () => d.resolveSettings().autoAcceptFollowRequests,
    // Every step's transition reaches the status at once (spec §9.6 output).
    report: () => d.plan.pushStatus(),
  });
  const cadence: SweepCadence = {
    isDue: (now, everyMs) => {
      const last = sweep.lastSweepEndedAt();
      return last === null || now - last >= everyMs;
    },
    // The sweep persisted its own end (one writer of reopen_state).
    markRun: () => {},
    lastSweepEndedAt: () => sweep.lastSweepEndedAt(),
  };
  const parts = (engine: Pick<Engine, 'status'>): WiringParts => reopenWiringParts(d, { sweep, ownPk, sentinel, clock, engine,
    contributors: { store, sweep, dayClock: w.plan.dayClock, followingResidual: facts.followingResidual } });
  return { watcher, sweep, cadence, parts };
}

/** A verified mutation: the progress seam hears it (probation is the plan's, from the ledger). */
export function noteMutationFor(d: Pick<GraphBuildDeps, 'onProgress'>): () => void {
  return () => d.onProgress?.('mutation-verified');
}

/** The requester predicate churn's selection reads (spec §9.9): an open request into our account, live. */
export function requesterPredicate(store: Pick<KnowledgeStore, 'hasActiveRequest'>): (pk: string) => boolean {
  return (pk) => store.hasActiveRequest(pk);
}

/** The recovery ladder's posture at `now`: a hold whose deadline passed is probing (the engine's next step decides). */
function ladderAt(engine: Pick<Engine, 'status'>, now: number): CatchUpState['recovery'] {
  const r = engine.status().recovery;
  if (r === null) return 'idle';
  return r.phase === 'holding' && (r.resumeAt === null || r.resumeAt > now) ? 'holding' : 'probing';
}

/** The reopen wiring's startup step (the launch catch-up, given a launch port) and its status contributors. */
export function reopenWiringParts(d: Pick<GraphBuildDeps, 'launch'>, r: {
  sweep: FrontierSweep; ownPk: string; sentinel: Pick<Sentinel, 'check'>; clock: { now(): number };
  engine: Pick<Engine, 'status'>; contributors: ReopenStatusDeps;
}): WiringParts {
  const launch = d.launch;
  const admit = async (): Promise<CatchUpAdmission> => {
    if (launch === undefined) return { run: false, why: 'blocked' };
    const pk = await launch.signedInPk();
    return catchUpAdmission({ identity: pk === null ? 'missing' : pk === r.ownPk ? 'confirmed' : 'changed',
      online: launch.online(), sentinel: await r.sentinel.check(), recovery: ladderAt(r.engine, r.clock.now()), block: launch.block() });
  };
  return {
    startupSteps: launch === undefined ? [] : [catchUpStep(r.sweep, admit, launch)],
    statusContributors: reopenContributors(r.contributors),
  };
}
