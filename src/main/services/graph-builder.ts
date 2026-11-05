/** Compose one store, plan, activity clock and set of live ports for the signed-in account. */

import * as path from 'node:path';
import { InstagramAdapter } from '@/adapter/instagram-adapter';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { ChainController, type TargetDiscovery } from '@/engine/chain-controller';
import { createEngine, type EngineUnfollowFeed } from '@/engine/engine';
import {
  createPruneEngine, type PruneEngine, type PruneOwnFollowers, type PruneOwnFollowing, type PruneScanFetch,
} from '@/engine/prune-engine';
import { Scanner } from '@/engine/scanner';
import { SourceFrontier } from '@/engine/source-frontier';
import { SystemClock } from '@/governors/clock';
import { sourceCohortSize, sourceQueueCapacity } from '@/kernel/derive-source-quality';
import { STORE_POLICY } from '@/kernel/store-policy';
import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import { AdapterBackedAcquisition } from '@/rim/follower-acquisition';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { AdapterBackedOwnFollowersSource } from '@/rim/own-followers-source';
import { AdapterBackedOwnFollowersTargetSource } from '@/rim/own-followers-target-source';
import { AdapterBackedOwnFollowingSource } from '@/rim/own-following-source';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import { TabProfileVisitor } from '@/rim/profile-visit';
import { SpacedListPageWalker } from '@/rim/spaced-list-walker';
import { StoreBackedTargetDiscovery } from '@/rim/target-discovery';
import {
  toChainConfig, toRateGovernorConfig, toScannerConfig, toScorerConfig,
} from '@/settings/mappers';
import { KnowledgeStore } from '@/store/knowledge-store';
import { DelayManager } from '@/timing/delay-manager';
import { cryptoUniform } from '@/utils/entropy';
import * as logger from '@/utils/logger';
import { liveWiringParts } from './live-wiring';
import { planWiringParts, wirePlan } from './plan-wiring';
import { noteMutationFor, wireFollowback } from './reopen-wiring';
import { surfaceGateOf, surfaceWiringParts, wireSurface } from './surface-wiring';
import { journalSettler, pruneUnfollowDeps, unfollowWiringParts, wireChurn, wireMutationPolicy } from './unfollow-wiring';

export type { BuiltGraph, GraphBuildDeps } from './graph-types';

import type { BuiltGraph, GraphBuildDeps } from './graph-types';

