/**
 * Engine runtime tests (§3.1 loop, §3.3 interruptible sleep, §5 halt/status, E1).
 *
 * Real `:memory:` KnowledgeStore + real governors beneath a FakeClock; scripted
 * fakes for every live-edge collaborator; an injected fake sleep that advances the
 * FakeClock and resolves immediately (unless deliberately hung to test abort).
 * A shared `events` log proves ordering — most importantly that the loop can NEVER
 * perform two actions without an interposed human delay.
 */
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import { RateGovernor, type RateGovernorConfig } from '@/governors/rate-governor';
import { RequestBudget } from '@/governors/request-budget';
import {
  Engine,
  ENGINE_IDLE_MS,
  ENRICH_BATCH_SIZE,
  MAX_ENRICH_PASSES_PER_CYCLE,
  REFILL_PACING_MAX_MS,
  REFILL_PACING_MIN_MS,
  type EngineChain,
  type EngineChurn,
  type EngineEnricher,
  type EngineFollowback,
  type EngineScanner,
  type EngineStatus,
  type SleepFn,
} from '@/engine/engine';
import type { AdvanceResult } from '@/engine/chain-controller';
import { Scanner, type ScanPlan } from '@/engine/scanner';
import type { FollowerAcquisition } from '@/rim/types';
import type { SentinelStatus } from '@/adapter/sentinel';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { AccountFields, FollowRecord } from '@/store/types';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const T0 = Date.parse('2026-08-12T12:00:00'); // local noon
const DELAY_MS = 240_000; // fixed humanized delay (min=max, jitter 0)
const HOUR = 3_600_000;

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

// --- Fakes -------------------------------------------------------------------------

