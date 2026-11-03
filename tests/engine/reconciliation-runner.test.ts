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

test('a read-budget deferral waits for its window, as a schedule rather than a retry', async () => {
  const r = runner(async () => ({ detected: [], outcome: 'partial', reconciledAt: null, unresolved: 3,
    deferred: 'read-budget', retryAt: 1_000_000 + 3_600_000 }));
  expect(await r.run(1_000_000, () => false)).toEqual({ outcome: 'wait', delayMs: 3_600_000, reason: 'read-budget' });
});

test('an effect read deferred by the allowance waits for its window too', async () => {
  const r = runner(async () => ({ detected: [], outcome: 'complete', reconciledAt: 1, unresolved: 0 }),
    { outcome: 'deferred', remaining: 4, settled: 0, retryAt: 1_000_000 + 7_200_000 });
  expect(await r.run(1_000_000, () => false)).toEqual({ outcome: 'wait', delayMs: 7_200_000, reason: 'read-budget' });
});

test('a failed read backs off (the noised retry park)', async () => {
  const r = runner(async () => ({ detected: [], outcome: 'failed', reconciledAt: null, unresolved: 3 }));
  expect(await r.run(1_000_000, () => false)).toMatchObject({ outcome: 'wait', reason: 'backoff' });
});

describe('who decides whether a return re-reads every relationship (live 2026-11-02)', () => {
  const withReentry = (census: boolean) => {
    const check = jest.fn(async (_opts: unknown) => ({ detected: [], outcome: 'complete', reconciledAt: 1, unresolved: 0 }));
    const r = new ReconciliationRunner({
      clock: new FakeClock(1_000_000),
      reentry: {
        requiresReconciliation: () => true,
        requiresCensus: () => census,
        snapshot: () => ({ reconciliationStartedAt: 900_000 }),
        noteReconciled: () => {},
      } as never,
      reconcileEffects: async () => true,
      followback: { check } as never,
    });
    return { r, check };
  };

  test('an absence reconciles what is due, with evidence from the return on', async () => {
    const { r, check } = withReentry(false);
    await r.run(1_000_000, () => false);
    expect(check).toHaveBeenCalledWith({ requireFresh: false, freshSinceAt: 900_000 });
  });

  test('untrusted timers (a clock change, pre-journal history) re-read every relationship', async () => {
    const { r, check } = withReentry(true);
    await r.run(1_000_000, () => false);
    expect(check).toHaveBeenCalledWith({ requireFresh: true, freshSinceAt: 900_000 });
  });
});
