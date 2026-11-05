import { type LeaseGrowthEngine, TabLease } from '@/main/services/tab-lease';

/**
 * The tab-ownership state machine, exercised with no store, no tab and no
 * electron: a driver token, the "only the borrower resumes" hand-off contract,
 * and the two latches that ride with it.
 */

type State = 'idle' | 'running' | 'paused' | 'halted';

interface FakeEngine extends LeaseGrowthEngine {
  calls: string[];
  setState(next: State): void;
  /** What `awaitParked` resolves with (a wedged loop answers false). */
  parks: boolean;
  setParks(v: boolean): void;
}

function fakeEngine(state: State = 'running'): FakeEngine {
  let current = state;
  let parks = true;
  const calls: string[] = [];
  return {
    calls,
    get parks() {
      return parks;
    },
    setParks: (v) => {
      parks = v;
    },
    setState: (next) => {
      current = next;
    },
    status: () => ({ state: current }),
    pause: () => {
      calls.push('pause');
      current = 'paused';
    },
    resume: () => {
      calls.push('resume');
      current = 'running';
    },
    awaitParked: async () => {
      calls.push('awaitParked');
      return parks;
    },
  };
}

describe('driver token', () => {
  test('starts free, claims, and only the holder may release it', () => {
    const lease = new TabLease();
    expect(lease.owner()).toBeNull();

    lease.claim('growth');
    expect(lease.owner()).toBe('growth');

    // A stale prune settling must never free a live growth run's token.
    lease.release('prune');
    expect(lease.owner()).toBe('growth');

    lease.release('growth');
    expect(lease.owner()).toBeNull();
  });
});

describe('growth hand-off', () => {
  test('a running loop is paused, awaited, and resumed by the SAME borrower', async () => {
    const lease = new TabLease();
    const engine = fakeEngine('running');

    expect(await lease.borrowFromGrowth('prune', engine, 100)).toBe(true);
    expect(engine.calls).toEqual(['pause', 'awaitParked']);
    expect(engine.status().state).toBe('paused');

    lease.returnToGrowth('prune', engine);
    expect(engine.status().state).toBe('running');
  });

  test("a USER's pause is waited out but never undone", async () => {
    const lease = new TabLease();
    const engine = fakeEngine('paused'); // the user paused it

    expect(await lease.borrowFromGrowth('prune', engine, 100)).toBe(true);
    // Quiescence is still proven, but nothing was paused BY us…
    expect(engine.calls).toEqual(['awaitParked']);

    lease.returnToGrowth('prune', engine);
    // …so the return is a no-op: the engine stays paused.
    expect(engine.calls).toEqual(['awaitParked']);
    expect(engine.status().state).toBe('paused');
  });

  test('an idle or halted loop leaves the tab free — no pause, no park wait', async () => {
    for (const state of ['idle', 'halted'] as const) {
      const lease = new TabLease();
      const engine = fakeEngine(state);
      expect(await lease.borrowFromGrowth('prune', engine, 100)).toBe(true);
      expect(engine.calls).toEqual([]);
    }
  });

  test('a loop that will not park aborts the hand-off AND undoes our pause', async () => {
    const lease = new TabLease();
    const engine = fakeEngine('running');
    engine.setParks(false);

    expect(await lease.borrowFromGrowth('prune', engine, 100)).toBe(false);
    expect(engine.calls).toEqual(['pause', 'awaitParked', 'resume']);
    expect(engine.status().state).toBe('running');
  });

  test('returnToGrowth is idempotent — the abort path and the finally both call it', async () => {
    const lease = new TabLease();
    const engine = fakeEngine('running');
    await lease.borrowFromGrowth('prune', engine, 100);

    lease.returnToGrowth('prune', engine);
    lease.returnToGrowth('prune', engine);
    expect(engine.calls.filter((c) => c === 'resume')).toHaveLength(1);
  });

  test('borrowers are independent: the tour resuming does not settle a prune debt', () => {
    const lease = new TabLease();
    const engine = fakeEngine('running');

    lease.pauseGrowthFor('prune', engine);
    lease.returnToGrowth('tour', engine); // the tour owes nothing
    expect(engine.status().state).toBe('paused');

    lease.returnToGrowth('prune', engine);
    expect(engine.status().state).toBe('running');
  });

  test('a torn-down graph resumes nothing, and the debt is dropped', () => {
    const lease = new TabLease();
    const engine = fakeEngine('running');
    lease.pauseGrowthFor('prune', engine);

    lease.forgetHandoffs();
    lease.returnToGrowth('prune', engine);
    expect(engine.calls.filter((c) => c === 'resume')).toHaveLength(0);
  });

  test('the tour hold pauses without waiting for the pause gate', () => {
    const lease = new TabLease();
    const engine = fakeEngine('running');
    lease.pauseGrowthFor('tour', engine);
    expect(engine.calls).toEqual(['pause']);
  });
});

describe('tour hold + latches', () => {
  test('setTourHeld reports only real transitions', () => {
    const lease = new TabLease();
    expect(lease.tourHeld()).toBe(false);
    expect(lease.setTourHeld(true)).toBe(true);
    expect(lease.setTourHeld(true)).toBe(false); // repeat engage: no-op
    expect(lease.tourHeld()).toBe(true);
    expect(lease.setTourHeld(false)).toBe(true);
    expect(lease.setTourHeld(false)).toBe(false);
  });

  test('only a real release notifies the tour listeners, until they unsubscribe', () => {
    const lease = new TabLease();
    const released = jest.fn();
    const off = lease.onTourReleased(released);
    lease.setTourHeld(false); // not held: no transition
    lease.setTourHeld(true);
    expect(released).not.toHaveBeenCalled();
    lease.setTourHeld(false);
    expect(released).toHaveBeenCalledTimes(1);
    off();
    lease.setTourHeld(true);
    lease.setTourHeld(false);
    expect(released).toHaveBeenCalledTimes(1);
  });

  test('the startup sequence holds the tab like any driver, and a stale release never frees it', () => {
    const lease = new TabLease();
    const generation = lease.claim('startup');
    expect(lease.owner()).toBe('startup');
    lease.claim('growth'); // resume-run starts growth under the startup lease
    lease.release('startup', generation);
    expect(lease.owner()).toBe('growth');
  });

  test('the growth spin-up bridge arms once and retires once', () => {
    const lease = new TabLease();
    expect(lease.endGrowthStart()).toBe(false); // nothing armed
    expect(lease.beginGrowthStart()).toBe(true);
    expect(lease.beginGrowthStart()).toBe(false); // already armed — no second hold
    expect(lease.endGrowthStart()).toBe(true);
    expect(lease.endGrowthStart()).toBe(false);
  });
});
