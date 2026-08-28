import { type StepWatchdogInput, stepWatchdogShouldFire } from '@/main/foundation-wiring';
import { RECOVERY } from '@/timing/config';

/**
 * The engine step watchdog's fire decision, as a pure predicate: it must fire
 * ONLY for a loop that claims to be running, has been silent past the stale
 * window, AND holds no pending `engine:` wait in the DelayManager — every
 * legitimate long park (velocity park, enrich backoff, session gap) registers
 * an `engine:` wait, so a parked loop can never false-positive.
 */

const NOW = 1_000_000_000;

const base = (over: Partial<StepWatchdogInput> = {}): StepWatchdogInput => ({
  engineState: 'running',
  now: NOW,
  lastActivityAt: NOW - RECOVERY.STEP_WATCHDOG_MS - 1,
  staleAfterMs: RECOVERY.STEP_WATCHDOG_MS,
  pendingDelayKeys: [],
  ...over,
});

describe('stepWatchdogShouldFire', () => {
  test('running + stale + no pending engine wait -> fires', () => {
    expect(stepWatchdogShouldFire(base())).toBe(true);
  });

  test('any pending engine:-prefixed wait suppresses the fire (legitimate park)', () => {
    expect(
      stepWatchdogShouldFire(base({ pendingDelayKeys: ['engine:action-delay'] })),
    ).toBe(false);
    expect(
      stepWatchdogShouldFire(base({ pendingDelayKeys: ['prune:park', 'engine:velocity-park'] })),
    ).toBe(false);
  });

  test('a pending wait under another namespace does NOT shield a wedged engine', () => {
    expect(stepWatchdogShouldFire(base({ pendingDelayKeys: ['prune:park'] }))).toBe(true);
  });

  test('recent activity -> never fires, even with no pending waits', () => {
    expect(stepWatchdogShouldFire(base({ lastActivityAt: NOW - 1_000 }))).toBe(false);
  });

  test('exactly at the stale boundary -> not yet stale (strictly-beyond fires)', () => {
    expect(
      stepWatchdogShouldFire(base({ lastActivityAt: NOW - RECOVERY.STEP_WATCHDOG_MS })),
    ).toBe(false);
  });

  test('non-running states never fire regardless of staleness', () => {
    for (const engineState of ['idle', 'paused', 'halted'] as const) {
      expect(stepWatchdogShouldFire(base({ engineState }))).toBe(false);
    }
  });
});