class FakeSentinel {
  checks = 0;
  /** f9: while > 0, check() REJECTS (a transient evaluate failure), decrementing. */
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
 * R1 fake enricher: `enrich(usernames)` writes a scripted profile observation
 * (counts) into the store for every username it has a profile for — exactly what
 * the real adapter-backed ProfileEnricher does via web_profile_info.
 */
class FakeEnricher implements EngineEnricher {
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

class FakeChurn implements EngineChurn {
  due: FollowRecord[] = [];
  advanceCalls = 0;
  executed: FollowRecord[] = [];
  constructor(private readonly events: string[]) {}
  advanceTimers(): void {
    this.advanceCalls += 1;
  }
  nextDue(): FollowRecord | null {
    return this.due[0] ?? null;
  }
  async execute(r: FollowRecord): Promise<void> {
    this.due = this.due.filter((d) => d.accountPk !== r.accountPk);
    this.executed.push(r);
    this.events.push(`execute:${r.accountPk}`);
  }
}

/** Scripted scanner: each planTarget call enqueues the next pk-list into the store. */
class FakeScanner implements EngineScanner {
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

class FakeChain implements EngineChain {
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

class FakeFollowback implements EngineFollowback {
  checks = 0;
  async check(): Promise<{ detected: string[] }> {
    this.checks += 1;
    return { detected: [] };
  }
}

class FakeAcquisition implements FollowerAcquisition {
  calls: string[] = [];
  script: Array<{ observed: number; targetPk: string | null }> = [];
  async acquire(targetUsername: string): Promise<{ observed: number; targetPk: string | null }> {
    this.calls.push(targetUsername);
    return this.script.shift() ?? { observed: 0, targetPk: null };
  }
}

/**
 * The injected fake sleep: records every duration, advances the FakeClock by `ms`
 * and resolves immediately — unless `hang` is set, in which case it resolves only
 * when the Engine aborts it (proving E1 interruptibility with real control flow).
 */
class SleepRecorder {
  calls: number[] = [];
  hang = false;
  aborted = 0;
  constructor(
    private readonly clock: FakeClock,
    private readonly events: string[],
  ) {}
  fn: SleepFn = (ms, signal) => {
    this.calls.push(ms);
    this.events.push(`sleep:${ms}`);
    if (signal.aborted) {
      this.aborted += 1;
      return Promise.resolve();
    }
    if (!this.hang) {
      this.clock.advance(ms);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      signal.addEventListener(
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

// --- Harness -----------------------------------------------------------------------

interface HarnessOpts {
  startAt?: number;
  ceiling?: number;
  activeHours?: { start: number; end: number };
  settings?: Partial<Settings>;
  seedTarget?: boolean; // default true: t1/'targetone' active at chainIndex 0
  sentinel?: SentinelStatus[]; // scripted statuses, then 'ok'
  budgetMax?: number; // request-budget window cap (default 999)
  useRealScanner?: boolean; // wire the REAL Scanner over the store (R1 pipeline tests)
}

interface Harness {
  store: KnowledgeStore;
  clock: FakeClock;
  sentinel: FakeSentinel;
  churn: FakeChurn;
  scanner: FakeScanner;
  chain: FakeChain;
  followback: FakeFollowback;
  acquisition: FakeAcquisition;
  enricher: FakeEnricher;
  sleep: SleepRecorder;
  events: string[];
  statuses: EngineStatus[];
  halts: string[];
  engine: Engine;
}

const makeHarness = (opts: HarnessOpts = {}): Harness => {
  const startAt = opts.startAt ?? T0;
  const hours = opts.activeHours ?? { start: 0, end: 24 };
  const store = new KnowledgeStore(':memory:');
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
  const sleep = new SleepRecorder(clock, events);

  if (opts.seedTarget !== false) {
    store.observe({
      accountPk: 't1',
      observedAt: startAt,
      source: 'profile',
      fields: { username: 'targetone' },
    });
    store.addTarget({ accountPk: 't1', source: 'seed', status: 'active', chainIndex: 0 });
  }

  const engine = new Engine({
    store,
    clock,
    rate: new RateGovernor(store, clock, rateCfg),
    requestBudget: new RequestBudget(store, clock, {
      maxRequestsPerWindow: opts.budgetMax ?? 999,
      windowMs: 60 * 60_000,
    }),
    sentinel,
    churn,
    scanner: opts.useRealScanner === true ? new Scanner({ store }) : scanner,
    chain,
    followback,
    acquisition,
    enricher,
    settings,
    sleep: sleep.fn,
    onStatus: (s) => statuses.push(s),
    onHalt: (reason) => halts.push(reason),
  });

  return {
    store, clock, sentinel, churn, scanner, chain,
    followback, acquisition, enricher, sleep, events, statuses, halts, engine,
  };
};

// --- Tests ---------------------------------------------------------------------------

describe('Engine.stepOnce — one major thing per iteration', () => {
  test("an 'acted' step executes exactly ONE churn action then sleeps nextDelayMs", async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' }), rec({ accountPk: 'b' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('acted');
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']); // ONE action only
    expect(h.sleep.calls).toEqual([DELAY_MS]); // the fake sleep saw THE human delay
    expect(h.events).toEqual(['execute:a', `sleep:${DELAY_MS}`]); // delay AFTER the action
    // Nothing else happened in this step:
    expect(h.followback.checks).toBe(0);
    expect(h.acquisition.calls).toEqual([]);
    expect(h.chain.advanceCalls).toEqual([]);
  });

  test('the loop CANNOT act twice without an interposed delay', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' }), rec({ accountPk: 'b' })];

    expect(await h.engine.stepOnce()).toBe('acted');
    expect(await h.engine.stepOnce()).toBe('acted');

    // Strict alternation: every execute is immediately followed by a delay sleep.
    expect(h.events).toEqual([
      'execute:a',
      `sleep:${DELAY_MS}`,
      'execute:b',
      `sleep:${DELAY_MS}`,
    ]);
  });

  test('emits onStatus after every step, carrying lastStep', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];
    await h.engine.stepOnce();
    await h.engine.stepOnce();
    expect(h.statuses.length).toBe(2);
    expect(h.statuses[0].lastStep).toBe('acted');
    expect(h.statuses[1].lastStep).toBe('idle');
    expect(h.statuses[0].lastSentinel).toBe('ok');
    expect(h.statuses[0].lastActionAt).toBe(T0);
  });
});

describe('Engine — sentinel halt (precedence 2)', () => {
  test('a non-ok sentinel halts with a reason and performs NO action', async () => {
    const h = makeHarness({ sentinel: ['action-blocked'] });
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('halted');
    expect(h.halts).toEqual(['sentinel:action-blocked']);
    expect(h.churn.executed).toEqual([]); // no action past the block
    expect(h.sleep.calls).toEqual([]);
    expect(h.engine.status().state).toBe('halted');
    expect(h.engine.status().lastSentinel).toBe('action-blocked');

    // A halted engine refuses further steps.
    expect(await h.engine.stepOnce()).toBe('aborted');
    expect(h.churn.executed).toEqual([]);
  });
});

describe('Engine — active-hours and ceiling gates (precedence 3–4)', () => {
  test('outside active hours: waits until the window opens, no action', async () => {
    const h = makeHarness({
      startAt: Date.parse('2026-08-12T02:00:00'),
      activeHours: { start: 8, end: 22 },
    });
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('waited-active-hours');
    expect(h.sleep.calls).toEqual([6 * HOUR]); // 02:00 → 08:00
    expect(h.churn.executed).toEqual([]);
    expect(h.churn.advanceCalls).toBe(0); // gate fires before timers

    // The fake sleep advanced the clock into the window: the next step acts.
    expect(await h.engine.stepOnce()).toBe('acted');
  });

  test('at the hard ceiling: waits until local midnight, no action', async () => {
    const h = makeHarness({ ceiling: 2 });
    h.store.recordAction('x', 'follow', 'ok', T0 - HOUR);
    h.store.recordAction('y', 'follow', 'ok', T0 - HOUR / 2);
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('waited-ceiling');
    expect(h.sleep.calls).toEqual([12 * HOUR]); // noon → midnight
    expect(h.churn.executed).toEqual([]);
    expect(h.engine.status().atHardCeiling).toBe(false); // ledger rolled over at midnight
  });
});

describe('Engine — follow-back sweep cadence (precedence 6)', () => {
  test('sweeps when due, then not again until the cadence elapses', async () => {
    const h = makeHarness({ settings: { followbackSweepHours: 4 } });

    // Fresh engine: catch-up sweep on the first eligible step.
    expect(await h.engine.stepOnce()).toBe('swept-followback');
    expect(h.followback.checks).toBe(1);

    // Immediately after: not due — the step falls through to idle.
    expect(await h.engine.stepOnce()).toBe('idle');
    expect(h.followback.checks).toBe(1);

    // Drive the FakeClock past the cadence: due again.
    h.clock.advance(4 * HOUR);
    expect(await h.engine.stepOnce()).toBe('swept-followback');
    expect(h.followback.checks).toBe(2);
  });

  test('the sweep is the step’s ONE thing: a due action waits for the next step', async () => {
    const h = makeHarness({ settings: { followbackSweepHours: 4 } });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('swept-followback');
    expect(h.churn.executed).toEqual([]);
    expect(await h.engine.stepOnce()).toBe('acted');
  });
});

describe('Engine — pool refill (precedence 7) and the acquisition guard', () => {
  test("pool low triggers acquire then planTarget — and outranks a due action", async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.acquisition.script = [{ observed: 10, targetPk: 't1' }];
    h.scanner.script = [['c1', 'c2']];
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone']); // scraped by username
    expect(h.scanner.planCalls).toEqual(['t1']); // then ranked + enqueued
    expect(h.churn.executed).toEqual([]); // refill was the ONE thing
    expect(h.engine.status().queued).toBe(2);
  });

  test('a dry target is acquired once, then the chain advances (no infinite re-acquire)', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.store.observe({
      accountPk: 't2',
      observedAt: T0,
      source: 'profile',
      fields: { username: 'targettwo' },
    });
    h.chain.script = [{ nextTargetPk: 't2', source: 'own_followers', reason: 'fallback' }];

    // Step 1: pool empty → acquire; nothing observed, nothing enqueued (guard sets).
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone']);

    // Step 2: still dry, guard set → exhausted → chain advances; NO re-acquire.
    expect(await h.engine.stepOnce()).toBe('advanced-chain');
    expect(h.acquisition.calls).toEqual(['targetone']);
    expect(h.chain.advanceCalls).toEqual(['t1']);
    expect(h.engine.status().currentTargetPk).toBe('t2');
    expect(h.engine.status().currentTargetUsername).toBe('targettwo');

    // Step 3: the guard reset on adoption → the NEW target gets its refill.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone', 'targettwo']);
  });

