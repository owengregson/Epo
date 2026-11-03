import { FakeClock } from '@/governors/clock';
import { ReadBudget } from '@/governors/read-budget';
import { managedRelationships } from '@/rim/managed-relationships';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { kitStore } from '../kit/engine-harness';
import { readLimits } from '../kit/read-limits';

function fixture() {
  const store = kitStore();
  const clock = new FakeClock(1000);
  let signal = new AbortController();
  let response: ProfileVisit = { ok: true, obs: { accountPk: 'A', observedAt: 1000, source: 'profile', fields: {} },
    viewer: { followsUs: false, following: true, requested: false } };
  const visit = jest.fn(async () => response);
  const progress = jest.fn();
  const reader = managedRelationships({ clock, readBudget: new ReadBudget({ store, clock, limits: readLimits({ profiles: 1 }) }),
    profiles: { visit }, signal: () => signal.signal, onProgress: progress });
  return { reader, visit, progress, response: (r: ProfileVisit) => { response = r; },
    replaceRun: () => { signal = new AbortController(); } };
}

test('an explicit fresh negative is valid evidence, but spends one durable read', async () => {
  const f = fixture();
  expect(await f.reader.read('A', 'person')).toEqual({ ok: true, followsUs: false, observedAt: 1000 });
  expect(await f.reader.read('A', 'person')).toMatchObject({ ok: false, reason: 'read-budget' });
  expect(f.visit).toHaveBeenCalledTimes(1);
  expect(f.progress).toHaveBeenCalledTimes(1);
});

test.each([
  { accountPk: 'replacement', observedAt: 1000, followsUs: false },
  { accountPk: 'A', observedAt: 999, followsUs: false },
  { accountPk: 'A', observedAt: 1001, followsUs: false },
  { accountPk: 'A', observedAt: 1000, followsUs: null },
])('rejects identity, freshness or relationship ambiguity: %j', async ({ accountPk, observedAt, followsUs }) => {
  const f = fixture();
  f.response({ ok: true, obs: { accountPk, observedAt, source: 'profile', fields: {} },
    viewer: { followsUs, following: true, requested: false } });
  expect(await f.reader.read('A', 'person')).toEqual({ ok: false, reason: 'unavailable' });
  expect(f.progress).not.toHaveBeenCalled();
});

test('replacing the driver during observation cannot let an old result become current evidence', async () => {
  const f = fixture();
  const read = f.reader.read('A', 'person');
  f.replaceRun();
  expect(await read).toEqual({ ok: false, reason: 'unavailable' });
  expect(f.progress).not.toHaveBeenCalled();
});
