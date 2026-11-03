/**
 * Shared engine test kit: the fakes for every Engine port, the one fake-time
 * contract, and the harness builders (`makeEngineHarness`, `makePruneHarness`,
 * `makeChurnHarness`). Not a test suite — Jest imports it without running it.
 *
 * FAKE-TIME CONTRACT (one, documented, chosen once): `FakeSleep.fn` records the
 * duration and resolves immediately. `advanceOnSleep` (the growth default) also
 * advances the FakeClock by that duration, so a test never has to mirror the
 * loop's own waits by hand; the prune builders opt out (`advanceOnSleep: false`)
 * and drive the clock explicitly. `hang` makes a sleep resolve only on abort —
 * the way interruptibility is proved with real control flow.
 *
 * Every store the kit opens is closed after the importing file's tests.
 */

import type { SentinelStatus } from '@/adapter/sentinel';
import type { AdvanceResult } from '@/engine/chain-controller';
import {
  CHURN_DEFAULTS,
  type ChurnConfig,
  ChurnScheduler,
} from '@/engine/churn-scheduler';
import {
  Engine,
  type EngineAcquisition,
  type EngineChain,
  type EngineChurn,
  type EngineDeps,
  type EngineEnricher,
  type EnginePacing,
  type EngineScanner,
  type EngineStatus,
  type EngineTabDiagnostics,
  type EngineUnfollowFeed,
  type SleepFn,
} from '@/engine/engine';
import {
  type PruneConfig,
  PruneEngine,
  type PruneEngineDeps,
  type PruneOwnFollowers,
  type PruneOwnFollowing,
  type PruneScanFetch,
  type PruneScanOpts,
  type PruneStatus,
} from '@/engine/prune-engine';
import { Scanner, type ScanPlan } from '@/engine/scanner';
import { FakeClock } from '@/governors/clock';
import { RateGovernor, type RateGovernorConfig } from '@/governors/rate-governor';
import type { AcquireEndReason } from '@/rim/follower-acquisition';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { AccountFields, FollowRecord } from '@/store/types';
import { DelayManager, type DelayManagerDeps } from '@/timing/delay-manager';
import { FakeActions, FakePruneActions, NO_UNFOLLOW_FEED } from './harness-journal';
import { memorySweepCadence } from './harness-plan';
import { FakeFollowback } from './harness-reopen';
import { openTestStore } from './store';

// The per-concern fakes live beside the core; every suite still imports them from here.
export { FakeActions, FakeFollowback, FakePruneActions, memorySweepCadence, NO_UNFOLLOW_FEED };

/** Local noon — every harness starts here unless a test says otherwise. */
export const T0 = Date.parse('2026-08-12T12:00:00');
/** The growth harness's fixed paced delay (min = max, jitter 0). */
export const DELAY_MS = 240_000;
export const HOUR = 3_600_000;
export const OWN_PK = 'ME';

/** A follow record with the boring fields filled in. */
export const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

// --- Store lifecycle ---------------------------------------------------------------

const openStores: KnowledgeStore[] = [];

/** Open a `:memory:` store the kit will close after the current test file. */
export function kitStore(): KnowledgeStore {
  const store = openTestStore(':memory:');
  openStores.push(store);
  return store;
}

// Importing the kit registers the cleanup: no suite leaks SQLite handles.
afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

// --- Fakes -------------------------------------------------------------------------

/** A sentinel returning scripted statuses then 'ok'; `failNext` REJECTS instead. */
export class FakeSentinel {
  checks = 0;
  /** While > 0, `check()` rejects (a transient evaluate failure), decrementing. */
  failNext = 0;
  private readonly queue: SentinelStatus[];
  constructor(statuses: SentinelStatus[] = []) {
    this.queue = [...statuses];
  }
  async check(): Promise<SentinelStatus> {
    this.checks += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('evaluate failed: tab navigated mid-call');
    }
    return this.queue.shift() ?? 'ok';
  }
}

/**
 * Writes a scripted profile observation (counts) into the store for every
 * username it has a profile for — what the real ProfileEnricher does via
 * web_profile_info.
 */
