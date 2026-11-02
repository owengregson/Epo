/**
 * A relationship-reconciliation batch that made progress CONTINUES at the next
 * step — the shared profile visitor paces every read — instead of parking the
 * engine after each batch of ten. Live 2026-11-02 that park made the burst-then-
 * stop rhythm ("checking relationships after N days away").
 */
import { ReconciliationRunner } from '@/engine/reconciliation-runner';
import { FakeClock } from '@/governors/clock';

const runner = (check: () => Promise<Record<string, unknown>>, effects: unknown = true) =>
  new ReconciliationRunner({
    clock: new FakeClock(1_000_000),
    reentry: undefined,
    reconcileEffects: async () => effects as never,
    followback: { check } as never,
  });

test('a follow-back batch that made progress continues without a park', async () => {
  const r = runner(async () => ({ detected: [], outcome: 'partial', reconciledAt: null, unresolved: 3,
    deferred: 'reconciliation-progress', retryAt: 1_000_000 }));
  expect(await r.run(1_000_000, () => false)).toEqual({ outcome: 'progress' });
});

test('an effect batch that made progress continues without a park', async () => {
  const r = runner(async () => ({ detected: [], outcome: 'complete', reconciledAt: 1, unresolved: 0 }),
    { outcome: 'progress', remaining: 4, settled: 2 });
  expect(await r.run(1_000_000, () => false)).toEqual({ outcome: 'progress' });
});

test('a read-budget deferral still waits for its window', async () => {
  const r = runner(async () => ({ detected: [], outcome: 'partial', reconciledAt: null, unresolved: 3,
    deferred: 'read-budget', retryAt: 1_000_000 + 3_600_000 }));
  expect(await r.run(1_000_000, () => false)).toEqual({ outcome: 'wait', delayMs: 3_600_000 });
});
