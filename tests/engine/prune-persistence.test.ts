/**
 * Prune persistence across restarts: a completed scan's census + reviewed
 * candidate set survive in the store, and a NEW PruneEngine over the same store
 * (the restart) rehydrates them — counts restored, remaining candidates
 * runnable while fresh, everything gone when the whitelist changes. Restart is
 * simulated by constructing a second engine over the same `:memory:` store.
 */
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import {
  PruneEngine,
  PRUNE_SCAN_FRESH_MS,
  type PruneConfig,
  type PruneEngineDeps,
  type PruneScanFetch,
} from '@/engine/prune-engine';
import type { ChurnActionOutcome } from '@/engine/churn-scheduler';
import type { SentinelStatus } from '@/adapter/sentinel';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const T0 = Date.parse('2026-08-12T12:00:00'); // local noon
const OWN_PK = 'ME';

const CFG: PruneConfig = {
  dailyLimit: 50,
  whitelist: [],
  minDelayMs: 60_000,
  maxDelayMs: 60_000,
  jitterPercent: 0,
  scanMinMs: 1_000,
  scanMaxMs: 3_000,
};

class FakeListSource {
  constructor(private readonly pks: string[]) {}
  async fetchAllPks(): Promise<PruneScanFetch> {
    return { pks: [...this.pks], complete: true, reason: 'no-more-pages' };
  }
}

class FakeChurnActions {
  unfollows: string[] = [];
  async unfollow(username: string): Promise<ChurnActionOutcome> {
    this.unfollows.push(username);
    return { status: 'ok' };
  }
}

interface World {
  store: KnowledgeStore;
  clock: FakeClock;
  churn: FakeChurnActions;
  /** Construct a PruneEngine over the SAME store/clock — a fresh one models a restart. */
  boot: (over?: Partial<PruneEngineDeps>) => PruneEngine;
}

const world = (following: string[], followers: string[]): World => {
  const store = new KnowledgeStore(':memory:');
  store.setOwnPk(OWN_PK);
  const clock = new FakeClock(T0);
  const churn = new FakeChurnActions();
  // Give every non-self pk a stored username (u<pk>), as the live sources do.
  for (const pk of following) {
    if (pk === OWN_PK) continue;
    store.observe({
      accountPk: pk,
      observedAt: T0,
      source: 'followers-list',
      fields: { username: `u${pk}` },
    });
  }
  const boot = (over?: Partial<PruneEngineDeps>): PruneEngine =>
    new PruneEngine({
      store,
      clock,
      ownPk: OWN_PK,
      ownFollowing: new FakeListSource(following),
      ownFollowers: new FakeListSource(followers),
      churnActions: churn,
      sentinel: { check: async (): Promise<SentinelStatus> => 'ok' },
      cfg: CFG,
      sleep: async () => {},
      rng: () => 0.5,
      ...over,
    });
  return { store, clock, churn, boot };
};