export class FakeEnricher implements EngineEnricher {
  calls: string[][] = [];
  /** username → the pk + profile fields to observe when enriched. */
  profiles = new Map<string, { pk: string; fields: AccountFields }>();
  constructor(
    private readonly store: KnowledgeStore,
    private readonly clock: FakeClock,
  ) {}
  async enrich(usernames: string[]): Promise<number> {
    this.calls.push([...usernames]);
    let enriched = 0;
    for (const u of usernames) {
      const p = this.profiles.get(u);
      if (p === undefined) continue;
      this.store.observe({
        accountPk: p.pk,
        observedAt: this.clock.now(),
        source: 'profile',
        fields: { username: u, ...p.fields },
      });
      enriched += 1;
    }
    return enriched;
  }
}

export class FakeChurn implements EngineChurn {
  due: FollowRecord[] = [];
  advanceCalls = 0;
  executed: FollowRecord[] = [];
  /** Scripted outcome execute reports (default 'ok'). */
  outcome: 'ok' | 'failed' | 'blocked' | 'simulated' | 'noop' = 'ok';
  /** Scripted consecutive-failure readout (the systemic-breakage breaker). */
  failStreak = 0;
  /** Scripted consecutive-blocked readout (the rate-wall streak). */
  blockedStreak = 0;
  /** Scripted drift-caused share of the failure window. */
  driftStreak = 0;
  /** Scripted classification of the most recent blocked outcome. */
  lastCause: 'rate-limited' | 'tab-unhealthy' | null = null;
  resetCalls = 0;
  resetBlockedCalls = 0;
  constructor(private readonly events: string[]) {}
  advanceTimers(): void {
    this.advanceCalls += 1;
  }
  nextDue(): FollowRecord | null {
    return this.due[0] ?? null;
  }
  async execute(r: FollowRecord): Promise<'ok' | 'failed' | 'blocked' | 'simulated' | 'noop'> {
    // A blocked outcome leaves the record completely untouched (still due),
    // exactly like the real scheduler.
    if (this.outcome !== 'blocked') {
      this.due = this.due.filter((d) => d.accountPk !== r.accountPk);
    }
    this.executed.push(r);
    this.events.push(`execute:${r.accountPk}`);
    return this.outcome;
  }
  streaks(): { failed: number; drift: number; blocked: number } {
    return { failed: this.failStreak, drift: this.driftStreak, blocked: this.blockedStreak };
  }
  resetStreaks(): void {
    this.resetCalls += 1;
    this.resetBlockedCalls += 1;
    this.failStreak = 0;
    this.blockedStreak = 0;
    this.driftStreak = 0;
  }
  lastBlockedCause(): 'rate-limited' | 'tab-unhealthy' | null {
    return this.lastCause;
  }
}

/** Scripted scanner: each planTarget call enqueues the next pk-list into the store. */
export class FakeScanner implements EngineScanner {
  planCalls: string[] = [];
  script: string[][] = [];
  constructor(private readonly store: KnowledgeStore) {}
  planTarget(targetPk: string): ScanPlan {
    this.planCalls.push(targetPk);
    const pks = this.script.shift() ?? [];
    for (const pk of pks) {
      this.store.upsertFollowRecord(rec({ accountPk: pk, targetPk, state: 'queued' }));
    }
    return { targetPk, queued: pks, considered: pks.length, eligible: pks.length };
  }
}

export class FakeChain implements EngineChain {
  advanceCalls: string[] = [];
  script: AdvanceResult[] = [];
  advance(currentTargetPk: string): Promise<AdvanceResult> {
    this.advanceCalls.push(currentTargetPk);
    const next = this.script.shift() ?? {
      nextTargetPk: null,
      source: 'none' as const,
      reason: 'unscripted',
    };
    return Promise.resolve(next);
  }
}

export class FakeAcquisition implements EngineAcquisition {
  calls: string[] = [];
  /** Scripted results; an omitted endReason defaults to the VERIFIED list end
   *  ('no-more-pages') so legacy scripts keep exercising the genuine path. */
  script: Array<{ observed: number; targetPk: string | null; endReason?: AcquireEndReason }> = [];
  async acquire(
    targetUsername: string,
  ): Promise<{ observed: number; targetPk: string | null; endReason: AcquireEndReason }> {
    this.calls.push(targetUsername);
    const next = this.script.shift() ?? { observed: 0, targetPk: null };
    return { endReason: 'no-more-pages', ...next };
  }
}

