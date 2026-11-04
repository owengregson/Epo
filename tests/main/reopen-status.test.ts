/**
 * The reopen wiring's parts (spec §9.6, §9.11, §15.3): the catch-up startup step with its admission inputs, the
 * five status contributors read from the store, and the one-time legacy seed of the reopen state.
 */
import type { FrontierSweep } from '@/engine/frontier-sweep';
import { FakeClock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { CatchUpLaunch } from '@/main/modules/catch-up';
import { journalView, ownCounts, reopenContributors, requestsView } from '@/main/services/reopen-status';
import { reopenWiringParts, seedReopenState } from '@/main/services/reopen-wiring';
import type { CatchUpView } from '@/shared/reopen-view';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { openTestStore } from '../kit/store';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 12);
let store: KnowledgeStore;
let clock: FakeClock;
beforeEach(() => {
  setLevel('error');
  store = openTestStore(':memory:');
  store.setOwnPk('me');
  clock = new FakeClock(NOW);
});
afterEach(() => store.close());

const dayClock = () => calendarPlanDayClock({ now: () => clock.now() });
const VIEW = { state: 'idle' } as unknown as CatchUpView;

function parts(o: { launch?: Partial<CatchUpLaunch>; sentinel?: string; recovery?: { phase: 'holding' | 'probing'; resumeAt: number | null } | null } = {}) {
  const sweep = { view: () => VIEW, run: jest.fn(async () => undefined), skip: jest.fn() };
  const launch: CatchUpLaunch | undefined = o.launch === undefined ? undefined : {
    signedInPk: async () => 'me', online: () => true, block: () => null, tabFree: () => true, land: async () => {},
    hold: (run) => run(), ...o.launch };
  const p = reopenWiringParts({ launch }, {
    sweep: sweep as unknown as FrontierSweep, ownPk: 'me', clock,
    sentinel: { check: async () => (o.sentinel ?? 'ok') as never },
    engine: { status: () => ({ recovery: o.recovery ?? null }) as never },
    contributors: { store, sweep, dayClock: dayClock(), followingResidual: () => 0 },
  });
  return { p, sweep };
}

describe('the catch-up startup step', () => {
  test('a launch port gives one catch-up step; without one there is none', () => {
    expect(parts({ launch: {} }).p.startupSteps.map((s) => s.name)).toEqual(['catch-up']);
    expect(parts().p.startupSteps).toEqual([]);
  });

  test('the cookie, the sentinel, the ladder and the block decide the admission', async () => {
    const cases: Array<[Parameters<typeof parts>[0], 'run' | string]> = [
      [{ launch: {} }, 'run'],
      [{ launch: { block: () => 'chain-exhausted' } }, 'run'],
      [{ launch: { signedInPk: async () => null } }, 'signed-out'],
      [{ launch: { signedInPk: async () => 'someone-else' } }, 'account-changed'],
      [{ launch: { online: () => false } }, 'offline'],
      [{ launch: {}, sentinel: 'action-blocked' }, 'wall'],
      [{ launch: {}, recovery: { phase: 'holding', resumeAt: NOW + HOUR } }, 'holding'],
      [{ launch: {}, recovery: { phase: 'holding', resumeAt: NOW - HOUR } }, 'run'],
      [{ launch: { block: () => 'login-required' } }, 'signed-out'],
    ];
    for (const [o, expected] of cases) {
      const { p, sweep } = parts(o);
      await p.startupSteps[0]?.run(new AbortController().signal);
      if (expected === 'run') expect(sweep.run).toHaveBeenCalledWith('launch', expect.anything());
      else expect(sweep.skip).toHaveBeenCalledWith(expected);
    }
  });

  test('a busy tab keeps the step from running', () => {
    expect(parts({ launch: { tabFree: () => false } }).p.startupSteps[0]?.when()).toBe(false);
  });
});

