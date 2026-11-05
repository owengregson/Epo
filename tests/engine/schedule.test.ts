/**
 * `Schedule` as data: the recovery ladder written down as a value reproduces
 * exactly what `RecoverySupervisor.nextHoldMs` draws — same medians, same
 * spread, same clamp band, same rung count.
 */

import fc from 'fast-check';

import { RecoverySupervisor } from '@/engine/recovery';
import {
  attempts,
  baseMs,
  draw,
  RECOVERY_LADDER,
  type Schedule,
} from '@/engine/schedule';
import { FakeClock } from '@/governors/clock';
import { RECOVERY } from '@/timing/config';

const T0 = Date.parse('2026-08-12T12:00:00');

/**
 * A supervisor whose ladder is already at `attempt`, hydrated from a persisted
 * snapshot so NO rng is consumed getting there — `nextHoldMs()` then draws the
 * rung under test from the very first value of `rng`, exactly like `draw()`.
 */
const supervisorAt = (attempt: number, rng: () => number): RecoverySupervisor => {
  const snap = JSON.stringify({
    phase: 'probing',
    attempt,
    holdUntil: null,
    enteredAt: T0,
    kindTally: {},
  });
  return new RecoverySupervisor({
    clock: new FakeClock(T0),
    store: {
      getRecoveryState: () => snap,
      setRecoveryState: () => {},
      setRecoveryLastIncident: () => {},
    },
    rng,
  });
};

describe('the schedule algebra', () => {
  test('attempts is total over every constructor', () => {
    expect(attempts({ k: 'once', ms: 1 })).toBe(1);
    expect(attempts({ k: 'recurs', ms: 1, n: 4 })).toBe(4);
    expect(attempts({ k: 'exponential', base: 1, factor: 2, cap: 9 })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(attempts({ k: 'table', ms: [1, 2, 3] })).toBe(3);
    expect(
      attempts({ k: 'truncate', n: 2, inner: { k: 'table', ms: [1, 2, 3] } }),
    ).toBe(2);
  });

  test('exponential grows by its factor and never passes its cap', () => {
    const s: Schedule = { k: 'exponential', base: 1_000, factor: 1.5, cap: 3_000 };
    expect(baseMs(s, 1)).toBe(1_000);
    expect(baseMs(s, 2)).toBe(1_500);
    expect(baseMs(s, 3)).toBe(2_250);
    expect(baseMs(s, 9)).toBe(3_000);
  });

  test('a spent schedule draws null rather than a fabricated wait', () => {
    const rng = (): number => 0.5;
    expect(draw(RECOVERY_LADDER, RECOVERY.MAX_HOLDS + 1, rng)).toBeNull();
    expect(draw(RECOVERY_LADDER, 0, rng)).toBeNull();
  });
});

describe('RECOVERY_LADDER reproduces the supervisor', () => {
  test('it carries the same rung count as the supervisor advertises', () => {
    expect(attempts(RECOVERY_LADDER)).toBe(RECOVERY.MAX_HOLDS);
    expect(supervisorAt(0, () => 0.5).maxAttempts()).toBe(RECOVERY.MAX_HOLDS);
  });

  test('each rung draws EXACTLY what nextHoldMs draws, for any rng stream', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 8, maxLength: 64 }),
        (xs) => {
          for (let rung = 1; rung <= RECOVERY.MAX_HOLDS; rung += 1) {
            let i = 0;
            const rngA = (): number => xs[i++ % xs.length];
            let j = 0;
            const rngB = (): number => xs[j++ % xs.length];
            const fromSchedule = draw(RECOVERY_LADDER, rung, rngA);
            const fromSupervisor = supervisorAt(rung, rngB).nextHoldMs();
            expect(fromSchedule).toBe(fromSupervisor);
            // …and consume the rng the same number of times, so swapping one for
            // the other cannot shift any downstream seeded draw.
            expect(i).toBe(j);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  test('every rung stays inside the clamp band around its median', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: RECOVERY.MAX_HOLDS }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (rung, u) => {
          const median = RECOVERY.HOLD_MEDIANS_MS[rung - 1];
          const ms = draw(RECOVERY_LADDER, rung, () => u) as number;
          expect(ms).toBeGreaterThanOrEqual(Math.floor(median * RECOVERY.HOLD_MIN_FACTOR));
          expect(ms).toBeLessThanOrEqual(Math.ceil(median * RECOVERY.HOLD_MAX_FACTOR));
        },
      ),
      { numRuns: 300 },
    );
  });

  test('the medians are the ladder table, rung by rung', () => {
    for (let rung = 1; rung <= RECOVERY.MAX_HOLDS; rung += 1) {
      expect(baseMs(RECOVERY_LADDER, rung)).toBe(RECOVERY.HOLD_MEDIANS_MS[rung - 1]);
    }
    // Rungs get longer; the ladder never steps backwards.
    for (let rung = 2; rung <= RECOVERY.MAX_HOLDS; rung += 1) {
      expect(baseMs(RECOVERY_LADDER, rung)).toBeGreaterThanOrEqual(
        baseMs(RECOVERY_LADDER, rung - 1),
      );
    }
  });
});
