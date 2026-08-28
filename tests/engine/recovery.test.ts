/**
 * RecoverySupervisor unit tests — the pure ladder state machine: entry
 * thresholds, hold-draw bounds, durable persistence (relaunch mid-hold /
 * after-deadline), exhaustion, drift confirmation, and the success reset.
 * Fake clock, in-memory store slice, seeded rng — no timers, no browser.
 */
import { FakeClock } from '@/governors/clock';
import { RecoverySupervisor, type RecoveryStateStore } from '@/engine/recovery';
import { ACTIONS_FAILING_HALT } from '@/engine/engine';
import { RECOVERY } from '@/timing/config';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const T0 = Date.parse('2026-08-12T12:00:00');

/** Minimal in-memory recovery-state store (the KnowledgeStore meta slice). */
class MemStore implements RecoveryStateStore {
  raw: string | null = null;
  getRecoveryState(): string | null {
    return this.raw;
  }
  setRecoveryState(raw: string | null): void {
    this.raw = raw;
  }
}

/** A tiny deterministic LCG so draw-bound sweeps are reproducible. */
const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};

const make = (opts: { store?: MemStore; rng?: () => number } = {}) => {
  const store = opts.store ?? new MemStore();
  const clock = new FakeClock(T0);
  const sup = new RecoverySupervisor({ clock, store, rng: opts.rng ?? lcg(42) });
  return { store, clock, sup };
};

describe('entry thresholds', () => {
  test('the cold threshold applies while inactive; REENTRY_FAILS applies while probing', () => {
    const { sup } = make();
    expect(sup.failingEntryThreshold(ACTIONS_FAILING_HALT)).toBe(ACTIONS_FAILING_HALT);

    sup.beginHold(T0);
    // Holding still uses the cold threshold (the hold is being served anyway).
    expect(sup.failingEntryThreshold(ACTIONS_FAILING_HALT)).toBe(ACTIONS_FAILING_HALT);

    sup.completeHold();
    expect(sup.phase()).toBe('probing');
    expect(sup.failingEntryThreshold(ACTIONS_FAILING_HALT)).toBe(RECOVERY.REENTRY_FAILS);
  });
});

describe('hold draws', () => {
  test('every rung draws within [MIN_FACTOR, MAX_FACTOR] × its median', () => {
    for (let rung = 1; rung <= RECOVERY.MAX_HOLDS; rung += 1) {
      const median = RECOVERY.HOLD_MEDIANS_MS[rung - 1];
      const rng = lcg(rung * 7919); // one stream shared across the sweep
      for (let draw = 0; draw < 200; draw += 1) {
        const { sup, clock } = make({ rng });
        // Advance a fresh ladder to the rung under test, then draw once.
        for (let i = 1; i < rung; i += 1) {
          sup.beginHold(clock.now());
          sup.completeHold();
        }
        const hold = sup.beginHold(clock.now());
        expect(hold).not.toBeNull();
        expect(hold!.attempt).toBe(rung);
        expect(hold!.holdMs).toBeGreaterThanOrEqual(RECOVERY.HOLD_MIN_FACTOR * median);
        expect(hold!.holdMs).toBeLessThanOrEqual(RECOVERY.HOLD_MAX_FACTOR * median);
      }
    }
  });

  test('the medians escalate across rungs (60/90/120 min)', () => {
    expect(RECOVERY.HOLD_MEDIANS_MS).toEqual([3_600_000, 5_400_000, 7_200_000]);
  });
});

