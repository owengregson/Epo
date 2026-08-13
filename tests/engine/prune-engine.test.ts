/**
 * PruneEngine tests (Phase 5 — auto-prune).
 *
 * Real `:memory:` KnowledgeStore beneath a FakeClock; scripted fakes for every
 * live-edge port (own-following, own-followers, churn actions, budget,
 * sentinel); an injected fake sleep so nothing waits on real timers. Covers the
 * candidate set-diff (whitelist case-insensitive on username AND pk, self
 * excluded), the prune-own daily cap, the dry-run path (simulated, no
 * reconcile), the ok path (reconcile + ledger), blocked (untouched + park), the
 * sentinel halt, and instant interruptibility via `stop()`.
 */
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import {
  PruneEngine,
  PRUNE_PARK_MS,
  PRUNE_SCAN_FRESH_MS,
  pruneDue,
  type PruneConfig,
  type PruneEngineDeps,
  type PruneScanOpts,
  type PruneStatus,
} from '@/engine/prune-engine';

const DAY = 24 * 3600 * 1000;

describe('pruneDue (scheduled auto-run predicate)', () => {
  test('disabled schedule (0 or negative) is never due', () => {
    expect(pruneDue(0, null, 1_000)).toBe(false);
    expect(pruneDue(0, 0, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(pruneDue(-3, null, 1_000)).toBe(false);
  });

  test('due immediately when it has never run and a schedule is set', () => {
    expect(pruneDue(7, null, 1_000)).toBe(true);
  });

  test('due only once the cadence has elapsed since the last run', () => {
    const last = 10 * DAY;
    expect(pruneDue(7, last, last + 6 * DAY)).toBe(false);
    expect(pruneDue(7, last, last + 7 * DAY)).toBe(true);
    expect(pruneDue(7, last, last + 8 * DAY)).toBe(true);
  });

  test('a non-finite cadence is never due (defensive)', () => {
    expect(pruneDue(Number.NaN, null, 1_000)).toBe(false);
    expect(pruneDue(Number.POSITIVE_INFINITY, 0, 10 * DAY)).toBe(false);
  });
});
import type { SleepFn } from '@/engine/engine';
import type { ChurnActionOutcome } from '@/engine/churn-scheduler';
import type { SentinelStatus } from '@/adapter/sentinel';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const T0 = Date.parse('2026-08-12T12:00:00'); // local noon
const OWN_PK = 'ME';

// --- Fakes -------------------------------------------------------------------------

class FakeOwnFollowing {
  calls = 0;
  lastOpts: PruneScanOpts | undefined;
  constructor(private readonly pks: string[]) {}
  async fetchAllPks(opts?: PruneScanOpts): Promise<string[]> {
    this.calls += 1;
    this.lastOpts = opts;
    return [...this.pks];
  }
}

/** The prune own-followers scan port: one whole-list scrape (mirrors following). */
class FakeOwnFollowers {
  calls = 0;
  lastOpts: PruneScanOpts | undefined;
  constructor(private readonly pks: string[]) {}
  async fetchAllPks(opts?: PruneScanOpts): Promise<string[]> {
    this.calls += 1;
    this.lastOpts = opts;
    return [...this.pks];
  }
}

/** Scripted churn actions: per-username outcomes, defaulting to a verified ok. */
class FakeChurnActions {
  unfollows: string[] = [];
  outcomes = new Map<string, ChurnActionOutcome>();
  async unfollow(username: string): Promise<ChurnActionOutcome> {
    this.unfollows.push(username);
    return this.outcomes.get(username) ?? { status: 'ok' };
  }
}

class FakeBudget {
  constructor(private allow = true) {}
  canSpend(): boolean {
    return this.allow;
  }
  setAllow(v: boolean): void {
    this.allow = v;
  }
}

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

// --- Harness -----------------------------------------------------------------------

const CFG: PruneConfig = {
  dailyLimit: 50,
  whitelist: [],
  minDelayMs: 60_000,
  maxDelayMs: 60_000, // min = max → deterministic base delay
  jitterPercent: 0,
  scanMinMs: 1_000,
  scanMaxMs: 3_000,
};

interface Harness {
  engine: PruneEngine;
  store: KnowledgeStore;
  clock: FakeClock;
  ownFollowing: FakeOwnFollowing;
  ownFollowers: FakeOwnFollowers;
  churn: FakeChurnActions;
  sentinel: FakeSentinel;
  budget: FakeBudget;
  sleeps: number[];
  statuses: PruneStatus[];
  completedAt: number[];
}

const build = (over: {
  following: string[];
  followers: string[];
  cfg?: Partial<PruneConfig>;
  sentinel?: FakeSentinel;
  budget?: FakeBudget;
  sleep?: SleepFn;
}): Harness => {
  const store = new KnowledgeStore(':memory:');
  store.setOwnPk(OWN_PK);
  const clock = new FakeClock(T0);
  const ownFollowing = new FakeOwnFollowing(over.following);
  const ownFollowers = new FakeOwnFollowers(over.followers);
  const churn = new FakeChurnActions();
  const sentinel = over.sentinel ?? new FakeSentinel();
  const budget = over.budget ?? new FakeBudget();
  const sleeps: number[] = [];
  const statuses: PruneStatus[] = [];
  const completedAt: number[] = [];

  // Give every non-self pk a stored username (u<pk>), as the live sources do.
  for (const pk of over.following) {
    if (pk === OWN_PK) continue;
    store.observe({ accountPk: pk, observedAt: T0, source: 'followers-list', fields: { username: `u${pk}` } });
  }

  const deps: PruneEngineDeps = {
    store,
    clock,
    ownPk: OWN_PK,
    ownFollowing,
    ownFollowers,
    churnActions: churn,
    requestBudget: budget,
    sentinel,
    cfg: { ...CFG, ...over.cfg },
    sleep:
      over.sleep ??
      (async (ms) => {
        sleeps.push(ms);
      }),
    rng: () => 0.5,
    onStatus: (s) => statuses.push(s),
    onRunComplete: (at) => completedAt.push(at),
  };
  return {
    engine: new PruneEngine(deps),
    store,
    clock,
    ownFollowing,
    ownFollowers,
    churn,
    sentinel,
    budget,
    sleeps,
    statuses,
    completedAt,
  };
};

// --- scan() ------------------------------------------------------------------------

describe('PruneEngine.scan', () => {
  test('candidates = following − followers − whitelist − self (whitelist case-insensitive on username AND pk)', async () => {
    const h = build({
      following: [OWN_PK, '1', '2', '3', '4'],
      followers: ['2', '9'], // '2' follows back; '9' is a non-followed follower
      cfg: { whitelist: ['U3', '4'] }, // 'U3' hits username u3 (ci); '4' hits the pk
    });

    const result = await h.engine.scan();

    expect(result.following).toBe(5);
    expect(result.followers).toBe(2);
    expect(result.candidates).toEqual([{ pk: '1', username: 'u1' }]);
    // Read-only: no unfollow was attempted, nothing entered the prune ledger.
    expect(h.churn.unfollows).toEqual([]);
    expect(h.store.pruneCountSince(0)).toBe(0);
    // Emitted scanning → … → idle.
    expect(h.statuses[0].state).toBe('scanning');
    expect(h.statuses[h.statuses.length - 1].state).toBe('idle');
    expect(h.engine.status().state).toBe('idle');
    expect(h.engine.status().candidates).toBe(1);
    h.store.close();
  });

  test('scan threads the configured pacing + a live shouldStop into BOTH sources', async () => {
    const h = build({
      following: [OWN_PK, '1'],
      followers: [],
      cfg: { scanMinMs: 4_000, scanMaxMs: 9_000 },
    });

    await h.engine.scan();

    for (const opts of [h.ownFollowing.lastOpts, h.ownFollowers.lastOpts]) {
      expect(opts?.scrollMinMs).toBe(4_000);
      expect(opts?.scrollMaxMs).toBe(9_000);
      expect(opts?.shouldStop?.()).toBe(false); // live, and not aborted
    }
    h.store.close();
  });

  test('stop() during scan aborts between phases: sources see shouldStop, scan resolves, state idle', async () => {
    // A gated following source: fetchAllPks hangs until the test releases it,
    // simulating a scrape in flight when stop() lands.
    let release: () => void = () => {};
    const gated = {
      opts: undefined as PruneScanOpts | undefined,
      fetchAllPks(opts?: PruneScanOpts): Promise<string[]> {
        gated.opts = opts;
        return new Promise<string[]>((resolve) => {
          release = (): void => resolve(['1', '2']);
        });
      },
    };
    const followers = new FakeOwnFollowers(['9']);
    const store = new KnowledgeStore(':memory:');
    store.setOwnPk(OWN_PK);
    const engine = new PruneEngine({
      store,
      clock: new FakeClock(T0),
      ownPk: OWN_PK,
      ownFollowing: gated,
      ownFollowers: followers,
      churnActions: new FakeChurnActions(),
      requestBudget: new FakeBudget(),
      sentinel: new FakeSentinel(),
      cfg: CFG,
      sleep: async () => {},
    });

    const scan = engine.scan();
    await new Promise((resolve) => setImmediate(resolve)); // the scrape is in flight
    engine.stop();
    expect(gated.opts?.shouldStop?.()).toBe(true); // the reader would break its loop now
    release();

    const result = await scan; // resolves promptly with what was gathered
    expect(result.following).toBe(2);
    expect(result.followers).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(followers.calls).toBe(0); // the followers phase never started
    expect(engine.status().state).toBe('idle');
    store.close();
  });
});

// --- run() -------------------------------------------------------------------------

describe('PruneEngine.run', () => {
  test('ok path: unfollows one at a time, reconciles the edge, records the ledger, human delay between', async () => {
    const h = build({
      following: [OWN_PK, '1', '2', '3'],
      followers: ['2'],
    });
    // We believed we followed both candidates (active edges to heal on unfollow).
    h.store.observeEdge(OWN_PK, '1', 'follows', true, T0 - 1000);
    h.store.observeEdge(OWN_PK, '3', 'follows', true, T0 - 1000);

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1', 'u3']);
    // Reconciled: our own-follow edges flipped to removed (leave-alone sink).
    expect(h.store.getEdge(OWN_PK, '1', 'follows')?.status).toBe('removed');
    expect(h.store.getEdge(OWN_PK, '3', 'follows')?.status).toBe('removed');
    // Both actions in the prune-own ledger; growth's action ledger untouched.
    expect(h.store.pruneCountSince(0)).toBe(2);
    expect(h.store.actionCountSince(0)).toBe(0);
    // One humanized delay per action (min = max = 60s, jitter 0).
    expect(h.sleeps).toEqual([60_000, 60_000]);
    // Completed: done + lastRunAt reported exactly once.
    const status = h.engine.status();
    expect(status.state).toBe('done');
    expect(status.unfollowed).toBe(2);
    expect(status.remaining).toBe(0);
    expect(h.completedAt).toEqual([T0]);
    expect(status.lastRunAt).toBe(T0);
    h.store.close();
  });

  test('stops at the prune-own daily cap (its own ledger, not growth’s ceiling)', async () => {
    const h = build({
      following: [OWN_PK, '1', '2', '3'],
      followers: [],
      cfg: { dailyLimit: 2 },
    });

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1', 'u2']); // the third never ran
    expect(h.store.pruneCountSince(0)).toBe(2);
    const status = h.engine.status();
    expect(status.state).toBe('done');
    expect(status.dailyDone).toBe(2);
    expect(status.remaining).toBe(1);
    h.store.close();
  });

  test('pre-existing ledger rows from today count against the cap', async () => {
    const h = build({
      following: [OWN_PK, '1', '2'],
      followers: [],
      cfg: { dailyLimit: 1 },
    });
    h.store.recordPruneAction('x', 'ok', T0 - 1000); // earlier today

    await h.engine.run();

    expect(h.churn.unfollows).toEqual([]); // cap already consumed
    expect(h.engine.status().dailyDone).toBe(1);
    h.store.close();
  });

  test('dry-run: simulated outcomes are ledgered (gating the cap) but never reconciled', async () => {
    const h = build({
      following: [OWN_PK, '1', '2'],
      followers: [],
    });
    h.churn.outcomes.set('u1', { status: 'simulated' });
    h.churn.outcomes.set('u2', { status: 'simulated' });
    h.store.observeEdge(OWN_PK, '1', 'follows', true, T0 - 1000);

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1', 'u2']);
    // Ledgered (dailyDone advances) …
    expect(h.store.pruneCountSince(0)).toBe(2);
    expect(h.engine.status().dailyDone).toBe(2);
    // … but NOT reconciled: the edge stays active and `unfollowed` stays 0.
    expect(h.store.getEdge(OWN_PK, '1', 'follows')?.status).toBe('active');
    expect(h.engine.status().unfollowed).toBe(0);
    expect(h.engine.status().state).toBe('done');
    h.store.close();
  });

  test('failed outcome is ledgered as fail; the run continues to the next candidate', async () => {
    const h = build({
      following: [OWN_PK, '1', '2'],
      followers: [],
    });
    h.churn.outcomes.set('u1', { status: 'failed' });

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1', 'u2']);
    expect(h.store.pruneCountSince(0)).toBe(2); // fail + ok both ledgered
    expect(h.engine.status().unfollowed).toBe(1); // only the verified ok counts
    h.store.close();
  });

  test('blocked leaves the account untouched (no ledger row), parks briefly, continues', async () => {
    const h = build({
      following: [OWN_PK, '1', '2'],
      followers: [],
    });
    h.churn.outcomes.set('u1', { status: 'blocked' });
    h.store.observeEdge(OWN_PK, '1', 'follows', true, T0 - 1000);

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1', 'u2']);
    // Only u2's ok reached the ledger; u1 was left completely untouched.
    expect(h.store.pruneCountSince(0)).toBe(1);
    expect(h.store.getEdge(OWN_PK, '1', 'follows')?.status).toBe('active');
    // The brief park was slept, then u2's human delay.
    expect(h.sleeps).toEqual([PRUNE_PARK_MS, 60_000]);
    expect(h.engine.status().state).toBe('done');
    h.store.close();
  });

  test('sentinel non-ok halts the run loud (no completion, no lastRunAt)', async () => {
    const h = build({
      following: [OWN_PK, '1', '2'],
      followers: [],
      sentinel: new FakeSentinel(['ok', 'challenge']),
    });

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1']); // second candidate hit the halt
    const status = h.engine.status();
    expect(status.state).toBe('halted');
    expect(status.lastSentinel).toBe('challenge');
    expect(h.completedAt).toEqual([]);
    expect(status.lastRunAt).toBeNull();
    h.store.close();
  });

  test('a still-closed request budget ends the run after one park (no blind attempts)', async () => {
    const h = build({
      following: [OWN_PK, '1'],
      followers: [],
      budget: new FakeBudget(false),
    });

    await h.engine.run();

    expect(h.churn.unfollows).toEqual([]);
    expect(h.sleeps).toEqual([PRUNE_PARK_MS]);
    expect(h.engine.status().state).toBe('done');
    h.store.close();
  });

  test('stop() interrupts the in-flight human delay instantly and lands in idle', async () => {
    // A sleep that hangs until its signal aborts — the real defaultSleep's abort
    // path, minus the timer.
    const hangingSleep: SleepFn = (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    const h = build({
      following: [OWN_PK, '1', '2', '3'],
      followers: [],
      sleep: hangingSleep,
    });

    const run = h.engine.run();
    // Let the first action + its (hanging) delay begin.
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.churn.unfollows).toEqual(['u1']);

    h.engine.stop();
    await run; // resolves promptly — the delay was aborted between actions

    expect(h.churn.unfollows).toEqual(['u1']); // nothing further ran
    expect(h.engine.status().state).toBe('idle');
    expect(h.completedAt).toEqual([]); // an interrupted run is not a completion
    h.store.close();
  });

  test('stop() during the run’s scan phase aborts it: no unfollows, run resolves, state idle', async () => {
    let release: () => void = () => {};
    const gated = {
      fetchAllPks(): Promise<string[]> {
        return new Promise<string[]>((resolve) => {
          release = (): void => resolve(['1', '2']);
        });
      },
    };
    const followers = new FakeOwnFollowers([]);
    const store = new KnowledgeStore(':memory:');
    store.setOwnPk(OWN_PK);
    const churn = new FakeChurnActions();
    const engine = new PruneEngine({
      store,
      clock: new FakeClock(T0),
      ownPk: OWN_PK,
      ownFollowing: gated,
      ownFollowers: followers,
      churnActions: churn,
      requestBudget: new FakeBudget(),
      sentinel: new FakeSentinel(),
      cfg: CFG,
      sleep: async () => {},
    });

    const run = engine.run();
    await new Promise((resolve) => setImmediate(resolve)); // scan phase in flight
    engine.stop();
    release();
    await run; // resolves promptly — the aborted scan never reaches the unfollow loop

    expect(churn.unfollows).toEqual([]);
    expect(followers.calls).toBe(0);
    expect(engine.status().state).toBe('idle');
    store.close();
  });

  test('a candidate without a known username is skipped with a typed warn (no unfollow, no ledger)', async () => {
    // Built by hand (not via the harness) so the store genuinely lacks an
    // account row — and hence a username — for the candidate pk.
    const store = new KnowledgeStore(':memory:');
    store.setOwnPk(OWN_PK);
    const churn = new FakeChurnActions();
    const engine = new PruneEngine({
      store,
      clock: new FakeClock(T0),
      ownPk: OWN_PK,
      ownFollowing: new FakeOwnFollowing(['ghost']),
      ownFollowers: new FakeOwnFollowers([]),
      churnActions: churn,
      requestBudget: new FakeBudget(),
      sentinel: new FakeSentinel(),
      cfg: CFG,
      sleep: async () => {},
    });

    await engine.run();

    expect(churn.unfollows).toEqual([]);
    expect(store.pruneCountSince(0)).toBe(0);
    expect(engine.status().state).toBe('done');
    store.close();
  });
});

// --- 2-step run + census enrichment (Phase 5 integration) --------------------------

describe('PruneEngine — 2-step run (scan then consume)', () => {
  test('a fresh scan is consumed by run() verbatim — no second list walk', async () => {
    const h = build({ following: [OWN_PK, '1', '2', '3'], followers: ['2'] });

    const scanRes = await h.engine.scan();
    expect(scanRes.candidates.map((c) => c.pk)).toEqual(['1', '3']);
    expect(h.engine.status().scanReady).toBe(true);
    expect(h.ownFollowing.calls).toBe(1);
    expect(h.ownFollowers.calls).toBe(1);

    await h.engine.run();

    // The run reused the reviewed set: neither source was scraped a second time.
    expect(h.ownFollowing.calls).toBe(1);
    expect(h.ownFollowers.calls).toBe(1);
    expect(h.churn.unfollows).toEqual(['u1', 'u3']);
    // Consumed: scanReady flips false so the next run needs its own fresh scan.
    expect(h.engine.status().scanReady).toBe(false);
    expect(h.engine.status().state).toBe('done');
    h.store.close();
  });

  test('run() without a fresh scan scans internally (scheduled path)', async () => {
    const h = build({ following: [OWN_PK, '1', '2'], followers: [] });
    expect(h.engine.status().scanReady).toBe(false);

    await h.engine.run();

    expect(h.ownFollowing.calls).toBe(1); // scanned as part of the run
    expect(h.ownFollowers.calls).toBe(1);
    expect(h.churn.unfollows).toEqual(['u1', 'u2']);
    h.store.close();
  });

  test('a stale scan is NOT consumed: run() re-scans past the freshness window', async () => {
    const h = build({ following: [OWN_PK, '1'], followers: [] });

    await h.engine.scan();
    expect(h.engine.status().scanReady).toBe(true);

    h.clock.advance(PRUNE_SCAN_FRESH_MS + 1); // age the cache out
    expect(h.engine.status().scanReady).toBe(false);

    await h.engine.run();
    expect(h.ownFollowing.calls).toBe(2); // re-scanned rather than consuming stale
    h.store.close();
  });

  test('changing the whitelist invalidates a cached scan (Run re-locks)', async () => {
    const h = build({ following: [OWN_PK, '1'], followers: [] });

    await h.engine.scan();
    expect(h.engine.status().scanReady).toBe(true);

    h.engine.applyConfig({ ...CFG, whitelist: ['someone'] });
    expect(h.engine.status().scanReady).toBe(false);

    // An unrelated knob change leaves a fresh cache intact.
    await h.engine.scan();
    expect(h.engine.status().scanReady).toBe(true);
    h.engine.applyConfig({ ...CFG, whitelist: ['someone'], dailyLimit: 7 });
    expect(h.engine.status().scanReady).toBe(true);
    h.store.close();
  });
});

describe('PruneEngine — census enrichment + growth exclusion', () => {
  test('scan excludes accounts the growth engine is actively managing', async () => {
    const h = build({ following: [OWN_PK, '1', '2'], followers: [] });
    // '1' is mid-lifecycle in growth (awaiting a follow-back) — off-limits to prune.
    h.store.upsertFollowRecord({
      accountPk: '1',
      targetPk: null,
      state: 'pending_followback',
      retryCount: 0,
    });

    const res = await h.engine.scan();

    expect(res.candidates.map((c) => c.pk)).toEqual(['2']); // '1' is growth-managed
    h.store.close();
  });

  test('scan feeds the census into the shared graph (who-we-follow + who-follows-us edges)', async () => {
    const h = build({ following: [OWN_PK, '1'], followers: ['9'] });

    await h.engine.scan();

    // Following pk reconciled as one we follow; follower pk recorded as following us.
    expect(h.store.getEdge(OWN_PK, '1', 'follows')?.status).toBe('active');
    expect(h.store.getEdge('9', OWN_PK, 'follows')?.status).toBe('active');
    h.store.close();
  });
});