/** The one fake sleep (see the fake-time contract at the top of this file). */
export class FakeSleep {
  calls: number[] = [];
  hang = false;
  aborted = 0;
  constructor(
    private readonly clock: FakeClock,
    private readonly events: string[] = [],
    private readonly advanceOnSleep = true,
  ) {}
  fn: SleepFn = (ms, signal) => {
    this.calls.push(ms);
    this.events.push(`sleep:${ms}`);
    if (signal?.aborted) {
      this.aborted += 1;
      return Promise.resolve();
    }
    if (!this.hang) {
      if (this.advanceOnSleep) this.clock.advance(ms);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      signal?.addEventListener(
        'abort',
        () => {
          this.aborted += 1;
          resolve();
        },
        { once: true },
      );
    });
  };
}

/** One whole-list scrape port (own-following AND own-followers are identical). */
export class FakeListSource implements PruneOwnFollowing, PruneOwnFollowers {
  calls = 0;
  lastOpts: PruneScanOpts | undefined;
  constructor(private readonly pks: string[]) {}
  async fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch> {
    this.calls += 1;
    this.lastOpts = opts;
    return { pks: [...this.pks], complete: true, reason: 'no-more-pages' };
  }
}

// --- Required-deps kit ---------------------------------------------------------------

/** A healthy tab: every recovery entry takes the rate-limit hold path. */
export const HEALTHY_TAB: EngineTabDiagnostics = {
  probeInput: () => Promise.resolve(true),
  checkHealth: () => Promise.resolve({ healthy: true }),
  recoverTab: () => Promise.resolve(),
};

/**
 * A complete {@link EngineDeps} — every REQUIRED field filled with a fake, so a
 * suite overrides only what it is testing. This is what makes the deps required
 * in the first place: production has no absent ports, so neither do the tests
 * (there is no 2^n matrix of "which fallback am I on").
 */
export const testDeps = (over: Partial<EngineDeps> = {}): EngineDeps => {
  const store = over.store ?? kitStore();
  const clock = over.clock ?? new FakeClock(T0);
  const noopSleep: SleepFn = () => Promise.resolve();
  const base: EngineDeps = {
    store,
    clock,
    rate:
      over.rate ??
      new RateGovernor(store, clock, {
        dailyHardCeiling: 1000,
        dailyOperatingRate: 1000,
        minDelayMs: DELAY_MS,
        maxDelayMs: DELAY_MS,
        jitterPercent: 0,
        activeHoursStart: 0,
        activeHoursEnd: 24,
      }, () => 0),
    sentinel: new FakeSentinel(),
    churn: new FakeChurn([]),
    scanner: new FakeScanner(store),
    chain: new FakeChain(),
    followback: new FakeFollowback(),
    acquisition: new FakeAcquisition(),
    enricher: { enrich: () => Promise.resolve(0) },
    settings: { ...DEFAULT_SETTINGS, seed: 'seeduser' },
    delays: new DelayManager({ clock, sleep: noopSleep }),
    unfollowFeed: NO_UNFOLLOW_FEED,
    sweepCadence: memorySweepCadence(),
    installEntropy: 0,
    tabDiag: HEALTHY_TAB,
    onStatus: () => {},
    onHalt: () => {},
  };
  return { ...base, ...over };
};

// --- Growth harness ------------------------------------------------------------------

export interface EngineHarnessOpts {
  startAt?: number;
  ceiling?: number;
  activeHours?: { start: number; end: number };
  settings?: Partial<Settings>;
  /** default true: t1/'targetone' active at chainIndex 0 */
  seedTarget?: boolean;
  /** scripted sentinel statuses, then 'ok' */
  sentinel?: SentinelStatus[];
  /** wire the REAL Scanner over the store (pool-refill pipeline tests) */
  useRealScanner?: boolean;
  rng?: () => number;
  /** organic pacing model (absent → legacy metronome) */
  pacing?: EnginePacing;
  unfollowFeed?: EngineUnfollowFeed;
  sweepCadence?: { isDue(now: number, everyMs: number): boolean; markRun(now: number): void };
  /** the recovery ladder's tab-diagnostics port (absent → presumed healthy) */
  tabDiag?: EngineTabDiagnostics;
  /** build the shared DelayManager (a spy, to observe registered wait keys) */
  delays?: (deps: DelayManagerDeps) => DelayManager;
  /** seed the store BEFORE engine construction (e.g. a persisted deadline) */
  preseedStore?: (store: KnowledgeStore) => void;
  /** the return supervisor, built over the harness store + clock (absent → none) */
  reentry?: (deps: { store: KnowledgeStore; clock: FakeClock }) => EngineDeps['reentry'];
}