export function buildGraph(
  ownPk: string,
  given: string | undefined,
  d: GraphBuildDeps,
): BuiltGraph {
  const store = new KnowledgeStore(path.join(d.userDataDir, d.dbFile), { policy: STORE_POLICY, rng: cryptoUniform });
  store.setOwnPk(ownPk);
  const ownUsername = given ?? store.getAccount(ownPk)?.username;
  const clock = new SystemClock();
  const delays = new DelayManager({ clock });
  const { settings, driverSignal } = d;
  const plan = wirePlan(store, clock, ownPk, delays, d);
  const frontier = new SourceFrontier({ store, clock, planDay: plan.dayClock,
    outcomeWindowMs: () => d.resolveSettings().maxWaitForFollowbackDays * 86_400_000,
    quality: { scorer: () => toScorerConfig(d.resolveSettings()), readyCount: () => sourceCohortSize(d.resolveSettings()),
      capacity: () => sourceQueueCapacity(d.resolveSettings().dailyPlanSize) } });
  const readBudget = plan.readBudget;
  const rate = plan.rateGovernor(toRateGovernorConfig(settings));

  const interactor = createTabInteractor(d.tab, {
    abortSignal: driverSignal,
    observer: d.cursorObserver, tempo: plan.tempo,
  });

  const policy = wireMutationPolicy(d, { store, ownPk, ownUsername, clock, cadence: plan.cadence, readBudget, dayClock: plan.dayClock,
    validateFollow: (record) => frontier.allowsFollow(record),
    nextSessionAt: plan.nextSessionAt, surfaceGate: surfaceGateOf(store), cleanupRunning: () => pruneEngineRef?.status().state === 'running', profiles: () => profiles, followback: () => followback });

  const { reader, relationshipReconcilerUnsub, profileObserver, profileInfoUnsub, sink } = wireSurface({ tab: d.tab, store, ownPk, clock, day: plan.dayClock });
  const adapter = new InstagramAdapter(d.tab, {
    interactor,
    abortSignal: driverSignal, tempo: plan.tempo,
    reporter: d.reporter, sink, // an unrecognized confirm layer reaches the surface sink
    beforeMutation: policy.beforeMutation,
    prepareProfile: policy.prepareProfile,
  });
  logger.info('foundation: instagram adapter surface', {
    adapterVersion: adapter.adapterVersion,
  });
  const actor = adapter.actor;
  const sentinel = adapter.sentinel;
  const profiles = new TabProfileVisitor({
    tab: d.tab,
    observer: profileObserver,
    sentinel,
    abortSignal: driverSignal, activity: plan.activity,
  });

  const pageReader = new FollowersPageReader({
    onProgress: d.onProgress,
    readBudget,
    tab: d.tab,
    reader,
    actor,
    abortSignal: driverSignal, tempo: plan.tempo, activity: plan.activity,
    reporter: d.reporter,
  });
  const listWalker = new SpacedListPageWalker(plan.activity, {
    onProgress: d.onProgress,
    readBudget,
    tab: d.tab,
    reader,
    abortSignal: driverSignal, tempo: plan.tempo,
    reporter: d.reporter,
  });

  const acquisition = new AdapterBackedAcquisition({
    onProgress: d.onProgress,
    readBudget,
    pageReader,
    store,
    sentinel,
    walker: listWalker,
    visitor: profiles,
    ownPk, tempo: plan.tempo, planDay: plan.dayClock,
  });
  const churnActions = new AdapterBackedChurnActions({
    validateIdentity: d.validateIdentity,
    adapter,
    store,
    ownPk,
    dryRun: settings.dryRun,
  });

  // An unresolved dialog fallback makes the prune port report an incomplete result.
  const liveOwnFollowers = ownUsername
    ? new AdapterBackedOwnFollowersSource({
        pageReader,
        ownUsername,
        sentinel,
        store,
        walker: listWalker,
        ownPk,
      })
    : null;

  // Both refill and fallback discovery use this sentinel-gated, paced profile enricher.
  const enricher = new AdapterBackedProfileEnricher({
    onProgress: d.onProgress,
    readBudget,
    visitor: profiles,
    store,
    sentinel,
    clock,
    abortSignal: driverSignal,
    reporter: d.reporter,
  });

  // The fallback enriches count-less own followers before choosing a source.
  const ownFollowersTarget = new AdapterBackedOwnFollowersTargetSource({
    store,
    ownPk,
    enricher,
    clock,
    minPoolSize: settings.minPoolSize, planDay: plan.dayClock,
  });

  const churn = wireChurn(d, { frontier, store, clock, rate, churnActions, ownPk, settings, dayClock: plan.dayClock, nextSessionAt: plan.nextSessionAt, reviewBound: plan.reviewBound });
  churn.advanceTimers(clock.now()); // timers that came due while Epo was closed move now, store-only (spec §9.2 T)
  const scanner = new Scanner({
    store,
    scorerCfg: toScorerConfig(settings), planDay: plan.dayClock,
    cfg: toScannerConfig(settings),
    quality: { prepare: () => frontier.refreshQuality(), usableCount: (pk) => frontier.goodQueuedCount(pk), floor: () => {
      const view = frontier.qualityView();
      return view.needsReset ? Infinity : view.floor ?? toScorerConfig(d.resolveSettings()).bandEdgeScore;
    } },
  });
  const { watcher: followback, sweep, cadence: sweepCadence, parts: reopenParts } = wireFollowback(d, { store, clock, ownPk, settings,
    readBudget, policy, adapter, reader, sentinel, walker: listWalker, plan, rate });

  // Discovery proposes observed sources; the frontier separately qualifies their candidate supply.
  const discovery: TargetDiscovery = new StoreBackedTargetDiscovery({
    store, ownPk, clock,
    outcomeWindowMs: () => d.resolveSettings().maxWaitForFollowbackDays * 86_400_000,
  });
  const chain = new ChainController({
    frontier,
    store,
    ownPk,
    discovery,
    ownFollowers: ownFollowersTarget,
    cfg: toChainConfig(settings), planDay: plan.dayClock,
  });

  // Woven prune feed: the growth loop drains unfollows from the PruneEngine's
  // scanned census, interleaved with its follows. The PruneEngine is built
  // after the engine, so the feed delegates through a ref set once it exists
  // (only ever CALLED at run time, long after both are constructed).
  let pruneEngineRef: PruneEngine | undefined;
  const unfollowFeed: EngineUnfollowFeed = {
    lastActionOutcome: () => pruneEngineRef?.lastActionOutcome() ?? null,
    nextCandidate: (now) => pruneEngineRef?.nextCandidate(now) ?? null,
    executeUnfollow: (cand, now) => (pruneEngineRef as PruneEngine).executeUnfollow(cand, now),
    atDailyCap: (now) => pruneEngineRef?.atDailyCap(now) ?? true,
  };

  // Per-install noise entropy (store meta, drawn once): seeds the engines'
  // dedicated timing-noise rngs + the stable plan-day draws.
  const installEntropy = store.installEntropy();

  const engine = createEngine({ tempo: plan.tempo,
    frontier,
    validateIdentity: d.validateIdentity,
    onProgress: d.onProgress,
    settleJournal: journalSettler(d, { store, profiles, ownPk, clock, readBudget, dayClock: plan.dayClock, nextSessionAt: plan.nextSessionAt }),
    store,
    clock,
    rate,
    sentinel,
    churn,
    scanner,
    chain,
    followback: sweep,
    acquisition,
    enricher,
    settings,
    delays,
    pacing: plan.pacing,
    unfollowFeed,
    sweepCadence,
    installEntropy,
    // The recovery ladder's tab-diagnostics port: input probe + renderer canary
    // decide tab-vs-rate-wall at entry; recoverTab is the repair. Guarded so
    // partially-shaped test tabs degrade to "healthy" no-ops.
    tabDiag: {
      probeInput: (): Promise<boolean> =>
        typeof d.tab.probeInput === 'function' ? d.tab.probeInput() : Promise.resolve(true),
      checkHealth: (): Promise<{ healthy: boolean }> =>
        typeof d.tab.checkHealth === 'function'
          ? d.tab.checkHealth()
          : Promise.resolve({ healthy: true }),
      recoverTab: (): Promise<void> =>
        d.recoverTab ? d.recoverTab('engine-diagnosis')
          : typeof d.tab.recoverTab === 'function' ? d.tab.recoverTab() : Promise.resolve(),
    },
    onStatus: (s) => d.onStatus(s),
    onHalt: (reason) => d.onHalt(reason),
  });

  // The auto-prune routine, sharing the SAME tab-backed rim (pageReader /
  // churnActions / sentinel) the growth engine uses. Both scan sources degrade
  // to a warned empty scrape when our username could not be resolved (prune
  // scans then find nothing, loudly). ONE stub for both sources: incomplete,
  // never "an empty list" — a scan against it must FAIL its completeness gate,
  // not compute a zero-candidate census.
  const unresolvedUsernameSource = (
    what: string,
  ): { fetchAllPks(): Promise<PruneScanFetch> } => ({
    fetchAllPks: async (): Promise<PruneScanFetch> => {
      logger.warn(`foundation: own username unresolved, ${what} cannot run`);
      return { pks: [], complete: false, reason: 'own-username-unresolved' };
    },
  });
  const ownFollowingSource: PruneOwnFollowing = ownUsername
    ? new AdapterBackedOwnFollowingSource({
        pageReader,
        ownUsername,
        sentinel,
        store,
        walker: listWalker,
        ownPk,
      })
    : unresolvedUsernameSource('prune scan');
  const pruneOwnFollowers: PruneOwnFollowers =
    liveOwnFollowers ?? unresolvedUsernameSource('prune followers scan');
  const noteMutation = noteMutationFor(d);
  const pruneEngine = createPruneEngine({ tempo: plan.tempo,
    onMutation: noteMutation,
    store,
    clock,
    ownPk,
    ownFollowing: ownFollowingSource,
    ownFollowers: pruneOwnFollowers,
    churnActions,
    sentinel,
    delays,
    installEntropy,
    plan: plan.prunePlan,
    onStatus: (s) => d.onPruneStatus(s),
    ...pruneUnfollowDeps(d, { settings, policy, ownUsername, dayClock: plan.dayClock }),
  });
  // Back the woven-feed adapter now that the PruneEngine exists.
  pruneEngineRef = pruneEngine;
  // Once per build: a rebuild or account switch starts from a fresh list, never a duplicate.
  const parts = [planWiringParts(plan, readBudget, store, d), reopenParts(engine), unfollowWiringParts(), surfaceWiringParts(), liveWiringParts({ frontier })];

  return {
    prepareMutation: policy.prepareMutation,
    resolveIdentity: policy.resolveIdentity,
    noteMutation,
    store,
    engine,
    acquisition,
    churnActions,
    actor,
    relationshipReconcilerUnsub,
    profileInfoUnsub,
    profiles,
    ownPk,
    ownUsername,
    clock,
    delays,
    sentinel,
    enginePromise: null,
    pruneEngine,
    prunePromise: null,
    rate,
    churn,
    scanner,
    followback,
    chain,
    plan,
    startupSteps: parts.flatMap((p) => p.startupSteps),
    statusContributors: parts.flatMap((p) => p.statusContributors),
  };
}