  test('chain returning no next target halts with chain-exhausted', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.chain.script = [{ nextTargetPk: null, source: 'none', reason: 'no-target-available' }];

    expect(await h.engine.stepOnce()).toBe('acquired'); // dry acquire, guard set
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['chain-exhausted']);
    expect(h.engine.status().state).toBe('halted');
  });
});

describe('Engine — target resolution on start', () => {
  test('adopts the ACTIVE store target with the highest chainIndex', async () => {
    const h = makeHarness({ seedTarget: false });
    for (const [pk, username, chainIndex, status] of [
      ['t1', 'one', 0, 'exhausted'],
      ['t2', 'two', 1, 'active'],
      ['t3', 'three', 4, 'active'],
    ] as const) {
      h.store.observe({ accountPk: pk, observedAt: T0, source: 'profile', fields: { username } });
      h.store.addTarget({ accountPk: pk, source: 'seed', status, chainIndex });
    }

    expect(await h.engine.stepOnce()).toBe('idle'); // adoption is free; step idles
    const s = h.engine.status();
    expect(s.currentTargetPk).toBe('t3');
    expect(s.currentTargetUsername).toBe('three');
    expect(s.chainIndex).toBe(4);
  });

  test('no stored target: bootstraps the seed via one acquisition pass', async () => {
    const h = makeHarness({ seedTarget: false });
    h.acquisition.script = [{ observed: 40, targetPk: 'sp' }];
    h.scanner.script = [['c1']];

    const result = await h.engine.stepOnce();

    expect(result).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['seeduser']);
    expect(h.store.getTarget('sp')).toEqual({
      accountPk: 'sp',
      source: 'seed',
      status: 'active',
      chainIndex: 0,
    });
    expect(h.scanner.planCalls).toEqual(['sp']);
    expect(h.engine.status().currentTargetPk).toBe('sp');
    expect(h.engine.status().currentTargetUsername).toBe('seeduser');
  });

  test('an empty seed halts (nothing safe to do without a target)', async () => {
    const h = makeHarness({ seedTarget: false, settings: { seed: '' } });
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['seed-missing']);
  });

  test('an unresolvable seed halts', async () => {
    const h = makeHarness({ seedTarget: false });
    h.acquisition.script = [{ observed: 0, targetPk: null }];
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['seed-unresolved']);
  });
});

