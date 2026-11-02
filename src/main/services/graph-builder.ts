/**
 * The dependency-graph construction step.
 *
 * `Foundation.build()` used to be a 400-line method reaching into `this` at
 * two dozen points; it is a free function here, taking every collaborator it
 * needs as an explicit {@link GraphBuildDeps} field. Construction ORDER is
 * load-bearing in one place only — the woven-unfollow feed closes over a
 * `pruneEngineRef` that the PruneEngine (built after the Engine) fills in;
 * that ref is only ever read at run time.
 */

import * as path from 'node:path';
import { InstagramAdapter } from '@/adapter/instagram-adapter';
import { Reader } from '@/adapter/reader';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { ChainController, type TargetDiscovery } from '@/engine/chain-controller';
import { ChurnScheduler } from '@/engine/churn-scheduler';
import {
  createEngine,
  type EngineUnfollowFeed,
} from '@/engine/engine';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import {
  createPruneEngine,
  type PruneEngine,
  type PruneOwnFollowers,
  type PruneOwnFollowing,
  type PruneScanFetch,
} from '@/engine/prune-engine';
import { ReentrySupervisor } from '@/engine/reentry';
import { Scanner } from '@/engine/scanner';
import { scoreCandidate } from '@/engine/scorer';
import { SourceFrontier } from '@/engine/source-frontier';
import { SystemClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import { ReadBudget } from '@/governors/read-budget';
import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import { reconcileEffects } from '@/rim/effect-reconciliation';
import { AdapterBackedFollowNotifications } from '@/rim/follow-notifications';
import { AdapterBackedAcquisition } from '@/rim/follower-acquisition';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { ListPageWalker } from '@/rim/list-page-walker';
import { managedRelationships } from '@/rim/managed-relationships';
import { AdapterBackedOwnFollowersSource } from '@/rim/own-followers-source';
import { AdapterBackedOwnFollowersTargetSource } from '@/rim/own-followers-target-source';
import { AdapterBackedOwnFollowingSource } from '@/rim/own-following-source';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import { ProfileObserver } from '@/rim/profile-observer';
import { TabProfileVisitor } from '@/rim/profile-visit';
import {
  installRelationshipReconciler,
  RelationshipReconciler,
} from '@/rim/relationship-reconciler';
import { StoreBackedTargetDiscovery } from '@/rim/target-discovery';
import { patternCircadianProfile } from '@/settings/pattern-map';
import {
  toChainConfig,
  toChurnConfig,
  toFollowbackConfig,
  toPacingConfig,
  toPruneConfig,
  toRateGovernorConfig,
  toScannerConfig,
  toScorerConfig,
} from '@/settings/settings';
import { KnowledgeStore } from '@/store/knowledge-store';
import { samplePhaseOffset } from '@/timing/circadian';
import { CIRCADIAN } from '@/timing/config';
import { DelayManager } from '@/timing/delay-manager';
import { type PlannerSnapshot, SessionPlanner } from '@/timing/session-planner';
import * as logger from '@/utils/logger';
import { createMutationPolicy } from './mutation-policy';

export type { BuiltGraph, GraphBuildDeps } from './graph-types';

import type { BuiltGraph, GraphBuildDeps } from './graph-types';

export function buildGraph(
  ownPk: string,
  ownUsername: string | undefined,
  d: GraphBuildDeps,
): BuiltGraph {
  const store = new KnowledgeStore(path.join(d.userDataDir, d.dbFile));
  // The store's reconciliation sink + already-following candidate exclusion
  // both anchor on our own pk.
  store.setOwnPk(ownPk);
  const clock = new SystemClock();
  const frontier = new SourceFrontier({ store, clock, outcomeWindowMs: () => d.resolveSettings().maxWaitForFollowbackDays * 86_400_000 });
  const reentry = new ReentrySupervisor({ store, clock });
  const readBudget = new ReadBudget({ store, clock });
  // The shared wait owner: growth and prune wait through ONE DelayManager
  // (keys namespaced `engine:` / `prune:`), so pending deadlines are readable
  // from a single registry.
  const delays = new DelayManager({ clock });
  const settings = d.settings;
  const driverSignal = d.driverSignal;

  const rate = new RateGovernor(store, clock, toRateGovernorConfig(settings));

  // Interactor: every Actor click/scroll becomes native input events
  // (sendInputEvent) shaped by the motion profile; the tab is the one Electron
  // seam it drives. When a cursor observer is wired (the veil's digital-cursor
  // display), the driver is decorated so every synthetic move/press also
  // reports the virtual cursor's state — pure observation, the event stream is
  // unchanged.
  const interactor = createTabInteractor(d.tab, {
    abortSignal: driverSignal,
    observer: d.cursorObserver,
  });

  const policy = createMutationPolicy({ store, ownPk, ownUsername, clock, rate, reentry, readBudget,
    profiles: () => profiles, followback: () => followback, settings: d.resolveSettings,
    signal: driverSignal, validateIdentity: d.validateIdentity, onProgress: d.onProgress });

  // The adapter owns the single Actor + Sentinel instances the whole rim shares;
  // the Reader is pure and held directly.
  const adapter = new InstagramAdapter(d.tab, {
    interactor,
    abortSignal: driverSignal,
    reporter: d.reporter,
    beforeMutation: policy.beforeMutation,
    prepareProfile: policy.prepareProfile,
  });
  // Log ONCE, at build, which Instagram surface capture this graph runs against.
  logger.info('foundation: instagram adapter surface', {
    adapterVersion: adapter.adapterVersion,
  });
  const actor = adapter.actor;
  const sentinel = adapter.sentinel;
  const reader = new Reader();

  // Heal external follow/unfollow drift from the SAME response pipeline: every
  // relationship-bearing body reconciles our own follow-status through the
  // store's leave-alone policy sink.
  const relationshipReconciler = new RelationshipReconciler({ store, ownPk, reader, clock });
  const relationshipReconcilerUnsub = installRelationshipReconciler(
    d.tab,
    relationshipReconciler,
  );

  // Always-on profile observer: ANY profile the tab loads (the startup landing
  // on our own page, dialog navigations, visits) is parsed once and stored —
  // our OWN header counts size the scan progress bars and back the census
  // coverage guard, and every other profile enriches candidate scoring. It is
  // also how a profile is READ since 2026-10-08: the visitor navigates and the
  // observer hands it the page's own profile body (no request is composed).
  const profileObserver = new ProfileObserver({ tab: d.tab, reader, store, clock });
  const profileInfoUnsub = profileObserver.start();
  const profiles = new TabProfileVisitor({
    tab: d.tab,
    observer: profileObserver,
    sentinel,
    abortSignal: driverSignal,
  });

  const pageReader = new FollowersPageReader({
    onProgress: d.onProgress,
    readBudget,
    tab: d.tab,
    reader,
    actor,
    abortSignal: driverSignal,
    reporter: d.reporter,
  });
  // The prune scan's FAST census path: direct friendships-API pagination at
  // full page size (~4× the dialog's scroll batches). The sources fall back
  // to the dialog-scroll pageReader when the direct walk cannot fetch.
  const listWalker = new ListPageWalker({
    onProgress: d.onProgress,
    readBudget,
    tab: d.tab,
    reader,
    abortSignal: driverSignal,
    reporter: d.reporter,
  });

  // Growth acquisition pages the friendships API directly (cursor-resumed,
  // demand-bounded via the walker); the dialog-scroll pageReader is its
  // fallback, and the profile visitor serves the one-off seed pk resolution.
  const acquisition = new AdapterBackedAcquisition({
    onProgress: d.onProgress,
    readBudget,
    pageReader,
    store,
    sentinel,
    walker: listWalker,
    visitor: profiles,
    ownPk,
  });
  const churnActions = new AdapterBackedChurnActions({
    validateIdentity: d.validateIdentity,
    adapter,
    store,
    ownPk,
    dryRun: settings.dryRun,
  });

  // The prune scan's whole-followers-list scraper. Needs our username for the
  // dialog fallback path; when it could not be resolved the prune port below
  // degrades to a loud incomplete result.
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

  // The profile enricher: the engine's pool-refill step fetches
  // follower/following counts for candidates the followers-list left
  // count-less, so scoring can actually decide (without it every candidate
  // scores `no-counts` and the pool never shrinks). Sentinel-gated and paced
  // internally. Constructed before the chain pieces because the fallback
  // target source also enriches a bounded sample before ranking.
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

  // The chain's fallback next-target chooser. The enricher is essential: own
  // followers arrive from list pages with NO counts, and ranking "highest
  // follower count" over all-unknowns promotes an arbitrary account.
  const ownFollowersTarget = new AdapterBackedOwnFollowersTargetSource({
    store,
    ownPk,
    enricher,
    clock,
    minPoolSize: settings.minPoolSize,
  });

  const churn = new ChurnScheduler({
    pickQueued: (records) => frontier.pickQueued(records),
    validateFollow: (record) => {
      const account = store.getAccount(record.accountPk);
      return account !== null && scoreCandidate(account, toScorerConfig(d.resolveSettings())).eligible;
    },
    store,
    clock,
    rate,
    actions: churnActions,
    ownPk,
    cfg: toChurnConfig(settings),
  });
  // Expiry is eligibility for reconciliation, not evidence of a missing follow-back.
  reentry.prepare(clock.now());
  const scanner = new Scanner({
    store,
    scorerCfg: toScorerConfig(settings),
    cfg: toScannerConfig(settings),
  });
  // Follow-back detection reads the NOTIFICATIONS feed (one click on the bell,
  // one observed news-inbox response) — cheap enough for the hourly default
  // cadence. Sentinel-gated; a stop() interrupts the response wait.
  const followNotifications = new AdapterBackedFollowNotifications({
    readBudget,
    ownPk,
    canAccept: policy.canAccept,
    onAccepted: policy.onAccepted,
    tab: d.tab,
    actor: adapter.actor,
    reader,
    sentinel,
    store,
    abortSignal: driverSignal,
    reporter: d.reporter,
  });
  const followback = new FollowbackWatcher({
    signal: driverSignal,
    relationships: managedRelationships({ clock, readBudget, profiles, signal: driverSignal,
      validateIdentity: d.validateIdentity, onProgress: d.onProgress }),
    store,
    clock,
    ownPk,
    notifications: followNotifications,
    followers: liveOwnFollowers && ownUsername ? {
      fetchAllPks: async () => {
        const refreshed = await policy.refreshOwnStats();
        if (!refreshed.ok) return { pks: [], complete: false, reason: refreshed.reason, retryAt: refreshed.retryAt };
        return liveOwnFollowers.fetchAllPks();
      },
    } : undefined,
    cfg: toFollowbackConfig(settings),
  });

  // Live discovery over the already-harvested graph: propose the biggest
  // enriched PUBLIC hubs inside the exhausted target's audience, projected at
  // that target's realized follow-back rate — zero extra requests.
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
    cfg: toChainConfig(settings),
  });

  // The follow-back sweep cadence, persisted through Settings so the rhythm
  // survives restarts (docs/PRINCIPLES.md §3). The jitter factor is persisted
  // beside it: each completed sweep redraws a bounded interval factor, so the
  // check never lands on a bare hourly grid — and a restart mid-interval keeps
  // the factor already drawn.
  const sweepCadence = d.scheduler.cadence('engine:followback-sweep', {
    getLastRunAt: () => d.resolveSettings().sweepLastRunAt,
    setLastRunAt: (at) => {
      d.updateSettings({ sweepLastRunAt: at });
    },
    jitter: {
      getFactor: () => d.resolveSettings().sweepIntervalFactor,
      setFactor: (factor) => {
        d.updateSettings({ sweepIntervalFactor: factor });
      },
    },
  });

  // Organic pacing model: a durable SessionPlanner hydrated from store meta,
  // injected ONLY when the user selected it (Settings.pacingModel). Absent →
  // the engine runs its legacy active-hours + operating-rate metronome. The
  // per-install circadian phase offset lives in the snapshot, so it is stable
  // across restarts and freshly drawn on first run.
  let pacingSnap: PlannerSnapshot | null = null;
  const pacingSnapRaw = store.getPacingState();
  if (pacingSnapRaw !== null) {
    try {
      pacingSnap = JSON.parse(pacingSnapRaw) as PlannerSnapshot;
    } catch (e) {
      logger.warn('foundation: bad pacing snapshot, starting fresh', { error: String(e) });
    }
  }
  const phaseOffset =
    pacingSnap?.phaseOffsetHours ??
    samplePhaseOffset(CIRCADIAN.PHASE_JITTER_MAX_HOURS, Math.random);
  const pacing =
    settings.pacingModel === 'organic'
      ? new SessionPlanner({
          // The circadian shape follows the user's qualitative day/week choice.
          profile: patternCircadianProfile(settings.pattern, phaseOffset),
          cfg: toPacingConfig(settings),
          snapshot: pacingSnap,
        })
      : undefined;

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
  // dedicated timing-noise rngs + the restart-stable daily-boundary jitter.
  const installEntropy = store.installEntropy();

  const engine = createEngine({
    frontier,
    reentry,
    validateIdentity: d.validateIdentity,
    onProgress: d.onProgress,
    reconcileEffects: () => reconcileEffects({ store, profiles, ownPk, clock, readBudget, signal: driverSignal }),
    store,
    clock,
    rate,
    sentinel,
    churn,
    scanner,
    chain,
    followback,
    acquisition,
    enricher,
    settings,
    delays,
    pacing,
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
  const noteMutation = (): void => {
    reentry.noteAction(clock.now());
    d.onProgress?.('mutation-verified');
  };
  const pruneEngine = createPruneEngine({
    onMutation: noteMutation,
    store,
    clock,
    ownPk,
    ownFollowing: ownFollowingSource,
    ownFollowers: pruneOwnFollowers,
    churnActions,
    sentinel,
    cfg: toPruneConfig(settings),
    delays,
    installEntropy,
    lastRunAt: settings.pruneLastRunAt,
    // A run stops at the active-hours edge instead of rolling past local
    // midnight (where the daily count re-zeroes and one run could spend 2× the
    // cap). Same governor window the growth engine parks on.
    withinActiveHours: (): boolean => rate.withinActiveHours(),
    // The prune cap shares the growth budget's boundary: the active-hours cycle
    // start, not calendar midnight.
    cycleStartMs: (now: number): number => rate.cycleStartMs(now),
    onStatus: (s) => d.onPruneStatus(s),
    // Persist the completed run's timestamp through the one settings save path
    // (also reloads live configs — harmless, and keeps one write path).
    onRunComplete: (at) => {
      d.updateSettings({ pruneLastRunAt: at });
    },
    // A scan's first act: ONE active profile-info fetch for our own account, so
    // the header counts sizing the progress bar (and backing the census
    // coverage guard) are fresh in the store — the passive observer alone can
    // miss them entirely (SPA profile loads don't always issue
    // the profile endpoint).
    refreshOwnStats: ownUsername
      ? async (): Promise<void> => {
          const refreshed = await policy.refreshOwnStats();
          if (!refreshed.ok) throw new Error(`Fresh own profile required: ${refreshed.reason}`);
        }
      : undefined,
  });
  // Back the woven-feed adapter now that the PruneEngine exists.
  pruneEngineRef = pruneEngine;

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
    pacing,
  };
}