describe('PruneEngine persistence across restarts', () => {
  test('a fresh engine over an empty store starts at zeros (no snapshot)', () => {
    const w = world(['1'], []);
    const s = w.boot().status();
    expect(s.following).toBe(0);
    expect(s.candidates).toBe(0);
    expect(s.scanReady).toBe(false);
    w.store.close();
  });

  test('a completed scan survives a restart: counts restored, scan still runnable', async () => {
    const w = world([OWN_PK, '1', '2', '3'], ['3']);
    await w.boot().scan();

    const restarted = w.boot(); // the "restart"
    const s = restarted.status();
    expect(s.following).toBe(4);
    expect(s.followers).toBe(1);
    expect(s.candidates).toBe(2); // '1' and '2'
    expect(s.remaining).toBe(2);
    expect(s.scanReady).toBe(true); // fresh → the 2-step Run stays unlocked
    expect(s.state).toBe('idle'); // data restored, nothing auto-acts

    // The restored reviewed set is consumed verbatim by a run — no re-scan.
    await restarted.run();
    expect(w.churn.unfollows).toEqual(['u1', 'u2']);
    w.store.close();
  });

  test('a stale snapshot restores the counts but locks Run (freshness expired)', async () => {
    const w = world([OWN_PK, '1'], []);
    await w.boot().scan();
    w.clock.advance(PRUNE_SCAN_FRESH_MS + 1);

    const s = w.boot().status();
    expect(s.candidates).toBe(1);
    expect(s.remaining).toBe(1);
    expect(s.scanReady).toBe(false);
    w.store.close();
  });

  test('quitting mid-run leaves exactly the unvisited remainder', async () => {
    const w = world([OWN_PK, '1', '2', '3'], []);
    const first = w.boot();
    await first.scan();
    // Stop the run after the first unfollow's delay begins — sleep interrupts it.
    let stopper!: PruneEngine;
    stopper = w.boot({ sleep: async () => stopper.stop() });
    await stopper.run();
    expect(w.churn.unfollows).toEqual(['u1']); // exactly one visited

    const restarted = w.boot();
    const s = restarted.status();
    expect(s.candidates).toBe(2); // counts reflect what is actionable NOW
    expect(s.remaining).toBe(2); // '2' and '3' are still to visit
    expect(s.scanReady).toBe(true);
    await restarted.run();
    expect(w.churn.unfollows).toEqual(['u1', 'u2', 'u3']); // continues, no repeat of '1'
    w.store.close();
  });

  test('a completed run leaves nothing to prune and no runnable set', async () => {
    const w = world([OWN_PK, '1'], []);
    const e = w.boot();
    await e.scan();
    await e.run();

    const s = w.boot().status();
    expect(s.following).toBe(2);
    // Every candidate was visited: showing the pre-run census figure here was
    // the stale "N to prune after restart" bug.
    expect(s.candidates).toBe(0);
    expect(s.remaining).toBe(0);
    expect(s.scanReady).toBe(false);
    w.store.close();
  });

  test('coverage guard: a grossly truncated followers scrape fails the scan loud', async () => {
    // The profile header (observed into the store during the scan) knows ~3200
    // followers; the scrape yielded 38. Yielding candidates from that census
    // would unfollow thousands of real followers — the scan must throw instead.
    const followerPks = Array.from({ length: 38 }, (_, i) => `f${i}`);
    const w = world([OWN_PK, '1', '2'], followerPks);
    w.store.observe({
      accountPk: OWN_PK,
      observedAt: T0,
      source: 'profile',
      fields: { followers: 3200, following: 2 },
    });

    await expect(w.boot().scan()).rejects.toThrow(/followers scan incomplete/);
    // Nothing runnable was persisted from the failed scan.
    expect(w.store.getPruneScan()).toBeNull();
    w.store.close();
  });

  test('coverage guard: ghost-follower drift within the margin still passes', async () => {
    // Header says 100, the list walk found 96 — normal drift, not truncation.
    const followerPks = Array.from({ length: 96 }, (_, i) => `f${i}`);
    const w = world([OWN_PK, '1'], followerPks);
    w.store.observe({
      accountPk: OWN_PK,
      observedAt: T0,
      source: 'profile',
      fields: { followers: 100, following: 1 },
    });

    const result = await w.boot().scan();
    // GHOST BUFFER: the DISPLAYED census matches Instagram's header number
    // (96 scraped + 4 deactivated ghosts = 100), never the raw list size.
    expect(result.followers).toBe(100);
    w.store.close();
  });

  test('ghost buffer: displayed counts persist Instagram-matching numbers in the snapshot', async () => {
    const followerPks = Array.from({ length: 96 }, (_, i) => `f${i}`);
    const w = world([OWN_PK, '1'], followerPks);
    w.store.observe({
      accountPk: OWN_PK,
      observedAt: T0,
      source: 'profile',
      fields: { followers: 100, following: 2 },
    });

    await w.boot().scan();
    const snap = w.store.getPruneScan()!;
    expect(snap.followers).toBe(100); // header-matching, restored on relaunch
    expect(snap.following).toBe(2); // header 2, scraped 1 (+1 ghost)
    w.store.close();
  });

  test('a whitelist change re-derives the counts and keeps the snapshot (no re-scan)', async () => {
    const w = world([OWN_PK, '1', '2'], []);
    const e = w.boot();
    await e.scan();
    expect(e.status().candidates).toBe(2);

    // Adding to the whitelist hides that candidate live; the RAW snapshot stays.
    e.applyConfig({ ...CFG, whitelist: ['u1'] });
    expect(e.status().candidates).toBe(1);
    expect(e.status().scanReady).toBe(true);
    expect(w.store.getPruneScan()).not.toBeNull();

    // Removing them restores the candidate — still without another scan.
    e.applyConfig({ ...CFG, whitelist: [] });
    expect(e.status().candidates).toBe(2);
    w.store.close();
  });

  test('a restart derives the restored counts against the CURRENT whitelist', async () => {
    // Scan with an empty whitelist, then restart an engine whose settings now
    // whitelist one of the two candidates: the raw persisted census re-derives.
    const w = world([OWN_PK, '1', '2'], []);
    await w.boot().scan();

    const restarted = w.boot({ cfg: { ...CFG, whitelist: ['u1'] } });
    expect(restarted.status().remaining).toBe(1);
    expect(restarted.status().scanReady).toBe(true);
    await restarted.run();
    expect(w.churn.unfollows).toEqual(['u2']); // u1 stayed protected
    w.store.close();
  });
});