describe('Engine — lifecycle: start/stop/pause (E1)', () => {
  test('stop() aborts the in-flight sleep and start() resolves promptly', async () => {
    const h = makeHarness();
    h.sleep.hang = true; // the idle sleep now blocks until aborted

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0)); // let the loop reach its first sleep
    expect(h.engine.status().state).toBe('running');
    expect(h.sleep.calls).toEqual([ENGINE_IDLE_MS]); // parked in the idle sleep

    h.engine.stop();
    await started; // resolves cleanly — the sleep was interrupted

    expect(h.sleep.aborted).toBe(1);
    expect(h.engine.status().state).toBe('idle');
    expect(await h.engine.stepOnce()).toBe('aborted'); // stopped engine refuses steps
  });

  test('pause() interrupts the sleep and parks the loop; resume() continues it', async () => {
    const h = makeHarness();
    h.sleep.hang = true;

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sleep.calls.length).toBe(1);

    h.engine.pause();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('paused');
    expect(h.sleep.aborted).toBe(1); // control was instant, not queued behind a wait
    const sleepsWhilePaused = h.sleep.calls.length;

    await new Promise((r) => setTimeout(r, 0));
    expect(h.sleep.calls.length).toBe(sleepsWhilePaused); // parked: no further steps

    h.engine.resume();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('running');
    expect(h.sleep.calls.length).toBeGreaterThan(sleepsWhilePaused); // stepping again

    h.engine.stop();
    await started;
    expect(h.engine.status().state).toBe('idle');
  });

  test('awaitParked resolves once the paused loop quiesces at the gate (prune hand-off)', async () => {
    const h = makeHarness();
    h.sleep.hang = true; // parked in the idle sleep, still "running"

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('running');

    // Ask for the park BEFORE pausing: it must NOT resolve while a step could run.
    let resolved = false;
    const parked = h.engine.awaitParked(1_000).then((v) => {
      resolved = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false); // running → not quiesced

    h.engine.pause(); // aborts the in-flight sleep; the loop heads to the gate
    expect(await parked).toBe(true);
    expect(h.engine.status().state).toBe('paused');

    // Already parked → a fresh wait resolves true immediately.
    expect(await h.engine.awaitParked(1_000)).toBe(true);

    h.engine.stop();
    await started;
  });

  test('awaitParked resolves true immediately for an engine that never started', async () => {
    const h = makeHarness();
    expect(await h.engine.awaitParked(1_000)).toBe(true); // idle → not driving the tab
  });

  test('start() halts the loop when the sentinel blocks mid-run', async () => {
    const h = makeHarness({ sentinel: ['ok', 'challenge'] });
    h.churn.due = [rec({ accountPk: 'a' })];

    await h.engine.start(); // resolves on its own: halted on the second iteration

    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);
    expect(h.halts).toEqual(['sentinel:challenge']);
    expect(h.engine.status().state).toBe('halted');
  });
});