export interface EngineHarness {
  store: KnowledgeStore;
  clock: FakeClock;
  sentinel: FakeSentinel;
  churn: FakeChurn;
  scanner: FakeScanner;
  chain: FakeChain;
  followback: FakeFollowback;
  acquisition: FakeAcquisition;
  enricher: FakeEnricher;
  sleep: FakeSleep;
  events: string[];
  statuses: EngineStatus[];
  halts: string[];
  reentry: EngineDeps['reentry'];
  engine: Engine;
}

export const makeEngineHarness = (opts: EngineHarnessOpts = {}): EngineHarness => {
  const startAt = opts.startAt ?? T0;
  const hours = opts.activeHours ?? { start: 0, end: 24 };
  const store = kitStore();
  const clock = new FakeClock(startAt);
  const events: string[] = [];
  const statuses: EngineStatus[] = [];
  const halts: string[] = [];

  const rateCfg: RateGovernorConfig = {
    dailyHardCeiling: opts.ceiling ?? 1000,
    dailyOperatingRate: opts.ceiling ?? 1000,
    minDelayMs: DELAY_MS,
    maxDelayMs: DELAY_MS,
    jitterPercent: 0,
    activeHoursStart: hours.start,
    activeHoursEnd: hours.end,
  };
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    seed: 'seeduser',
    activeHoursStart: hours.start,
    activeHoursEnd: hours.end,
    followbackSweepHours: Number.POSITIVE_INFINITY, // sweeps off unless a test opts in
    lowWaterCandidates: 0, // refills off unless a test opts in
    ...opts.settings,
  };

  const sentinel = new FakeSentinel(opts.sentinel ?? []);
  const churn = new FakeChurn(events);
  const scanner = new FakeScanner(store);
  const chain = new FakeChain();
  const followback = new FakeFollowback();
  const acquisition = new FakeAcquisition();
  const enricher = new FakeEnricher(store, clock);
  const sleep = new FakeSleep(clock, events);

  if (opts.seedTarget !== false) {
    store.observe({
      accountPk: 't1',
      observedAt: startAt,
      source: 'profile',
      fields: { username: 'targetone' },
    });
    store.addTarget({ accountPk: 't1', source: 'seed', status: 'active', chainIndex: 0 });
  }
  opts.preseedStore?.(store);
  const reentry = opts.reentry?.({ store, clock });

  const engine = new Engine(
    testDeps({
      store,
      clock,
      reentry,
      rate: new RateGovernor(store, clock, rateCfg, () => 0),
      sentinel,
      churn,
      scanner: opts.useRealScanner === true ? new Scanner({ store }) : scanner,
      chain,
      followback,
      acquisition,
      enricher,
      settings,
      delays: opts.delays?.({ clock, rng: opts.rng, sleep: sleep.fn }) ??
        new DelayManager({ clock, rng: opts.rng, sleep: sleep.fn }),
      rng: opts.rng,
      pacing: opts.pacing,
      unfollowFeed: opts.unfollowFeed ?? NO_UNFOLLOW_FEED,
      sweepCadence: opts.sweepCadence ?? memorySweepCadence(),
      tabDiag: opts.tabDiag ?? HEALTHY_TAB,
      onStatus: (st) => statuses.push(st),
      onHalt: (reason) => halts.push(reason),
    }),
  );

  return {
    store,
    clock,
    sentinel,
    churn,
    scanner,
    chain,
    followback,
    acquisition,
    enricher,
    sleep,
    events,
    statuses,
    halts,
    reentry,
    engine,
  };
};

// --- Prune harness -------------------------------------------------------------------

