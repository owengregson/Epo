import { Engine } from '@/engine/engine';
import { RuntimeHealth } from '@/engine/runtime-health';
import { kitStore, makeEngineHarness, testDeps } from '../kit/engine-harness';

test('five consecutive runtime exceptions visibly halt instead of reporting an endless healthy loop', async () => {
  const h = makeEngineHarness();
  h.sentinel.failNext = 5;
  for (let i = 0; i < 4; i++) expect(await h.engine.stepOnce()).toBe('idle');
  expect(await h.engine.stepOnce()).toBe('halted');
  expect(h.engine.status()).toMatchObject({ haltReason: 'runtime-error', health: { consecutiveErrors: 5 } });
  expect(h.churn.executed).toHaveLength(0);
});

test('a process restart preserves accumulated failures and useful progress independently', () => {
  const store = kitStore();
  const first = new RuntimeHealth(store);
  first.progress('source-rotated', 100);
  expect(first.failure(new Error('read unavailable'), 101)).toBe(false);
  const reopened = new RuntimeHealth(store);
  expect(reopened.snapshot()).toMatchObject({ consecutiveErrors: 1, lastProgressAt: 100 });
  reopened.responsive();
  expect(reopened.snapshot()).toMatchObject({ consecutiveErrors: 0, lastProgressAt: 100, lastErrorAt: 101 });
});

test('storage failures halt on the first occurrence', async () => {
  const store = kitStore();
  const engine = new Engine(testDeps({ store, sentinel: { check: async () => { throw new Error('SQLITE_IOERR: disk I/O'); } } }));
  expect(await engine.stepOnce()).toBe('halted');
  expect(engine.status().haltReason).toBe('runtime-error');
});

test.each(['{"version":1,"consecutiveErrors":0}', '{', '{"version":5}'])(
  'invalid durable health does not silently become healthy: %s', (raw) => {
    const store = kitStore();
    store.setLifecycleHealthState(raw);
    expect(() => new RuntimeHealth(store)).toThrow();
  },
);