describe('Engine — offline hold (connectivity)', () => {
  test('setOnline(false) parks the running loop; setOnline(true) resumes it', async () => {
    const h = makeHarness();
    h.sleep.hang = true; // the idle sleep now blocks until aborted

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0)); // let the loop reach its first sleep
    expect(h.engine.status().online).toBe(true);
    expect(h.sleep.calls.length).toBe(1); // parked in the idle sleep
    const sessionStartedAt = h.engine.status().sessionStartedAt;
    expect(sessionStartedAt).not.toBeNull();

    h.engine.setOnline(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('running'); // offline is a hold, not a stop
    expect(h.engine.status().online).toBe(false);
    expect(h.sleep.aborted).toBe(1); // the in-flight sleep was aborted promptly
    const sleepsWhileOffline = h.sleep.calls.length;

    await new Promise((r) => setTimeout(r, 0));
    expect(h.sleep.calls.length).toBe(sleepsWhileOffline); // parked: no further steps
    expect(h.engine.status().sessionStartedAt).toBe(sessionStartedAt); // hold keeps the session

    h.engine.setOnline(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().online).toBe(true);
    expect(h.sleep.calls.length).toBeGreaterThan(sleepsWhileOffline); // stepping again

    h.engine.stop();
    await started;
    expect(h.engine.status().state).toBe('idle');
  });

  test('stop() while offline-parked ends the loop cleanly', async () => {
    const h = makeHarness();
    h.sleep.hang = true;

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    h.engine.setOnline(false);
    await new Promise((r) => setTimeout(r, 0)); // loop is parked in the offline gate

    h.engine.stop();
    await started; // resolves: the offline waiter was released and the token aborted

    expect(h.engine.status().state).toBe('idle');
    expect(await h.engine.stepOnce()).toBe('aborted'); // stopped engine refuses steps
  });

  test('pause() while offline-parked parks as paused; resume() re-parks for offline', async () => {
    const h = makeHarness();
    h.sleep.hang = true;

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    h.engine.setOnline(false);
    await new Promise((r) => setTimeout(r, 0)); // loop is parked in the offline gate

    h.engine.pause();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('paused');
    expect(h.engine.status().online).toBe(false);
    const sleepsWhilePaused = h.sleep.calls.length;

    // Resume while still offline: the loop wakes, sees offline, and re-parks —
    // no step runs until connectivity returns.
    h.engine.resume();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('running');
    expect(h.sleep.calls.length).toBe(sleepsWhilePaused); // still no further steps

    h.engine.setOnline(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sleep.calls.length).toBeGreaterThan(sleepsWhilePaused); // stepping again

    h.engine.stop();
    await started;
  });
});

