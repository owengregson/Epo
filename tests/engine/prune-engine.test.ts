/**
 * PruneEngine tests (auto-prune).
 *
 * Real `:memory:` KnowledgeStore beneath a FakeClock; the shared engine kit
 * supplies every live-edge port fake and the prune harness. Covers the
 * candidate set-diff (self
 * excluded), the prune-own daily cap, the dry-run path (simulated, no
 * reconcile), the ok path (reconcile + ledger), blocked (untouched + park), the
 * sentinel halt, and instant interruptibility via `stop()`.
 */

import type { ChurnActionOutcome } from '@/engine/churn-scheduler';
import type { SleepFn } from '@/engine/engine';
import {
  PRUNE_CONSECUTIVE_FAIL_HALT,
  PRUNE_PROGRESS_EMIT_MS,
  PRUNE_SCAN_FRESH_MS,
  PruneEngine,
  type PruneScanFetch,
  type PruneScanOpts,
  type PruneStatus,
} from '@/engine/prune-engine';
import { FakeClock } from '@/governors/clock';
import { referenceTempoSource } from '@/kernel/tempo';
import { NOISE, PRUNE } from '@/timing/config';
import { cyclePlan } from '@/timing/cycle-plan';
import {
  makePruneHarness as build,
  PRUNE_CFG as CFG,
  FakeListSource,
  FakePruneActions,
  FakeSentinel,
  kitStore,
  OWN_PK,
  T0,
} from '../kit/engine-harness';
import { openTestStore } from '../kit/store';
import { recordingTempo } from '../kit/tempo';

// --- scan() ------------------------------------------------------------------------

