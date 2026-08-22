/**
 * PruneEngine tests (Phase 5 — auto-prune).
 *
 * Real `:memory:` KnowledgeStore beneath a FakeClock; scripted fakes for every
 * live-edge port (own-following, own-followers, churn actions,
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
  PRUNE_CONSECUTIVE_FAIL_HALT,
  PRUNE_PARK_MS,
  PRUNE_PROGRESS_EMIT_MS,
  PRUNE_SCAN_FRESH_MS,
  pruneDue,
  type PruneConfig,
  type PruneEngineDeps,
  type PruneScanFetch,
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
import { cyclePlan } from '@/timing/cycle-plan';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const T0 = Date.parse('2026-08-12T12:00:00'); // local noon
const OWN_PK = 'ME';

// --- Fakes -------------------------------------------------------------------------

class FakeOwnFollowing {
  calls = 0;
  lastOpts: PruneScanOpts | undefined;
  constructor(private readonly pks: string[]) {}
  async fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch> {
    this.calls += 1;
    this.lastOpts = opts;
    return { pks: [...this.pks], complete: true, reason: 'no-more-pages' };
  }
}

/** The prune own-followers scan port: one whole-list scrape (mirrors following). */
class FakeOwnFollowers {
  calls = 0;
  lastOpts: PruneScanOpts | undefined;
  constructor(private readonly pks: string[]) {}
  async fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch> {
    this.calls += 1;
    this.lastOpts = opts;
    return { pks: [...this.pks], complete: true, reason: 'no-more-pages' };
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
  bioFilterWords: [],
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
  sleeps: number[];
  statuses: PruneStatus[];
  completedAt: number[];
}

const build = (over: {
  following: string[];
  followers: string[];
  cfg?: Partial<PruneConfig>;
  sentinel?: FakeSentinel;
  sleep?: SleepFn;
  refreshOwnStats?: () => Promise<void>;
  cycleStartMs?: (now: number) => number;
  enrichProfile?: (username: string) => Promise<number>;
}): Harness => {
  const store = new KnowledgeStore(':memory:');
  store.setOwnPk(OWN_PK);
  const clock = new FakeClock(T0);
  const ownFollowing = new FakeOwnFollowing(over.following);
  const ownFollowers = new FakeOwnFollowers(over.followers);
  const churn = new FakeChurnActions();
  const sentinel = over.sentinel ?? new FakeSentinel();
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
    refreshOwnStats: over.refreshOwnStats,
    cycleStartMs: over.cycleStartMs,
    enrichProfile: over.enrichProfile,
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

// --- scan() ------------------------------------------------------------------------

describe('PruneEngine.scan', () => {
  test('scan census is RAW (following − followers − self); whitelist derives the counts', async () => {
    const h = build({
      following: [OWN_PK, '1', '2', '3', '4'],
      followers: ['2', '9'], // '2' follows back; '9' is a non-followed follower
      cfg: { whitelist: ['U3', '4'] }, // 'U3' hits username u3 (ci); '4' hits the pk
    });

    const result = await h.engine.scan();

    expect(result.following).toBe(5);
    expect(result.followers).toBe(2);
    // The census carries EVERY non-follower (whitelist NOT applied) so a later
    // whitelist edit can hide or restore rows without a re-scan…
    expect(result.candidates).toEqual([
      { pk: '1', username: 'u1' },
      { pk: '3', username: 'u3' },
      { pk: '4', username: 'u4' },
    ]);
    // Read-only: no unfollow was attempted, nothing entered the prune ledger.
    expect(h.churn.unfollows).toEqual([]);
    expect(h.store.pruneCountSince(0)).toBe(0);
    // Emitted scanning → … → idle.
    expect(h.statuses[0].state).toBe('scanning');
    expect(h.statuses[h.statuses.length - 1].state).toBe('idle');
    expect(h.engine.status().state).toBe('idle');
    // …while the status counts reflect the ACTIONABLE subset (whitelist applied).
    expect(h.engine.status().candidates).toBe(1);

    // A run consumes only the actionable subset — whitelisted accounts survive.
    await h.engine.run();
    expect(h.churn.unfollows).toEqual(['u1']);
    h.store.close();
  });

  test('scan projects the live phase + header estimate for the progress bar', async () => {
    const h = build({ following: [OWN_PK, '1'], followers: ['9'] });
    // Our own header counts, as the always-on profile-info observer stores them.
    h.store.observe({
      accountPk: OWN_PK,
      observedAt: T0,
      source: 'profile',
      fields: { followers: 30, following: 20 },
    });

    await h.engine.scan();

    // Phases were projected in order — each carrying BOTH header estimates (so
    // the UI can draw one continuous bar across the hand-off) — then cleared.
    const phases = h.statuses.map((s) => [s.scanPhase, s.scanEstimates]);
    expect(phases).toContainEqual(['following', { following: 20, followers: 30 }]);
    expect(phases).toContainEqual(['followers', { following: 20, followers: 30 }]);
    const last = h.statuses[h.statuses.length - 1];
    expect(last.scanPhase).toBeNull();
    expect(last.scanEstimates).toBeNull();
    expect(h.engine.status().scanPhase).toBeNull();
    h.store.close();
  });

  test('scan awaits the active own-stats refresh BEFORE reading estimates', async () => {
    // The store starts with NO header stats (the real failure mode: an SPA
    // profile load never issued web_profile_info, so passive observation
    // caught nothing). The injected refresh — standing in for the live
    // enricher's one own-profile fetch — lands them; the projected estimates
    // prove the scan awaited it first.
    let refreshed = 0;
    const h = build({
      following: [OWN_PK, '1'],
      followers: ['9'],
      refreshOwnStats: async () => {
        refreshed += 1;
        h.store.observe({
          accountPk: OWN_PK,
          observedAt: T0,
          source: 'profile',
          fields: { followers: 30, following: 20 },
        });
      },
    });

    await h.engine.scan();

    expect(refreshed).toBe(1);
    const phases = h.statuses.map((s) => [s.scanPhase, s.scanEstimates]);
    expect(phases).toContainEqual(['following', { following: 20, followers: 30 }]);
  });

  test('a rejecting own-stats refresh degrades to a bar-less scan, never a failed one', async () => {
    const h = build({
      following: [OWN_PK, '1'],
      followers: ['9'],
      refreshOwnStats: async () => {
        throw new Error('tab gone');
      },
    });

    const result = await h.engine.scan();

    expect(result.following).toBe(2);
    // Every phase-carrying projection has empty (null-halved) estimates — the
    // scan ran to completion without them, and never surfaced the rejection.
    const phased = h.statuses.filter((s) => s.scanPhase !== null);
    expect(phased.length).toBeGreaterThan(0);
    for (const s of phased) {
      expect(s.scanEstimates).toEqual({ following: null, followers: null });
    }
    expect(h.engine.status().state).toBe('idle');
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

  test('scan surfaces LIVE mid-scrape counts, throttled to one emission per PRUNE_PROGRESS_EMIT_MS', async () => {
    const store = new KnowledgeStore(':memory:');
    store.setOwnPk(OWN_PK);
    const clock = new FakeClock(T0);
    const statuses: PruneStatus[] = [];

    // A following source that reports page-by-page progress: three pages inside
    // one throttle window (only the first may emit), then one after it elapses.
    const following = {
      async fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch> {
        opts?.onProgress?.(12); // emitted (first in the window)
        opts?.onProgress?.(24); // suppressed (same window)
        opts?.onProgress?.(36); // suppressed
        clock.advance(PRUNE_PROGRESS_EMIT_MS);
        opts?.onProgress?.(48); // emitted (window elapsed)
        return {
          pks: Array.from({ length: 48 }, (_, i) => `f${i}`),
          complete: true,
          reason: 'no-more-pages',
        };
      },
    };
    const followers = {
      async fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch> {
        clock.advance(PRUNE_PROGRESS_EMIT_MS);
        opts?.onProgress?.(7);
        return {
          pks: Array.from({ length: 7 }, (_, i) => `f${i}`), // all follow back
          complete: true,
          reason: 'no-more-pages',
        };
      },
    };
    const engine = new PruneEngine({
      store,
      clock,
      ownPk: OWN_PK,
      ownFollowing: following,
      ownFollowers: followers,
      churnActions: new FakeChurnActions(),
      sentinel: new FakeSentinel(),
      cfg: CFG,
      sleep: async () => {},
      onStatus: (s) => statuses.push(s),
    });

    await engine.scan();

    // The scanning-phase projections carried the counts as they grew…
    const scanning = statuses.filter((s) => s.state === 'scanning');
    const followingSeen = scanning.map((s) => s.following);
    expect(followingSeen).toContain(0); // fresh census counts up from zero
    expect(followingSeen).toContain(12);
    expect(followingSeen).not.toContain(24); // throttled away
    expect(followingSeen).not.toContain(36); // throttled away
    expect(followingSeen).toContain(48);
    expect(scanning.map((s) => s.followers)).toContain(7);
    // …and the settled projection carries the true totals.
    const last = statuses[statuses.length - 1];
    expect(last.following).toBe(48);
    expect(last.followers).toBe(7);
    expect(last.candidates).toBe(41); // f7..f47 do not follow back
    store.close();
  });

  test('stop() during scan aborts between phases: sources see shouldStop, scan resolves, state idle', async () => {
    // A gated following source: fetchAllPks hangs until the test releases it,
    // simulating a scrape in flight when stop() lands.
    let release: () => void = () => {};
    const gated = {
      opts: undefined as PruneScanOpts | undefined,
      fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch> {
        gated.opts = opts;
        return new Promise<PruneScanFetch>((resolve) => {
          release = (): void =>
            resolve({ pks: ['1', '2'], complete: true, reason: 'no-more-pages' });
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
  test('ok path: unfollows one at a time, reconciles the edge, records the ledger, paced delay between', async () => {
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
    // One inter-action delay per action: 60s base (min = max, jitter 0) scaled
    // to a third by PRUNE_DELAY_FACTOR → 20s.
    expect(h.sleeps).toEqual([20_000, 20_000]);
    // Completed: done + lastRunAt reported exactly once.
    const status = h.engine.status();
    expect(status.state).toBe('done');
    expect(status.unfollowed).toBe(2);
    expect(status.remaining).toBe(0);
    expect(h.completedAt).toEqual([T0]);
    expect(status.lastRunAt).toBe(T0);
    h.store.close();
  });

  test('status().nextActionAt carries the inter-unfollow deadline while waiting, null after', async () => {
    const h = build({
      following: [OWN_PK, '1'],
      followers: [],
    });

    await h.engine.run();

    // The mid-wait emission carried the REAL deadline: 60s base ×1/3 = 20s out.
    const midWait = h.statuses.find((s) => s.nextActionAt !== null);
    expect(midWait).toBeDefined();
    expect(midWait!.nextActionAt).toBe(T0 + 20_000);
    expect(h.engine.status().nextActionAt).toBeNull();
    h.store.close();
  });

  test('inter-action delay runs at a THIRD of the paced pace (PRUNE_DELAY_FACTOR)', async () => {
    const h = build({
      following: [OWN_PK, '1'],
      followers: [],
      cfg: { minDelayMs: 90_000, maxDelayMs: 90_000, jitterPercent: 0 }, // deterministic 90s base
    });

    await h.engine.run();

    // 90s base scaled to a third → 30s between unfollows (one action here).
    expect(h.sleeps).toEqual([30_000]);
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

  test('a transient block parks briefly and RETRIES the same candidate (never skipped)', async () => {
    const h = build({
      following: [OWN_PK, '1', '2'],
      followers: [],
    });
    // u1 is blocked exactly once, then succeeds — the old behavior skipped it
    // permanently (consumed from the durable set without ever acting).
    let u1Blocks = 1;
    h.churn.unfollow = async (username: string): Promise<ChurnActionOutcome> => {
      h.churn.unfollows.push(username);
      if (username === 'u1' && u1Blocks > 0) {
        u1Blocks -= 1;
        return { status: 'blocked' };
      }
      return { status: 'ok' };
    };
    h.store.observeEdge(OWN_PK, '1', 'follows', true, T0 - 1000);

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1', 'u1', 'u2']); // retried, then moved on
    expect(h.store.pruneCountSince(0)).toBe(2); // both eventually reached the ledger
    // The brief park, then u1's inter-action delay, then u2's (60s base ×1/3 = 20s).
    expect(h.sleeps).toEqual([PRUNE_PARK_MS, 20_000, 20_000]);
    expect(h.engine.status().state).toBe('done');
    h.store.close();
  });

  test('persistently blocked halts loud and never consumes the candidate', async () => {
    const h = build({
      following: [OWN_PK, '1'],
      followers: [],
    });
    h.churn.outcomes.set('u1', { status: 'blocked' });

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1', 'u1', 'u1']); // three attempts, bounded
    expect(h.store.pruneCountSince(0)).toBe(0); // nothing ever reached the ledger
    expect(h.engine.status().state).toBe('halted');
    // The candidate was never visited: the durable remaining set still holds it.
    expect(h.store.getPruneScan()?.remaining.map((c) => c.pk)).toContain('1');
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

  test('stop() interrupts the in-flight paced delay instantly and lands in idle', async () => {
    // A sleep that hangs until its signal aborts — the real defaultSleep's abort
    // path, minus the timer.
    const hangingSleep: SleepFn = (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
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
      fetchAllPks(): Promise<PruneScanFetch> {
        return new Promise<PruneScanFetch>((resolve) => {
          release = (): void =>
            resolve({ pks: ['1', '2'], complete: true, reason: 'no-more-pages' });
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

  test('a whitelist edit re-derives the cached scan live (no re-lock, no re-scan)', async () => {
    const h = build({ following: [OWN_PK, '1', '2'], followers: [] });

    await h.engine.scan();
    expect(h.engine.status().scanReady).toBe(true);
    expect(h.engine.status().candidates).toBe(2);

    // Adding to the whitelist hides that candidate immediately — Run stays
    // unlocked over the reduced set.
    h.engine.applyConfig({ ...CFG, whitelist: ['u1'] });
    expect(h.engine.status().scanReady).toBe(true);
    expect(h.engine.status().candidates).toBe(1);
    expect(h.engine.status().remaining).toBe(1);

    // Removing them from the whitelist restores the candidate.
    h.engine.applyConfig({ ...CFG, whitelist: [] });
    expect(h.engine.status().candidates).toBe(2);

    // The run honors the whitelist AS IT STANDS at run time.
    h.engine.applyConfig({ ...CFG, whitelist: ['u2'] });
    await h.engine.run();
    expect(h.churn.unfollows).toEqual(['u1']);
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

// --- Live-graph guard + stopped-run remainder (docs/PRINCIPLES.md §2/§3) ------------

describe('live-graph guard and remainder handback', () => {
  test('a candidate who followed back AFTER the scan is skipped, never unfollowed', async () => {
    const h = build({
      following: [OWN_PK, '1', '2'],
      followers: [], // census: both are non-followers
    });
    await h.engine.scan();

    // Between scan and run, a notifications check records '1' following us.
    h.store.observeEdge('1', OWN_PK, 'follows', true, T0 + 1);

    await h.engine.run();

    // '1' was spared by the live graph; only '2' was unfollowed.
    expect(h.churn.unfollows).toEqual(['u2']);
    // '1' was still visited (consumed), so the run reports a clean finish.
    expect(h.engine.status().remaining).toBe(0);
    expect(h.completedAt.length).toBe(1);
  });

  test('a STOPPED run keeps its unvisited remainder runnable (no re-scan required)', async () => {
    const h = build({
      following: [OWN_PK, '1', '2', '3'],
      followers: [],
    });
    await h.engine.scan();

    // Stop the run after the first unfollow: the paced inter-action delay is
    // where stop() lands, so hook the sleep to fire it.
    let stopped = false;
    const origUnfollow = h.churn.unfollow.bind(h.churn);
    h.churn.unfollow = async (username: string) => {
      const out = await origUnfollow(username);
      if (!stopped) {
        stopped = true;
        h.engine.stop();
      }
      return out;
    };

    await h.engine.run();

    expect(h.engine.status().state).toBe('idle'); // a stop is not a failure
    expect(h.churn.unfollows.length).toBe(1);
    // The remainder is STILL runnable: scanReady holds and a second run
    // continues from where the stop landed instead of demanding a re-scan.
    expect(h.engine.status().scanReady).toBe(true);
    expect(h.engine.status().remaining).toBe(2);

    await h.engine.run();
    expect(h.churn.unfollows.length).toBe(3);
    expect(h.completedAt.length).toBe(1); // only the finishing run stamps lastRunAt
  });
});

test('consecutive FAILED unfollows halt the run (actions-failing) with the remainder runnable', async () => {
  const h = build({
    following: [OWN_PK, '1', '2', '3', '4', '5', '6', '7'],
    followers: [],
  });
  await h.engine.scan();
  // Every unfollow fails (e.g. Instagram silently rejecting the mutation).
  for (const pk of ['1', '2', '3', '4', '5', '6', '7']) {
    h.churn.outcomes.set(`u${pk}`, { status: 'failed' });
  }

  await h.engine.run();

  expect(h.engine.status().state).toBe('halted');
  expect(h.churn.unfollows.length).toBe(4); // stopped at the breaker, not 7
  // The unvisited remainder stays runnable for after the block clears.
  expect(h.engine.status().scanReady).toBe(true);
  expect(h.engine.status().remaining).toBe(3);
  expect(h.completedAt.length).toBe(0); // never stamped as a clean run
});

describe('PruneEngine — daily cap counts from the active-hours cycle start', () => {
  test('prune work recorded BEFORE the current cycle opened does not spend the cap', async () => {
    const h = build({
      following: ['a', 'b'],
      followers: [],
      cfg: { dailyLimit: 1 },
      // The current cycle opened 30 minutes ago (same calendar day).
      cycleStartMs: (now) => now - 30 * 60_000,
    });
    // An unfollow from an hour ago: same day, but the PREVIOUS cycle's work.
    h.store.recordPruneAction('x', 'ok', h.clock.now());
    h.clock.advance(3_600_000);
    expect(h.engine.atDailyCap(h.clock.now())).toBe(false);
    expect(h.engine.status().dailyDone).toBe(0);
  });

  test('without an injected cycle boundary the cap falls back to local midnight', async () => {
    const h = build({ following: ['a', 'b'], followers: [], cfg: { dailyLimit: 1 } });
    h.store.recordPruneAction('x', 'ok', h.clock.now());
    h.clock.advance(3_600_000); // same local day
    expect(h.engine.atDailyCap(h.clock.now())).toBe(true);
  });
});

describe('PruneEngine — bio filter (protected words in the profile bio)', () => {
  const bioObs = (h: Harness, pk: string, bio: string): void =>
    h.store.observe({ accountPk: pk, observedAt: h.clock.now(), source: 'profile', fields: { bio } });

  test('a candidate whose stored bio matches is skipped; others are unfollowed', async () => {
    const h = build({
      following: [OWN_PK, '1', '2'],
      followers: [],
      cfg: { bioFilterWords: ['dog'] },
    });
    bioObs(h, '1', 'Dog mom 🐶');
    bioObs(h, '2', 'photographer');

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u2']);
    expect(h.store.pruneCountSince(0)).toBe(1); // the skip spends no cap
    h.store.close();
  });

  test('an unknown bio is fetched via the enricher before deciding; a match protects', async () => {
    const enriched: string[] = [];
    const h: Harness = build({
      following: [OWN_PK, '1'],
      followers: [],
      cfg: { bioFilterWords: ['dog'] },
      enrichProfile: async (username) => {
        enriched.push(username);
        bioObs(h, '1', 'proud DOG dad');
        return 1;
      },
    });

    await h.engine.run();

    expect(enriched).toEqual(['u1']);
    expect(h.churn.unfollows).toEqual([]);
    h.store.close();
  });

  test('a fetched-and-empty bio is a fact, not a failure: the unfollow proceeds', async () => {
    const h: Harness = build({
      following: [OWN_PK, '1'],
      followers: [],
      cfg: { bioFilterWords: ['dog'] },
      enrichProfile: async () => {
        bioObs(h, '1', '');
        return 1;
      },
    });

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1']);
    h.store.close();
  });

  test('a bio fetch failing repeatedly halts the run loudly (never unfollows blind)', async () => {
    const h = build({
      following: [OWN_PK, '1'],
      followers: [],
      cfg: { bioFilterWords: ['dog'] },
      enrichProfile: async () => 0,
    });

    await h.engine.run();

    expect(h.churn.unfollows).toEqual([]);
    expect(h.engine.status().state).toBe('halted');
    h.store.close();
  });

  test('with no filter words configured the enricher is never consulted', async () => {
    let enrichCalls = 0;
    const h = build({
      following: [OWN_PK, '1'],
      followers: [],
      enrichProfile: async () => {
        enrichCalls += 1;
        return 1;
      },
    });

    await h.engine.run();

    expect(enrichCalls).toBe(0);
    expect(h.churn.unfollows).toEqual(['u1']);
    h.store.close();
  });

  test('woven feed: nextCandidate consumes a stored-bio match; executeUnfollow skips a fresh one', async () => {
    const h: Harness = build({
      following: [OWN_PK, '1', '2'],
      followers: [],
      cfg: { bioFilterWords: ['dog'] },
      enrichProfile: async () => {
        bioObs(h, '2', 'dog walker'); // '2' only becomes known at check time
        return 1;
      },
    });
    bioObs(h, '1', 'dog mom'); // '1' is known before selection

    await h.engine.scan();
    const cand = h.engine.nextCandidate(h.clock.now());
    expect(cand).toEqual({ pk: '2', username: 'u2' }); // '1' consumed at selection

    const status = await h.engine.executeUnfollow(cand!, h.clock.now());
    expect(status).toBe('skipped');
    expect(h.churn.unfollows).toEqual([]);
    expect(h.store.pruneCountSince(0)).toBe(0); // no ledger row for either skip
    expect(h.engine.nextCandidate(h.clock.now())).toBeNull(); // census fully consumed
    h.store.close();
  });
});

describe('PruneEngine — per-cycle plan (fluctuates just under the daily limit)', () => {
  const CYCLE_START = T0 - 30 * 60_000;

  test('the cap trips at the cycle plan, before the configured limit', async () => {
    const h = build({
      following: ['a', 'b'],
      followers: [],
      cfg: { dailyLimit: 50 },
      cycleStartMs: () => CYCLE_START,
    });
    const plan = cyclePlan(50, CYCLE_START);
    expect(plan).toBeLessThan(50);
    for (let i = 0; i < plan - 1; i += 1) h.store.recordPruneAction(`p${i}`, 'ok', h.clock.now());
    expect(h.engine.atDailyCap(h.clock.now())).toBe(false);
    h.store.recordPruneAction('last', 'ok', h.clock.now());
    expect(h.engine.atDailyCap(h.clock.now())).toBe(true);
  });

  test('status reports the plan as the daily limit so the meter can complete', async () => {
    const h = build({
      following: ['a', 'b'],
      followers: [],
      cfg: { dailyLimit: 50 },
      cycleStartMs: () => CYCLE_START,
    });
    expect(h.engine.status().dailyLimit).toBe(cyclePlan(50, CYCLE_START));
  });
});

describe('PruneEngine — scan freshness window', () => {
  test('a completed scan stays runnable for 4 days, then expires', async () => {
    const h = build({ following: ['a', 'b'], followers: [] });
    await h.engine.scan();
    h.clock.advance(3 * 24 * 3_600_000); // 3 days on — still fresh
    expect(h.engine.status().scanReady).toBe(true);
    h.clock.advance(24 * 3_600_000 + 60_000); // past 4 days — stale
    expect(h.engine.status().scanReady).toBe(false);
  });
});

describe('PruneEngine — woven feed (EngineUnfollowFeed)', () => {
  test('nextCandidate returns the first actionable candidate, skipping whitelisted ones', async () => {
    const h = build({ following: ['a', 'b'], followers: [], cfg: { whitelist: ['ua'] } });
    await h.engine.scan();
    expect(h.engine.nextCandidate(h.clock.now())).toEqual({ pk: 'b', username: 'ub' });
  });

  test('a whitelisted skip does not decrement remaining (it was never in the actionable count)', async () => {
    const h = build({ following: ['a', 'b'], followers: [], cfg: { whitelist: ['ua'] } });
    await h.engine.scan();
    // The actionable census is exactly [b]: the whitelisted a is excluded up front.
    expect(h.engine.status().remaining).toBe(1);
    // Walking the feed skips a permanently — but must not spend b's slot doing so.
    expect(h.engine.nextCandidate(h.clock.now())).toEqual({ pk: 'b', username: 'ub' });
    expect(h.engine.status().remaining).toBe(1);
    // The skip is still durable: a is consumed from the snapshot's remaining set.
    expect(h.store.getPruneScan()?.remaining.map((c) => c.pk)).not.toContain('a');
  });

  test('atDailyCap and nextCandidate honor the prune daily cap', async () => {
    const h = build({ following: ['a', 'b', 'c'], followers: [], cfg: { dailyLimit: 2 } });
    await h.engine.scan();
    h.store.recordPruneAction('x', 'ok', h.clock.now());
    h.store.recordPruneAction('y', 'ok', h.clock.now());
    expect(h.engine.atDailyCap(h.clock.now())).toBe(true);
    expect(h.engine.nextCandidate(h.clock.now())).toBeNull();
  });

  test('executeUnfollow(ok) writes the ledger, heals the edge, and consumes the candidate', async () => {
    const h = build({ following: ['a', 'b'], followers: [] });
    await h.engine.scan();
    const c = h.engine.nextCandidate(h.clock.now());
    expect(c).not.toBeNull();
    const status = await h.engine.executeUnfollow(c as { pk: string; username: string }, h.clock.now());
    expect(status).toBe('ok');
    expect(h.churn.unfollows).toEqual([(c as { username: string }).username]);
    expect(h.engine.nextCandidate(h.clock.now())?.pk).not.toBe(c?.pk); // consumed
  });

  test('a blocked unfollow keeps the candidate and suspends the feed after repeats', async () => {
    const h = build({ following: ['a', 'b', 'c'], followers: [] });
    await h.engine.scan();
    const c = h.engine.nextCandidate(h.clock.now()) as { pk: string; username: string };
    h.churn.outcomes.set(c.username, { status: 'blocked' });
    expect(await h.engine.executeUnfollow(c, h.clock.now())).toBe('blocked');
    expect(h.engine.nextCandidate(h.clock.now())?.pk).toBe(c.pk); // not consumed
    await h.engine.executeUnfollow(c, h.clock.now());
    await h.engine.executeUnfollow(c, h.clock.now());
    expect(h.engine.nextCandidate(h.clock.now())).toBeNull(); // suspended after 3 blocks
  });

  test('consecutive failures suspend the feed (growth is unaffected)', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'];
    const h = build({ following: many, followers: [] });
    await h.engine.scan();
    for (const pk of many) h.churn.outcomes.set(`u${pk}`, { status: 'failed' });
    for (let i = 0; i < PRUNE_CONSECUTIVE_FAIL_HALT; i++) {
      const c = h.engine.nextCandidate(h.clock.now());
      if (c === null) break;
      await h.engine.executeUnfollow(c, h.clock.now());
    }
    expect(h.engine.nextCandidate(h.clock.now())).toBeNull();
  });

  test('a fresh scan re-arms a suspended feed', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'];
    const h = build({ following: many, followers: [] });
    await h.engine.scan();
    for (const pk of many) h.churn.outcomes.set(`u${pk}`, { status: 'failed' });
    for (let i = 0; i < PRUNE_CONSECUTIVE_FAIL_HALT; i++) {
      const c = h.engine.nextCandidate(h.clock.now());
      if (c !== null) await h.engine.executeUnfollow(c, h.clock.now());
    }
    expect(h.engine.nextCandidate(h.clock.now())).toBeNull();
    h.churn.outcomes.clear();
    await h.engine.scan();
    expect(h.engine.nextCandidate(h.clock.now())).not.toBeNull();
  });
});