describe('Engine — session tracking + netToday (status projection)', () => {
  test('sessionStartedAt is null when idle, set on start, cleared on stop', async () => {
    const h = makeHarness();
    h.sleep.hang = true; // park in the idle sleep so the clock does not advance

    expect(h.engine.status().sessionStartedAt).toBeNull();

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().sessionStartedAt).toBe(h.clock.now());

    h.engine.stop();
    await started;
    expect(h.engine.status().sessionStartedAt).toBeNull();
  });

  test('netToday reflects follow_records reciprocated since local midnight', () => {
    const h = makeHarness();
    const startOfToday = new Date(T0).setHours(0, 0, 0, 0);
    // Reciprocated today (noon) counts; reciprocated an hour before midnight does not.
    h.store.upsertFollowRecord(rec({ accountPk: 'x', state: 'followed_back', followedBackAt: T0 }));
    h.store.upsertFollowRecord(
      rec({ accountPk: 'y', state: 'followed_back', followedBackAt: startOfToday - HOUR }),
    );
    expect(h.engine.status().netToday).toBe(1);
  });
});

// --- R1: enrichment pipeline (REAL Scanner + store, fake enricher) -------------------

describe('Engine — R1 candidate enrichment + livelock guard (real Scanner)', () => {
  /** Seed a follower of t1 as the followers-list would: an edge + list fields. */
  const follower = (h: Harness, pk: string, fields: AccountFields): void => {
    h.store.observe({ accountPk: pk, observedAt: T0, source: 'followers-list', fields });
    h.store.observeEdge(pk, 't1', 'follows', true, T0);
  };

  test('acquire → enrich → plan: eligible enqueued, rejected skipped, then the chain ADVANCES', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    follower(h, 'f1', { username: 'fone' }); // no counts → enriches to in-band (peak ratio)
    follower(h, 'f2', { username: 'ftwo' }); // no counts → enriches to in-band private
    follower(h, 'f3', { username: 'fthree', followers: 1000, following: 5000 }); // counts KNOWN, ratio 5 → ineligible
    follower(h, 'f4', { username: 'ffour' }); // no counts → enriches to too-small
    h.enricher.profiles.set('fone', { pk: 'f1', fields: { followers: 1000, following: 1100 } });
    h.enricher.profiles.set('ftwo', {
      pk: 'f2',
      fields: { followers: 1000, following: 1150, isPrivate: true },
    });
    h.enricher.profiles.set('ffour', { pk: 'f4', fields: { followers: 10, following: 11 } });

    // Step 1: ONE acquisition + the first enrichment pass over the count-less trio
    // (f3 already has counts, so it is never sent to the enricher).
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone']);
    expect(h.enricher.calls).toEqual([['fone', 'ftwo', 'ffour']]);

    // Step 2: everything has counts now → plan: eligible enqueued, rejected SKIPPED.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone']); // no re-acquire mid-cycle
    expect(h.store.getFollowRecord('f1')!.state).toBe('queued');
    expect(h.store.getFollowRecord('f2')!.state).toBe('queued');
    expect(h.store.getAccount('f3')!.role).toBe('skipped');
    expect(h.store.getAccount('f4')!.role).toBe('skipped');
    expect(h.store.candidatePksForTarget('t1')).toEqual([]); // the pool genuinely shrank
    expect(h.engine.status().queued).toBe(2);

    // Step 3: still under low-water, but progress opened a NEW cycle: one more
    // acquisition, nothing left to enrich, and the final plan enqueues 0 → EXHAUSTED.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone', 'targetone']);
    expect(h.enricher.calls.length).toBe(1);

    // Steps 4..8: step 7 is latched off — the refill can NEVER fire again for this
    // target. No acquisition, no enrichment: the livelock is structurally impossible.
    for (let i = 0; i < 5; i += 1) expect(await h.engine.stepOnce()).toBe('idle');
    expect(h.acquisition.calls.length).toBe(2);
    expect(h.enricher.calls.length).toBe(1);

    // Once the queue drains (records acted on), step 9 ADVANCES the chain.
    h.store.upsertFollowRecord(rec({ accountPk: 'f1', targetPk: 't1', state: 'pending_followback' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'f2', targetPk: 't1', state: 'pending_followback' }));
    h.store.observe({
      accountPk: 't9',
      observedAt: T0,
      source: 'profile',
      fields: { username: 'targetnine' },
    });
    h.chain.script = [{ nextTargetPk: 't9', source: 'own_followers', reason: 'next' }];
    expect(await h.engine.stepOnce()).toBe('advanced-chain');
    expect(h.chain.advanceCalls).toEqual(['t1']);
    expect(h.engine.status().currentTargetPk).toBe('t9');
    expect(h.engine.status().currentTargetUsername).toBe('targetnine');
  });

  test('R1.5: enrichment is capped per cycle; an un-enrichable target exhausts instead of spinning', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    follower(h, 'f1', { username: 'fone' }); // its counts never arrive: no profile scripted

    // Pass 1 rides the one-and-only acquisition; passes 2..K each cost a step.
    for (let pass = 1; pass <= MAX_ENRICH_PASSES_PER_CYCLE; pass += 1) {
      expect(await h.engine.stepOnce()).toBe('acquired');
      expect(h.enricher.calls.length).toBe(pass);
      expect(h.enricher.calls[pass - 1]).toEqual(['fone']);
    }
    expect(h.acquisition.calls).toEqual(['targetone']); // exactly ONE acquire

    // Cap reached → the FINAL plan enqueues nothing → the target is exhausted…
    expect(await h.engine.stepOnce()).toBe('acquired');
    // …and the next step advances the chain (here: none left → halt) instead of
    // re-acquiring or re-enriching forever.
    h.chain.script = [{ nextTargetPk: null, source: 'none', reason: 'no-target-available' }];
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['chain-exhausted']);
    expect(h.acquisition.calls.length).toBe(1);
    expect(h.enricher.calls.length).toBe(MAX_ENRICH_PASSES_PER_CYCLE);
  });

  test('an enrichment pass sends at most ENRICH_BATCH_SIZE usernames', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    for (let i = 0; i < ENRICH_BATCH_SIZE + 3; i += 1) {
      follower(h, `f${i}`, { username: `user${i}` });
    }
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.enricher.calls[0]!.length).toBe(ENRICH_BATCH_SIZE);
  });

  test('f10: refill traffic ends with a short jittered pacing sleep', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    follower(h, 'f1', { username: 'fone' });
    h.enricher.profiles.set('fone', { pk: 'f1', fields: { followers: 1000, following: 1100 } });

    await h.engine.stepOnce(); // acquire + enrich: IG traffic → must be paced
    expect(h.sleep.calls.length).toBe(1);
    expect(h.sleep.calls[0]).toBeGreaterThanOrEqual(REFILL_PACING_MIN_MS);
    expect(h.sleep.calls[0]).toBeLessThanOrEqual(REFILL_PACING_MAX_MS);
  });
});

