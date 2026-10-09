/**
 * The recovery requeue-healer as a pure function over the store slice: the
 * window is widened by the entry grace, capped, and the incident record is
 * amended with the heal outcome. No Engine, no clock, no ports.
 */

import type { RecoveryIncident } from '@/engine/recovery';
import { type HealerStore, healIncidentWindow } from '@/engine/recovery-healer';
import { RECOVERY } from '@/timing/config';

interface Spy extends HealerStore {
  calls: Array<{ windowStartMs: number; windowEndMs: number; cap: number; now: number }>;
  incidents: Array<string | null>;
}

const spyStore = (healed = 3): Spy => {
  const calls: Spy['calls'] = [];
  const incidents: Array<string | null> = [];
  return {
    calls,
    incidents,
    healAbandonedInWindow: (opts) => {
      calls.push(opts);
      return { healed, toQueued: healed, toUnfollowQueued: 0, skippedUnworkable: 1 };
    },
    setRecoveryLastIncident: (raw) => incidents.push(raw),
  };
};

const incident = (over: Partial<RecoveryIncident> = {}): RecoveryIncident => ({
  enteredAt: 1_000_000,
  resolvedAt: 2_000_000,
  attempts: 2,
  kindTally: { 'rate-limited': 2 },
  healed: null,
  ...over,
});

describe('healIncidentWindow', () => {
  test('heals from the entry MINUS the grace through the resolution', () => {
    const store = spyStore();
    const inc = incident();
    const result = healIncidentWindow(store, inc, 3_000_000);

    expect(store.calls).toEqual([
      {
        windowStartMs: inc.enteredAt - RECOVERY.HEAL_GRACE_MS,
        windowEndMs: inc.resolvedAt,
        cap: RECOVERY.HEAL_MAX_RECORDS,
        now: 3_000_000,
      },
    ]);
    expect(result.window).toEqual({
      from: inc.enteredAt - RECOVERY.HEAL_GRACE_MS,
      to: inc.resolvedAt,
    });
    expect(result.healed).toBe(3);
    expect(result.skippedUnworkable).toBe(1);
  });

  test('amends the persisted incident with the heal outcome', () => {
    const store = spyStore(5);
    healIncidentWindow(store, incident(), 3_000_000);

    expect(store.incidents).toHaveLength(1);
    const written = JSON.parse(store.incidents[0] as string) as RecoveryIncident;
    expect(written.enteredAt).toBe(1_000_000);
    expect(written.attempts).toBe(2);
    expect(written.healed).toEqual({ count: 5, at: 3_000_000 });
  });

  test('a window that heals nothing still records the (empty) outcome', () => {
    const store = spyStore(0);
    const result = healIncidentWindow(store, incident(), 42);

    expect(result.healed).toBe(0);
    const written = JSON.parse(store.incidents[0] as string) as RecoveryIncident;
    expect(written.healed).toEqual({ count: 0, at: 42 });
  });
});
