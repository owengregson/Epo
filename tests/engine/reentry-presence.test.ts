/**
 * Live 2026-11-02 ("it didn't do anything all day"). The engine's own overnight
 * session park counted as an ABSENCE. The resume then re-ran the return check
 * as a full census, one profile visit for each of the 55 managed records, and
 * reset return probation. Two censuses spent the day's 80-visit allowance before
 * a single follow.
 *
 * Pinned here:
 *  - a hold the engine chose is presence;
 *  - a return re-reads only the obligations its timers made due;
 *  - a full census is owed only when the timers themselves cannot be trusted.
 */
import { ReentrySupervisor } from '@/engine/reentry';
import { FakeClock } from '@/governors/clock';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { makeEngineHarness } from '../kit/engine-harness';
import { FakePlan } from '../kit/harness-plan';
import { openTestStore } from '../kit/store';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 10, 2, 10);
let store: KnowledgeStore;
let clock: FakeClock;
beforeEach(() => {
  setLevel('error');
  store = openTestStore(':memory:');
  store.setOwnPk('me');
  clock = new FakeClock(START);
});
afterEach(() => store.close());

/** A supervisor with nothing owed, present right now. */
const settled = (): ReentrySupervisor => {
  const s = new ReentrySupervisor({ store, clock });
  s.prepare();
  s.noteProgress(clock.now());
  return s;
};

describe('a hold the engine chose is presence, not absence', () => {
  test('an overnight session park ends without a return check', () => {
    const s = settled();
    s.holdUntil(clock.now() + 12 * HOUR);
    clock.advance(12 * HOUR);
    s.endHold(clock.now());
    expect(s.requiresReconciliation(clock.now())).toBe(false);
    expect(s.snapshot().phase).toBe('ready');
  });

  test('a command that arrives during the hold sees the engine present', () => {
    const s = settled();
    s.holdUntil(clock.now() + 12 * HOUR);
    clock.advance(6 * HOUR);
    expect(s.requiresReconciliation(clock.now())).toBe(false);
  });

  test('the breaks between sessions never restart a return probation', () => {
    const s = settled();
    clock.advance(7 * DAY);
    s.prepare();
    s.noteReconciled({ outcome: 'complete' }, clock.now());
    s.noteAction(clock.now());
    s.holdUntil(clock.now() + 3 * HOUR);
    clock.advance(3 * HOUR);
    s.endHold(clock.now());
    expect(s.requiresReconciliation(clock.now())).toBe(false);
    expect(s.snapshot()).toMatchObject({ phase: 'probation', probationActions: 1 });
  });

  test('time slept PAST the deadline still counts as away', () => {
    const s = settled();
    s.holdUntil(clock.now() + 30 * 60_000);
    clock.advance(30 * 60_000 + 2 * HOUR);
    s.endHold(clock.now());
    expect(s.requiresReconciliation(clock.now())).toBe(true);
    expect(s.snapshot()).toMatchObject({ reason: 'absence', absentMs: 2 * HOUR });
  });

  test('a hold interrupted by a stop is presence only until the stop', () => {
    const s = settled();
    s.holdUntil(clock.now() + 12 * HOUR);
    clock.advance(HOUR);
    s.endHold(clock.now());
    clock.advance(2 * HOUR);
    expect(s.requiresReconciliation(clock.now())).toBe(true);
  });

  test('a restart mid-hold cannot claim the time the app was closed', () => {
    const s = settled();
    s.holdUntil(clock.now() + 12 * HOUR);
    clock.advance(12 * HOUR);
    expect(new ReentrySupervisor({ store, clock }).prepare()).toMatchObject({ phase: 'reconcile', reason: 'absence' });
  });
});

describe('the engine notes its own holds', () => {
  test('a six-hour session park ends with the engine present: no return check', async () => {
    const startAt = new Date(2026, 10, 3, 2).getTime();
    const pacing = new FakePlan(startAt + 6 * HOUR + 1);
    pacing.open = false;
    const h = makeEngineHarness({
      startAt,
      pacing,
      reentry: (d) => {
        const s = new ReentrySupervisor(d);
        s.prepare();
        return s;
      },
    });

    expect(await h.engine.stepOnce()).toBe('waited-session');

    expect(h.sleep.calls[0]).toBeGreaterThan(6 * HOUR);
    expect(h.reentry?.requiresReconciliation(h.clock.now())).toBe(false);
  });

  test('a hold cut short by a stop leaves the engine present only until the stop', async () => {
    const startAt = new Date(2026, 10, 3, 2).getTime();
    const pacing = new FakePlan(startAt + 6 * HOUR);
    pacing.open = false;
    const h = makeEngineHarness({
      startAt,
      pacing,
      reentry: (d) => {
        const s = new ReentrySupervisor(d);
        s.prepare();
        return s;
      },
    });
    h.sleep.hang = true;
    const step = h.engine.stepOnce();
    await new Promise((r) => setTimeout(r, 0));
    h.engine.stop();
    await step;
    h.clock.advance(2 * HOUR);

    expect(h.reentry?.requiresReconciliation(h.clock.now())).toBe(true);
  });
});

describe('a census is owed only when the timers cannot be trusted', () => {
  test('an absence owes reconciliation, not a census', () => {
    const s = settled();
    clock.advance(7 * DAY);
    expect(s.requiresReconciliation(clock.now())).toBe(true);
    expect(s.requiresCensus(clock.now())).toBe(false);
  });

  test('a clock change owes a census', () => {
    const s = settled();
    clock.advance(-DAY);
    expect(s.requiresCensus(clock.now())).toBe(true);
  });

  test('history from before the journal owes a census', () => {
    store.upsertFollowRecord({ accountPk: 'a', targetPk: null, state: 'pending_followback', followedAt: START, retryCount: 0 });
    const s = new ReentrySupervisor({ store, clock });
    expect(s.prepare().reason).toBe('legacy-state');
    expect(s.requiresCensus(clock.now())).toBe(true);
  });

  test('a later absence cannot downgrade a census still owed', () => {
    const s = settled();
    clock.advance(-DAY);
    expect(s.requiresCensus(clock.now())).toBe(true);
    clock.advance(3 * HOUR);
    expect(s.requiresCensus(clock.now())).toBe(true);
    expect(s.snapshot().reason).toBe('clock-change');
  });
});