describe('the reopen status contributors', () => {
  const header = (at: number, followers: number, following: number) =>
    store.observe({ accountPk: 'me', observedAt: at, source: 'profile', fields: { username: 'me', followers, following } });

  test('the five fields, by name', () => {
    expect(parts({ launch: {} }).p.statusContributors.map((c) => c.name)).toEqual(['catchUp', 'own', 'today', 'journal', 'requests']);
  });

  test('own counts: the newest header, what was seen since it, and the unverified outside change', () => {
    expect(ownCounts({ store, sweep: { view: () => VIEW }, dayClock: dayClock(), followingResidual: () => 0 })).toBeNull();
    header(NOW - HOUR, 100, 50);
    store.ensureFollowersBaseline(NOW - 10 * HOUR);
    store.observeEdge('x', 'me', 'follows', true, NOW - 1_000, { source: 'feed', lo: NOW - 1_000 });
    const view = ownCounts({ store, sweep: { view: () => VIEW }, dayClock: dayClock(), followingResidual: (since) => (since === null ? 4 : 0) });
    expect(view).toEqual({ followers: { count: 100, at: NOW - HOUR, seenSince: { gained: 1, lost: 0 } },
      following: { count: 50, at: NOW - HOUR }, followingUnverified: 4 });
  });

  test('the journal counts due and parked intents; the requests view is the last reading', () => {
    const due = store.beginEffectIntent({ accountPk: 'a', username: 'a', action: 'follow', channel: 'growth', at: NOW - HOUR });
    store.markEffectUncertain(due.id, NOW - HOUR);
    const parked = store.beginEffectIntent({ accountPk: 'b', username: 'b', action: 'follow', channel: 'growth', at: NOW - HOUR });
    store.markEffectUncertain(parked.id, NOW - HOUR);
    store.effectIntents.park(parked.id, { attempts: 1, nextAttemptAt: NOW + HOUR }, null);
    store.beginEffectIntent({ accountPk: 'c', username: 'c', action: 'follow', channel: 'growth', at: NOW });
    expect(journalView(store, NOW)).toEqual({ pending: 1, parked: 1, nextAttemptAt: NOW + HOUR });
    expect(requestsView(store)).toBeNull();
    store.reopen.set({ v: 1, feed: null, head: null, lastSweep: null, lastCatchUp: null, following: null,
      requests: { observedAt: NOW, count: 2, complete: false, verifiedDayKey: null } });
    expect(requestsView(store)).toEqual({ count: 2, complete: false, observedAt: NOW });
  });

  test('today reads the placed tallies of the plan-day window', () => {
    const c = reopenContributors({ store, sweep: { view: () => VIEW }, dayClock: dayClock(), followingResidual: () => 0 });
    const today = c.find((x) => x.name === 'today')?.contribute(null, NOW);
    expect(today?.today).toMatchObject({ startsAt: dayClock().window(NOW).startsAt, net: 0 });
  });
});

describe('the legacy seed (spec §9.11)', () => {
  const bk = (stamp: { forPk: string | null; sweepLastRunAt: number | null } | null) => {
    const consume = jest.fn();
    return { take: () => stamp, consume };
  };

  test('this account\'s carried stamp seeds the last sweep, and the settings drop it', () => {
    const b = bk({ forPk: 'me', sweepLastRunAt: NOW - 5 * 24 * HOUR });
    seedReopenState(store, 'me', b);
    expect(store.reopen.get()?.lastSweep).toMatchObject({ endedAt: NOW - 5 * 24 * HOUR });
    expect(b.consume).toHaveBeenCalledTimes(1);
  });

  test('another account\'s stamp is left for it; the legacy lifecycle row still seeds', () => {
    store.setLifecycleState(JSON.stringify({ v: 1, phase: 'ready', lastActiveAt: NOW - 2 * HOUR }));
    const b = bk({ forPk: 'other', sweepLastRunAt: NOW - HOUR });
    seedReopenState(store, 'me', b);
    expect(store.reopen.get()?.lastSweep).toMatchObject({ endedAt: NOW - 2 * HOUR });
    expect(store.getLifecycleState()).toBeNull();
    expect(b.consume).not.toHaveBeenCalled();
  });

  test('nothing carried, nothing seeded: the first sweep starts from the baseline', () => {
    seedReopenState(store, 'me', undefined);
    expect(store.reopen.get()).toBeNull();
  });
});