describe('persistence round-trip (§3)', () => {
  test('a mid-hold snapshot rehydrates with the REMAINDER of the absolute deadline', () => {
    const store = new MemStore();
    const { sup, clock } = make({ store });
    const hold = sup.beginHold(clock.now())!;
    expect(store.raw).not.toBeNull();

    // "Relaunch" 10 minutes later: a fresh supervisor over the same store.
    const later = new FakeClock(T0 + 10 * 60_000);
    const sup2 = new RecoverySupervisor({ clock: later, store, rng: lcg(1) });
    expect(sup2.phase()).toBe('holding');
    expect(sup2.attemptNow()).toBe(1);
    expect(sup2.holdRemainingMs(later.now())).toBe(hold.holdMs - 10 * 60_000);
  });

  test('a relaunch AFTER the deadline reports zero remainder (probes immediately)', () => {
    const store = new MemStore();
    const { sup, clock } = make({ store });
    const hold = sup.beginHold(clock.now())!;

    const later = new FakeClock(T0 + hold.holdMs + 1);
    const sup2 = new RecoverySupervisor({ clock: later, store, rng: lcg(1) });
    expect(sup2.phase()).toBe('holding');
    expect(sup2.holdRemainingMs(later.now())).toBe(0);
    sup2.completeHold();
    expect(sup2.phase()).toBe('probing');
  });

  test('probing and exhausted phases round-trip; the tally survives', () => {
    const store = new MemStore();
    const { sup, clock } = make({ store });
    sup.noteOutcome('rate-limited'); // inactive: in-memory only
    sup.beginHold(clock.now());
    sup.noteOutcome('drift'); // live: persisted
    sup.completeHold();

    const sup2 = new RecoverySupervisor({ clock, store, rng: lcg(1) });
    expect(sup2.phase()).toBe('probing');
    expect(sup2.tally().drift).toBe(1);
  });

  test('bad persisted JSON hydrates to inactive (never a crash, never a fabricated hold)', () => {
    const store = new MemStore();
    store.raw = '{not json';
    const { sup } = make({ store });
    expect(sup.phase()).toBe('inactive');
  });
});

describe('exhaustion and reset', () => {
  test('after MAX_HOLDS rungs, beginHold returns null and latches exhausted', () => {
    const { sup, clock } = make();
    for (let rung = 1; rung <= RECOVERY.MAX_HOLDS; rung += 1) {
      expect(sup.beginHold(clock.now())).not.toBeNull();
      sup.completeHold();
    }
    expect(sup.beginHold(clock.now())).toBeNull();
    expect(sup.phase()).toBe('exhausted');
  });

  test('noteRecovered clears the ladder AND the persisted state', () => {
    const store = new MemStore();
    const { sup, clock } = make({ store });
    sup.beginHold(clock.now());
    sup.completeHold();
    expect(store.raw).not.toBeNull();

    sup.noteRecovered();
    expect(sup.phase()).toBe('inactive');
    expect(sup.attemptNow()).toBe(0);
    expect(store.raw).toBeNull();
  });

  test('reset (user ack) clears an exhausted ladder', () => {
    const store = new MemStore();
    const { sup, clock } = make({ store });
    for (let rung = 1; rung <= RECOVERY.MAX_HOLDS; rung += 1) {
      sup.beginHold(clock.now());
      sup.completeHold();
    }
    sup.beginHold(clock.now()); // → exhausted
    expect(store.raw).not.toBeNull();

    sup.reset();
    expect(sup.phase()).toBe('inactive');
    expect(store.raw).toBeNull();
  });
});

describe('drift confirmation (owner directive: ambiguity → rate-limited)', () => {
  test('one drift window never confirms — the first response is always a hold', () => {
    const { sup } = make();
    sup.noteOutcome('drift');
    expect(sup.driftConfirmed()).toBe(false); // no hold served yet
  });

  test('two drift windows before any hold still do not confirm', () => {
    const { sup } = make();
    sup.noteOutcome('drift');
    sup.noteOutcome('drift');
    expect(sup.driftConfirmed()).toBe(false); // attempt 0: hold first
  });

  test('two drift windows WITH a served hold confirm the drift terminal', () => {
    const { sup, clock } = make();
    sup.noteOutcome('drift');
    sup.beginHold(clock.now());
    sup.completeHold();
    sup.noteOutcome('drift');
    expect(sup.driftConfirmed()).toBe(true);
  });

  test('rate-limited windows never confirm drift regardless of count', () => {
    const { sup, clock } = make();
    sup.noteOutcome('rate-limited');
    sup.beginHold(clock.now());
    sup.completeHold();
    sup.noteOutcome('rate-limited');
    sup.noteOutcome('rate-limited');
    expect(sup.driftConfirmed()).toBe(false);
  });
});

describe('diagnosing transitions', () => {
  test('beginDiagnosis/abortDiagnosis restore the prior phase (no rung consumed)', () => {
    const { sup, clock } = make();
    sup.beginDiagnosis();
    expect(sup.phase()).toBe('diagnosing');
    sup.abortDiagnosis();
    expect(sup.phase()).toBe('inactive');

    sup.beginHold(clock.now());
    sup.completeHold();
    sup.beginDiagnosis();
    expect(sup.phase()).toBe('diagnosing');
    sup.abortDiagnosis();
    expect(sup.phase()).toBe('probing');
    expect(sup.attemptNow()).toBe(1);
  });
});