// --- R2 / R4 / f9 ---------------------------------------------------------------------

describe('Engine — R2: one concurrent loop (generation token)', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  test('stop()+start() around an in-flight step leaves exactly ONE loop running', async () => {
    const h = makeHarness();
    h.sleep.hang = true;
    h.churn.due = [rec({ accountPk: 'a' }), rec({ accountPk: 'b' }), rec({ accountPk: 'c' })];

    const first = h.engine.start();
    await tick();
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']); // loop 1 acted, parked in its delay

    h.engine.stop(); // aborts loop 1's generation token + its hanging sleep
    const second = h.engine.start(); // restart while loop 1's step is still unwinding
    await first; // the STALE loop exits: its OWN token is aborted (identity check)
    await tick();
    await tick();

    // Only the new loop stepped: exactly one more action ('b'), never a third.
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a', 'b']);
    // The stale loop's exit did not clobber the new run's state.
    expect(h.engine.status().state).toBe('running');

    await tick();
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a', 'b']); // still ONE loop

    h.engine.stop();
    await second;
    expect(h.engine.status().state).toBe('idle');
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a', 'b']);
  });
});

describe('Engine — R4: request-budget pre-check before acting', () => {
  test('a saturated budget parks the step: churn.execute is NOT called', async () => {
    const h = makeHarness({ budgetMax: 0 });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('idle');
    expect(h.churn.executed).toEqual([]); // no blocked attempt was driven
    expect(h.sleep.calls).toEqual([ENGINE_IDLE_MS]); // parked on the idle wait
    expect(h.engine.status().state).not.toBe('halted');
  });

  test('with budget available the same step acts', async () => {
    const h = makeHarness({ budgetMax: 5 });
    h.churn.due = [rec({ accountPk: 'a' })];
    expect(await h.engine.stepOnce()).toBe('acted');
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);
  });
});

