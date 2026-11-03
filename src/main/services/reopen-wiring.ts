/**
 * The reopen wiring: the re-entry supervisor, the follow-back appliers, and the frontier sweep over the
 * notifications drawer, the followers head and the following check (spec §9), with the sweep's cadence
 * anchored on its own persisted end.
 */

import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { FrontierSweep, type SweepPlanView } from '@/engine/frontier-sweep';
import type { SweepCadence } from '@/engine/ports';
import { ReentrySupervisor } from '@/engine/reentry';
import type { SystemClock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { ReadBudget } from '@/governors/read-budget';
import { checkSpacingMs } from '@/kernel/plan/reads';
import { BOUNDS_REENTRY } from '@/kernel/reentry-policy';
import { CLOCK_TOLERANCE_MS } from '@/kernel/tempo-policy';
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
import { sweepFacts } from './sweep-facts';

/** The re-entry supervisor over the graph's store. */
export function wireReentry(store: KnowledgeStore, clock: SystemClock): ReentrySupervisor {
  return new ReentrySupervisor({ store, clock });
}

/** Expiry is eligibility for reconciliation, not evidence of a missing follow-back. */
export function prepareReentry(reentry: ReentrySupervisor, clock: SystemClock): void {
  reentry.prepare(clock.now());
}

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
  /** The plan service and its plan-day boundary (spec §4.4). */
  plan: Pick<PlanWiring, 'service' | 'dayClock'>;
  rate: Pick<RateGovernor, 'actionsInLastHour'>;
}

/** The appliers (live config), the frontier sweep the engine runs, and its cadence. */
export interface FollowbackParts {
  readonly watcher: FollowbackWatcher;
  readonly sweep: FrontierSweep;
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

/** The follow-back appliers and the frontier sweep over the drawer, the head walk and the following check. */
export function wireFollowback(d: GraphBuildDeps, w: FollowbackWiring): FollowbackParts {
  const { store, clock, ownPk, settings, readBudget, policy, adapter, reader, sentinel, walker } = w;
  const feed = new AdapterBackedFollowNotifications({ readBudget, ownPk, canAccept: policy.canAccept,
    onAccepted: policy.onAccepted, tab: d.tab, actor: adapter.actor, reader, sentinel, store,
    abortSignal: d.driverSignal, reporter: d.reporter });
  const watcher = new FollowbackWatcher({ store, clock, ownPk, cfg: toFollowbackConfig(settings),
    // An open accept settles from what the drawer saw, with zero reads (spec §9.8).
    settleChannels: (e) => { settleFromChannels({ store, ownPk, now: clock.now() }, e); } });
  const sweep = new FrontierSweep({
    clock, ownPk, launchAt: clock.now(), plan: sweepPlan(d, w), feed, facts: sweepFacts(store, ownPk, watcher),
    header: {
      // The landing runs behind the splash (boot); a sweep reads the header with one own-profile visit.
      land: async () => false,
      visit: async () => {
        const r = await policy.refreshOwnStats();
        return r.ok ? 'ok' : r.reason === 'read-budget' ? 'read-budget' : 'failed';
      },
    },
    head: (a) => walkFollowersHead({ walker, facts: storeHeadFacts(store, ownPk), clock, sentinel }, a),
    following: (a) => checkFollowing({ walker, facts: storeFollowingFacts(store, ownPk), clock, sentinel }, a),
    autoAccept: () => d.resolveSettings().autoAcceptFollowRequests,
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
  return { watcher, sweep, cadence };
}

/** A verified mutation: the re-entry supervisor notes it and the progress seam hears it. */
export function noteMutationFor(
  reentry: ReentrySupervisor,
  clock: SystemClock,
  d: Pick<GraphBuildDeps, 'onProgress'>,
): () => void {
  const noteMutation = (): void => {
    reentry.noteAction(clock.now());
    d.onProgress?.('mutation-verified');
  };
  return noteMutation;
}

/** The requester predicate churn's selection reads (spec §9.9): an open request into our account, live. */
export function requesterPredicate(store: Pick<KnowledgeStore, 'hasActiveRequest'>): (pk: string) => boolean {
  return (pk) => store.hasActiveRequest(pk);
}

/** The reopen wiring's startup steps and status contributors (the reopen stream fills them). */
export function reopenWiringParts(): WiringParts {
  return { startupSteps: [], statusContributors: [] };
}
