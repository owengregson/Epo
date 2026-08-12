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
  type EngineChain,
  type EngineChurn,
  type EngineFollowback,
  type EngineScanner,
  type EngineStatus,
  type SleepFn,
} from '@/engine/engine';
import type { AdvanceResult } from '@/engine/chain-controller';
import type { ScanPlan } from '@/engine/scanner';
import type { FollowerAcquisition } from '@/rim/types';
import type { SentinelStatus } from '@/adapter/sentinel';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { FollowRecord } from '@/store/types';
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
  private readonly queue: SentinelStatus[];
  constructor(statuses: SentinelStatus[] = []) {
    this.queue = [...statuses];
  }
  async check(): Promise<SentinelStatus> {
    this.checks += 1;
    return this.queue.shift() ?? 'ok';
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
      maxRequestsPerWindow: 999,
      windowMs: 60 * 60_000,
    }),
    sentinel,
    churn,
    scanner,
    chain,
    followback,
    acquisition,
    settings,
    sleep: sleep.fn,
    onStatus: (s) => statuses.push(s),
    onHalt: (reason) => halts.push(reason),
  });

  return {
    store, clock, sentinel, churn, scanner, chain,
    followback, acquisition, sleep, events, statuses, halts, engine,
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

  test('start() halts the loop when the sentinel blocks mid-run', async () => {
    const h = makeHarness({ sentinel: ['ok', 'challenge'] });
    h.churn.due = [rec({ accountPk: 'a' })];

    await h.engine.start(); // resolves on its own: halted on the second iteration

    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);
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