export const PRUNE_CFG: PruneConfig = {
  dailyLimit: 50,
  whitelist: [],
  minDelayMs: 60_000,
  maxDelayMs: 60_000, // equal bounds; the harness RNG pins the positive offset
  jitterPercent: 0,
  scanMinMs: 1_000,
  scanMaxMs: 3_000,
};

export interface PruneHarnessOpts {
  following: string[];
  followers: string[];
  cfg?: Partial<PruneConfig>;
  sentinel?: FakeSentinel;
  sleep?: SleepFn;
  refreshOwnStats?: () => Promise<void>;
  cycleStartMs?: (now: number) => number;
  /** build the shared DelayManager (a spy, to observe registered wait keys) */
  delays?: (deps: DelayManagerDeps) => DelayManager;
}

export interface PruneHarness {
  engine: PruneEngine;
  store: KnowledgeStore;
  clock: FakeClock;
  ownFollowing: FakeListSource;
  ownFollowers: FakeListSource;
  churn: FakePruneActions;
  sentinel: FakeSentinel;
  sleeps: number[];
  statuses: PruneStatus[];
  completedAt: number[];
}

/**
 * A PruneEngine over a real `:memory:` store. The sleep fake here does NOT
 * advance the clock (the prune suites drive time explicitly) — pass `sleep` to
 * override.
 */
export const makePruneHarness = (opts: PruneHarnessOpts): PruneHarness => {
  const store = kitStore();
  store.setOwnPk(OWN_PK);
  const clock = new FakeClock(T0);
  const ownFollowing = new FakeListSource(opts.following);
  const ownFollowers = new FakeListSource(opts.followers);
  const churn = new FakePruneActions();
  const sentinel = opts.sentinel ?? new FakeSentinel();
  const sleeps: number[] = [];
  const statuses: PruneStatus[] = [];
  const completedAt: number[] = [];

  // Give every non-self pk a stored username (u<pk>), as the live sources do.
  for (const pk of opts.following) {
    if (pk === OWN_PK) continue;
    store.observe({
      accountPk: pk,
      observedAt: T0,
      source: 'followers-list',
      fields: { username: `u${pk}` },
    });
  }

  const deps: PruneEngineDeps = {
    store,
    clock,
    ownPk: OWN_PK,
    ownFollowing,
    ownFollowers,
    churnActions: churn,
    sentinel,
    cfg: { ...PRUNE_CFG, ...opts.cfg },
    sleep:
      opts.sleep ??
      (async (ms) => {
        sleeps.push(ms);
      }),
    rng: () => 0.5,
    delays: opts.delays?.({
      clock,
      rng: () => 0.5,
      sleep:
        opts.sleep ??
        (async (ms) => {
          sleeps.push(ms);
        }),
    }),
    onStatus: (s) => statuses.push(s),
    onRunComplete: (at) => completedAt.push(at),
    refreshOwnStats: opts.refreshOwnStats,
    cycleStartMs: opts.cycleStartMs,
  };
  return {
    engine: new PruneEngine(deps),
    store,
    clock,
    ownFollowing,
    ownFollowers,
    churn,
    sentinel,
    sleeps,
    statuses,
    completedAt,
  };
};

// --- Churn-scheduler harness ---------------------------------------------------------

export interface ChurnHarness {
  store: KnowledgeStore;
  clock: FakeClock;
  actions: FakeActions;
  sched: ChurnScheduler;
}

export const makeChurnHarness = (opts?: {
  ceiling?: number;
  cfg?: Partial<ChurnConfig>;
  ownPk?: string;
}): ChurnHarness => {
  const store = kitStore();
  const clock = new FakeClock(T0);
  const rate = new RateGovernor(store, clock, {
    dailyHardCeiling: opts?.ceiling ?? 1000,
    dailyOperatingRate: opts?.ceiling ?? 1000,
    minDelayMs: 0,
    maxDelayMs: 0,
    jitterPercent: 0,
    activeHoursStart: 0,
    activeHoursEnd: 24,
  });
  const actions = new FakeActions();
  const sched = new ChurnScheduler({
    store,
    clock,
    rate,
    actions,
    ownPk: opts?.ownPk,
    cfg: { ...CHURN_DEFAULTS, ...opts?.cfg },
  });
  return { store, clock, actions, sched };
};