describe('Engine — f9: per-step resilience', () => {
  test("a transient sentinel.check rejection yields 'idle' and the loop survives", async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];
    h.sentinel.failNext = 1;

    expect(await h.engine.stepOnce()).toBe('idle'); // caught + logged, not a crash
    expect(h.halts).toEqual([]);
    expect(h.engine.status().state).not.toBe('halted');
    expect(h.churn.executed).toEqual([]);
    expect(h.sleep.calls).toEqual([ENGINE_IDLE_MS]); // one idle back-off beat

    expect(await h.engine.stepOnce()).toBe('acted'); // the next step proceeds normally
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);
  });

  test('a VERIFIED sentinel block still halts — resilience does not mask real blocks', async () => {
    const h = makeHarness({ sentinel: ['challenge'] });
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['sentinel:challenge']);
    expect(h.engine.status().state).toBe('halted');
  });
});

describe('Engine — status projection', () => {
  test('counts follow-record states and governor numbers from the store', async () => {
    const h = makeHarness({ ceiling: 100 });
    h.store.upsertFollowRecord(rec({ accountPk: 'q1', targetPk: 't1', state: 'queued' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'p1', state: 'pending_followback' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'p2', state: 'pending_followback' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'f1', state: 'followed_back' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'u1', state: 'unfollow_queued' }));
    h.store.recordAction('q0', 'follow', 'ok', T0 - HOUR);

    const s = h.engine.status();
    expect(s.queued).toBe(1);
    expect(s.pendingFollowback).toBe(2);
    expect(s.followedBackHeld).toBe(1);
    expect(s.unfollowDue).toBe(1);
    expect(s.actionsToday).toBe(1);
    expect(s.remainingToday).toBe(99);
    expect(s.atHardCeiling).toBe(false);
    expect(s.requestBudgetRemaining).toBe(999);
    expect(s.state).toBe('idle');
    expect(s.lastStep).toBeNull();
  });
});
