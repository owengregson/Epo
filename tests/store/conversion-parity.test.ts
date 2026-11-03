/**
 * Law L7 (one conversion): the UI's target yield and the engine's mature yield fold the same
 * classifier over the same records, so they never disagree about a follow-back.
 */
import fc from 'fast-check';
import { matureYield } from '@/engine/source-quality';
import { FOLLOW_STATES, type FollowRecord } from '@/store/types';
import { memoryStore } from '../kit/store';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const maybe = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
const at = fc.integer({ min: 80 * DAY, max: NOW });

const arbRecord = (i: number): fc.Arbitrary<FollowRecord> => fc.record({
  state: fc.constantFrom(...FOLLOW_STATES),
  followedAt: maybe(at),
  followedBackAt: maybe(at),
  followbackAfter: maybe(at),
  followbackObservedAt: maybe(at),
  reconciledAt: maybe(at),
  unfollowReason: maybe(fc.constantFrom<'no-followback' | 'hold-expired'>('no-followback', 'hold-expired')),
  target: fc.constantFrom('T', 'U'),
}).map(({ target, ...r }) => ({ ...r, accountPk: `p${i}`, targetPk: target, retryCount: 0 }));

test('law L7: the UI and the engine classify every follow-back identically', () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 25 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbRecord(i)))),
    fc.integer({ min: 1, max: 10 }),
    (records, windowDays) => {
      const store = memoryStore();
      try {
        for (const r of records) store.upsertFollowRecord(r);
        const windowMs = windowDays * DAY;
        const ui = store.targetYield('T', 'ME', { windowMs, now: NOW });
        const engine = matureYield(store, 'T', NOW, windowMs);
        expect(ui.followedBack).toBe(engine.successes);
        expect(ui.followBackRate).toBe(engine.mature === 0 ? 0 : engine.successes / engine.mature);
      } finally { store.close(); }
    }), { numRuns: 200 });
});

test('an undated follow-back seen before the horizon is a success on both sides (U08 F12)', () => {
  const store = memoryStore();
  try {
    store.upsertFollowRecord({ accountPk: 'a', targetPk: 'T', state: 'followed_back', followedAt: 90 * DAY,
      followbackObservedAt: 92 * DAY, retryCount: 0 });
    expect(store.targetYield('T', 'ME', { windowMs: 4 * DAY, now: NOW })).toMatchObject({ followedBack: 1, followBackRate: 1 });
    expect(matureYield(store, 'T', NOW, 4 * DAY)).toMatchObject({ mature: 1, successes: 1 });
  } finally { store.close(); }
});