describe('PruneEngine.scan', () => {
  test('scan census is RAW (following − followers − self); protection derives the counts elsewhere', async () => {
    const h = build({
      following: [OWN_PK, '1', '2', '3', '4'],
      followers: ['2', '9'], // '2' follows back; '9' is a non-followed follower
    });

    const result = await h.engine.scan();

    expect(result.following).toBe(5);
    expect(result.followers).toBe(2);
    // The census carries EVERY non-follower (protection NOT applied) so a later
    // rule edit can hide or restore rows without a re-scan (prune-protection.test.ts).
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
    // No rule configured: every census row is actionable, and a run consumes them all.
    expect(h.engine.status().candidates).toBe(3);
    await h.engine.run();
    expect(h.churn.unfollows).toEqual(['u1', 'u3', 'u4']);
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

  test('a rejecting own-stats refresh preserves relationship evidence and never starts a census', async () => {
    const h = build({
      following: [OWN_PK, '1'],
      followers: ['9'],
      refreshOwnStats: async () => {
        throw new Error('tab gone');
      },
    });

    h.store.observeEdge('existing', OWN_PK, 'follows', true, T0 - 1);
    await expect(h.engine.scan()).rejects.toThrow('tab gone');
    expect(h.ownFollowing.calls).toBe(0);
    expect(h.ownFollowers.calls).toBe(0);
    expect(h.store.getEdge('existing', OWN_PK, 'follows')).toMatchObject({ status: 'active', lastConfirmedAt: T0 - 1 });
    expect(h.store.getPruneCensus()).toBeNull();
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
    const store = openTestStore(':memory:');
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
      churnActions: new FakePruneActions(),
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
    const followers = new FakeListSource(['9']);
    const store = openTestStore(':memory:');
    store.setOwnPk(OWN_PK);
    const engine = new PruneEngine({
      store,
      clock: new FakeClock(T0),
      ownPk: OWN_PK,
      ownFollowing: gated,
      ownFollowers: followers,
      churnActions: new FakePruneActions(),
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
    // Equal bounds receive positive-only variation: rng=0.5 draws 73.5s,
    // then PRUNE_DELAY_FACTOR scales the real sampled gap to 24.5s.
    expect(h.sleeps).toEqual([24_500, 24_500]);
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

    // The mid-wait emission carries the sampled deadline: 73.5s ×1/3 = 24.5s.
    const midWait = h.statuses.find((s) => s.nextActionAt !== null);
    expect(midWait).toBeDefined();
    expect(midWait!.nextActionAt).toBe(T0 + 24_500);
    expect(h.engine.status().nextActionAt).toBeNull();
    h.store.close();
  });

  test('inter-action delay runs at a THIRD of the paced pace (PRUNE_DELAY_FACTOR)', async () => {
    const h = build({
      following: [OWN_PK, '1'],
      followers: [],
      cfg: { minDelayMs: 90_000, maxDelayMs: 90_000, jitterPercent: 0 },
    });

    await h.engine.run();

    // rng=0.5 draws 110.25s from the positive-only band, then scales by one third.
    expect(h.sleeps).toEqual([36_750]);
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
    // The brief park (a retry backoff jittered around the park.blocked base, bounded),
    // then u1's inter-action delay, then u2's (60s base ×1/3 = 20s, exact).
    const park = referenceTempoSource().base('park.blocked');
    expect(h.sleeps.length).toBe(3);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(park * NOISE.BACKOFF_MIN_FACTOR);
    expect(h.sleeps[0]).toBeLessThanOrEqual(park * NOISE.BACKOFF_MAX_FACTOR);
    expect(h.sleeps.slice(1)).toEqual([24_500, 24_500]);
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

  test('a DEFINITIVE rate limit halts the run at once with the reason, remainder runnable', async () => {
    const h = build({
      following: [OWN_PK, '1', '2'],
      followers: [],
    });
    h.churn.outcomes.set('u1', { status: 'blocked', cause: 'rate-limited' });

    await h.engine.run();

    expect(h.churn.unfollows).toEqual(['u1']); // one refusal is enough — no park-and-retry
    expect(h.store.pruneCountSince(0)).toBe(0);
    const status = h.engine.status();
    expect(status.state).toBe('halted');
    expect(status.haltReason).toBe('rate-limited');
    expect(h.store.getPruneScan()?.remaining.map((c) => c.pk)).toEqual(['1', '2']);
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
    const followers = new FakeListSource([]);
    const store = openTestStore(':memory:');
    store.setOwnPk(OWN_PK);
    const churn = new FakePruneActions();
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
    const store = openTestStore(':memory:');
    store.setOwnPk(OWN_PK);
    const churn = new FakePruneActions();
    const engine = new PruneEngine({
      store,
      clock: new FakeClock(T0),
      ownPk: OWN_PK,
      ownFollowing: new FakeListSource(['ghost']),
      ownFollowers: new FakeListSource([]),
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

  test('a SUPERSEDED run never clobbers the generation that replaced it', async () => {
    const h = build({ following: [OWN_PK, '1', '2', '3'], followers: [] });
    await h.engine.scan();

    // Gate each generation's first unfollow separately, so the stale loop
    // unwinds WHILE the new one is still mid-action.
    const gates: Array<() => void> = [];
    const hold = (): Promise<void> =>
      new Promise<void>((resolve) => {
        gates.push(resolve);
      });
    const orig = h.churn.unfollow.bind(h.churn);
    let held = 0;
    h.churn.unfollow = async (username: string) => {
      if (held < 2) {
        held += 1;
        await hold();
      }
      return orig(username);
    };
    const pump = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };

    const stale = h.engine.run();
    await pump(); // the first run is parked inside its unfollow
    h.engine.stop();
    const current = h.engine.run(); // a NEW generation takes over
    await pump(); // …and parks inside ITS unfollow
    gates[0](); // the stale loop wakes and unwinds
    await stale;

    // The new generation is still running: the stale loop neither reset the
    // state nor handed its own remainder back over the live candidate set.
    expect(h.engine.status().state).toBe('running');

    gates[1]();
    await current;
    expect(h.engine.status().state).toBe('done');
    expect(h.engine.status().remaining).toBe(0);
    // Only the current generation stamped a completion; the stale loop's own
    // dispatched unfollow was still RECORDED as a fact (§1).
    expect(h.completedAt.length).toBe(1);
    expect(h.store.pruneCountSince(0)).toBeGreaterThanOrEqual(3);
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

// Bio words, people and verified accounts shield a prune candidate now (spec §7): see prune-protection.test.ts.

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

// --- Last complete census (durable display truth) ----------------------------------

describe('PruneEngine — last complete census', () => {
  test('a completed scan projects the census: counts, scraped basis, and timestamp', async () => {
    const h = build({
      following: [OWN_PK, '1', '2', '3', '4'],
      followers: ['2'],
    });
    // '1' is growth-managed: excluded from the prune census but still a
    // scraped non-reciprocal follow — the census must carry both figures.
    h.store.upsertFollowRecord({
      accountPk: '1',
      targetPk: null,
      state: 'pending_followback',
      retryCount: 0,
    });
    // Header counts exceed the walked lists — the gap is deactivated ghosts.
    h.store.observe({
      accountPk: OWN_PK,
      observedAt: T0,
      source: 'profile',
      fields: { following: 6, followers: 2 },
    });

    await h.engine.scan();

    const s = h.engine.status();
    expect(s.census).toEqual({
      at: T0,
      following: 6, // display = header figure (scraped + ghost buffer)
      followers: 2,
      scrapedFollowing: 5, // what the list walk actually returned
      scrapedFollowers: 1,
      notFollowingBack: 3, // '1', '3', '4' (self and the follower excluded)
      candidates: 2, // growth-managed '1' exempt; protection NOT applied
    });
    expect(s.scanAt).toBe(T0);
    // The projection carries the raw unvisited row count next to the actionable count (equal: no rule).
    expect(s.rawRemaining).toBe(2);
    expect(s.candidates).toBe(2);
    h.store.close();
  });

  test('an aborted scan retains the previous complete census — no partial counts stand', async () => {
    const h = build({ following: [OWN_PK, '1', '2'], followers: ['2'] });
    await h.engine.scan();
    const first = h.engine.status().census;
    expect(first).not.toBeNull();
    h.clock.advance(60_000);

    // Second scan: stop() lands during the followers phase, so the walk ends
    // with partial counts gathered (following walked, followers empty).
    h.ownFollowers.fetchAllPks = async (): Promise<PruneScanFetch> => {
      h.engine.stop();
      return { pks: [], complete: false, reason: 'stop-requested' };
    };
    const res = await h.engine.scan();
    expect(res.aborted).toBe(true);

    const s = h.engine.status();
    // The census the aborted scan could not replace keeps standing…
    expect(s.census).toEqual(first);
    expect(s.scanAt).toBe(first?.at);
    // …and the LIVE counts restore to it instead of the partial walk
    // (previously: following = partial, followers = 0, no timestamp).
    expect(s.following).toBe(first?.following);
    expect(s.followers).toBe(first?.followers);
    expect(s.candidates).toBe(1);
    expect(s.remaining).toBe(1);
    // The previous reviewed set is runnable again, exactly as after a restart.
    expect(s.scanReady).toBe(true);
    expect(s.state).toBe('idle');
    h.store.close();
  });

  test('a FAILED scan (incomplete walk) also retains the previous census', async () => {
    const h = build({ following: [OWN_PK, '1'], followers: [] });
    await h.engine.scan();
    const first = h.engine.status().census;
    h.clock.advance(60_000);

    h.ownFollowers.fetchAllPks = async (): Promise<PruneScanFetch> => ({
      pks: [],
      complete: false,
      reason: 'stagnated',
    });
    await expect(h.engine.scan()).rejects.toThrow(/followers walk incomplete/);

    const s = h.engine.status();
    expect(s.census).toEqual(first);
    expect(s.following).toBe(first?.following);
    expect(s.scanReady).toBe(true); // the previous reviewed set is still runnable
    h.store.close();
  });

  test('a SHAPE-MISMATCH walk is a failed scan: census restored, NO loss events, NO census record', async () => {
    const h = build({ following: [OWN_PK, '1', '2'], followers: ['2'] });
    await h.engine.scan();
    const first = h.engine.status().census;
    expect(first).not.toBeNull();
    // '2' follows us — the fact the fabricated-census bug used to destroy.
    expect(h.store.getEdge('2', OWN_PK, 'follows')?.status).toBe('active');
    h.clock.advance(60_000);

    // IG ships a list-shape change: the followers walk fetches pages it can
    // no longer parse and ends complete:false, reason 'shape-mismatch' —
    // NEVER the old laundering into a verified-complete empty walk.
    h.ownFollowers.fetchAllPks = async (): Promise<PruneScanFetch> => ({
      pks: [],
      complete: false,
      reason: 'shape-mismatch',
    });
    await expect(h.engine.scan()).rejects.toThrow(/check for an Epo update/);

    const s = h.engine.status();
    // The failed scan produced NO census record — the previous one stands…
    expect(h.store.getPruneCensus()).toEqual(first);
    expect(s.census).toEqual(first);
    expect(s.scanAt).toBe(first?.at);
    // …no follower was marked lost (the authoritative ingest never ran)…
    expect(h.store.getEdge('2', OWN_PK, 'follows')?.status).toBe('active');
    // …and the previously reviewed set is runnable again, like a relaunch.
    expect(s.scanReady).toBe(true);
    expect(s.following).toBe(first?.following);
    expect(s.followers).toBe(first?.followers);
    expect(s.state).toBe('idle');
    h.store.close();
  });

  test('a consumed run keeps the census and its timestamp; only runnability clears', async () => {
    const h = build({ following: [OWN_PK, '1', '2'], followers: [] });
    await h.engine.scan();
    const at = h.engine.status().census?.at;
    expect(at).toBe(T0);
    h.clock.advance(60_000);

    await h.engine.run();

    const s = h.engine.status();
    expect(s.state).toBe('done');
    expect(s.scanReady).toBe(false); // consumed — the next run needs a fresh scan
    expect(s.scanAt).toBe(at); // …but "when was this censused" still answers
    expect(s.census?.at).toBe(at);
    expect(s.census?.candidates).toBe(2); // the census records what the scan found
    expect(s.rawRemaining).toBe(0); // every census row was visited
    h.store.close();
  });

  test('a fresh completed scan REPLACES the census', async () => {
    const h = build({ following: [OWN_PK, '1'], followers: [] });
    await h.engine.scan();
    expect(h.engine.status().census?.at).toBe(T0);

    h.clock.advance(3_600_000);
    await h.engine.scan();
    expect(h.engine.status().census?.at).toBe(T0 + 3_600_000);
    h.store.close();
  });
});

describe('PruneEngine — woven feed (EngineUnfollowFeed)', () => {
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

  test('a candidate with its own unsettled write is passed over, kept, and offered once it settles', async () => {
    const h = build({ following: ['a', 'b'], followers: [] });
    await h.engine.scan();
    const first = h.engine.nextCandidate(h.clock.now()) as { pk: string; username: string };
    const intent = h.store.beginEffectIntent({ accountPk: first.pk, username: first.username, action: 'unfollow',
      channel: 'manual', at: h.clock.now() });
    h.store.markEffectUncertain(intent.id, h.clock.now());
    expect(h.engine.nextCandidate(h.clock.now())?.pk).not.toBe(first.pk);
    expect(h.store.getPruneScan()?.remaining.map((x) => x.pk)).toContain(first.pk);
    h.store.settleEffectIntent(intent.id, { at: h.clock.now(), result: 'cancelled' });
    expect(h.engine.nextCandidate(h.clock.now())?.pk).toBe(first.pk);
  });

  test('a rate-limited woven unfollow suspends the feed at once (candidate kept)', async () => {
    const h = build({ following: ['a', 'b', 'c'], followers: [] });
    await h.engine.scan();
    const c = h.engine.nextCandidate(h.clock.now()) as { pk: string; username: string };
    h.churn.outcomes.set(c.username, { status: 'blocked', cause: 'rate-limited' });
    expect(await h.engine.executeUnfollow(c, h.clock.now())).toBe('blocked');
    expect(h.engine.lastActionOutcome()).toMatchObject({ status: 'blocked', cause: 'rate-limited' });
    expect(h.engine.nextCandidate(h.clock.now())).toBeNull(); // suspended on the first refusal
    expect(h.store.getPruneScan()?.remaining.map((x) => x.pk)).toContain(c.pk); // not consumed
  });

  test('an already-absent woven candidate is reconciled without claiming a new mutation', async () => {
    const h = build({ following: ['a'], followers: [] });
    await h.engine.scan();
    const c = h.engine.nextCandidate(h.clock.now()) as { pk: string; username: string };
    h.churn.outcomes.set(c.username, { status: 'ok', alreadyInState: true });
    expect(await h.engine.executeUnfollow(c, h.clock.now())).toBe('ok');
    expect(h.engine.lastActionOutcome()).toMatchObject({ status: 'ok', alreadyInState: true });
    expect(h.engine.status().unfollowed).toBe(0);
    expect(h.store.pruneCountSince(0)).toBe(0);
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

// --- pause()/resume() — the unified-transport controls -----------------------------

describe('PruneEngine — pause/resume (unified transport)', () => {
  /** A sleep that parks until its abort signal fires — so a run can be caught
   *  mid-delay and driven by pause()/resume()/stop() like the real engine. */
  class HangingSleep {
    calls: number[] = [];
    aborted = 0;
    hang = false;
    sleep: SleepFn = (ms, signal) => {
      this.calls.push(ms);
      if (!this.hang || signal === undefined || signal.aborted) return Promise.resolve();
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

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const DELAY = 24_500; // the rng=0.5 sampled 73.5s gap × the prune ⅓ factor

  test('pause parks the run between unfollows; resume serves the owed remainder first', async () => {
    const hs = new HangingSleep();
    const h = build({ following: [OWN_PK, '1', '2'], followers: [], sleep: hs.sleep });
    await h.engine.scan(); // 2-step: the run consumes this census
    hs.hang = true;

    const run = h.engine.run();
    await settle();
    // Acted on u1, now parked in the inter-unfollow delay.
    expect(h.churn.unfollows).toEqual(['u1']);
    expect(hs.calls).toEqual([DELAY]);

    h.engine.pause();
    await settle();
    expect(h.engine.status().state).toBe('paused');
    // The owed deadline survives the pause (the countdown keeps pointing at
    // it) and nothing acts while parked.
    expect(h.engine.status().nextActionAt).toBe(T0 + DELAY);
    expect(h.churn.unfollows).toEqual(['u1']);

    // Resume 5s in: the remainder (19.5s) is served BEFORE u2 — resume is not
    // a way to act instantly.
    h.clock.advance(5_000);
    h.engine.resume();
    await settle();
    expect(h.engine.status().state).toBe('running');
    expect(hs.calls).toEqual([DELAY, DELAY - 5_000]);
    expect(h.churn.unfollows).toEqual(['u1']); // u2 NOT acted early

    h.engine.stop();
    await run;
    expect(h.engine.status().state).toBe('idle');
    h.store.close();
  });

  test('stop while paused lands idle and hands the remainder back as runnable', async () => {
    const hs = new HangingSleep();
    const h = build({ following: [OWN_PK, '1', '2'], followers: [], sleep: hs.sleep });
    await h.engine.scan();
    hs.hang = true;

    const run = h.engine.run();
    await settle();
    h.engine.pause();
    await settle();
    expect(h.engine.status().state).toBe('paused');

    h.engine.stop();
    await run;
    expect(h.engine.status().state).toBe('idle');
    // u2 was never visited: it stays the runnable remainder.
    expect(h.engine.status().remaining).toBe(1);
    expect(h.engine.status().scanReady).toBe(true);
    h.store.close();
  });

  test('pause outside a running run is a no-op; so is resume outside paused', () => {
    const h = build({ following: [OWN_PK, '1'], followers: [] });
    h.engine.pause();
    expect(h.engine.status().state).toBe('idle');
    h.engine.resume();
    expect(h.engine.status().state).toBe('idle');
    h.store.close();
  });

  test('the run projects its NEXT candidate as the countdown subject', async () => {
    const hs = new HangingSleep();
    const h = build({ following: [OWN_PK, '1', '2'], followers: [], sleep: hs.sleep });
    await h.engine.scan();
    hs.hang = true;

    const run = h.engine.run();
    await settle();
    // Parked between u1 (acted) and u2 — the projection names what fires NEXT.
    expect(h.engine.status().upNext).toBe('u2');
    h.engine.stop();
    await run;
    expect(h.engine.status().upNext).toBeNull();
    h.store.close();
  });
});

describe('PruneEngine — the blocked park reads the tempo (park.blocked, pace-up)', () => {
  const blockedOnce = async (tempo: ReturnType<typeof recordingTempo>) => {
    const store = kitStore();
    store.setOwnPk(OWN_PK);
    store.observe({ accountPk: '1', observedAt: T0, source: 'followers-list', fields: { username: 'u1' } });
    const churn = new FakePruneActions();
    let blocks = 1;
    churn.unfollow = async (username: string): Promise<ChurnActionOutcome> => {
      churn.unfollows.push(username);
      return blocks-- > 0 ? { status: 'blocked' } : { status: 'ok' };
    };
    const engine = new PruneEngine({ store, clock: new FakeClock(T0), ownPk: OWN_PK, ownFollowing: new FakeListSource([OWN_PK, '1']),
      ownFollowers: new FakeListSource([]), churnActions: churn, sentinel: new FakeSentinel(), cfg: CFG,
      sleep: async () => {}, rng: () => 0.5, tempo });
    await engine.run();
    return churn.unfollows;
  };

  test('the park asks the injected tempo for its base, and the retry then goes ahead', async () => {
    const tempo = recordingTempo();
    expect(await blockedOnce(tempo)).toEqual(['u1', 'u1']);
    expect(tempo.keys).toContain('park.blocked');
  });

  test('at the reference tempo the base is today\'s value (identity)', () => {
    expect(referenceTempoSource().base('park.blocked')).toBe(PRUNE.PARK_MS);
  });
});
