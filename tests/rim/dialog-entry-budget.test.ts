import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { ReadBudget } from '@/governors/read-budget';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { FakeActor, FakeSentinel, FakeTab } from '../kit/fakes';

test('a plan budget that closes during entry spacing refuses the dialog before navigation', async () => {
  const actor = new FakeActor();
  let open = true;
  const consume = jest.fn(() => ({ allowed: open, resumeAt: open ? null : 123 }));
  const readBudget = { availability: () => ({ allowed: true, resumeAt: null }), consume } as unknown as ReadBudget;
  const reader = new FollowersPageReader({ tab: new FakeTab(), reader: new Reader(), actor, readBudget,
    activity: { lastEndAt: () => null, noteEnd: () => {}, spaceEntry: async () => { open = false; } },
    sleep: async () => {} });
  const result = await reader.collect({ targetUsername: 'own', maxRounds: 1, noNewStop: 1,
    sentinel: new FakeSentinel() as unknown as Sentinel, onObservation: () => {} });
  expect(result).toMatchObject({ endReason: 'read-budget', retryAt: 123 });
  expect(actor.openCalls).toBe(0);
  expect(consume).toHaveBeenCalledTimes(1);
});


test('Stop during entry spacing prevents navigation and read debits', async () => {
  const actor = new FakeActor();
  let stopped = false;
  const consume = jest.fn(() => ({ allowed: true, resumeAt: null }));
  const readBudget = { availability: () => ({ allowed: true, resumeAt: null }), consume } as unknown as ReadBudget;
  const reader = new FollowersPageReader({ tab: new FakeTab(), reader: new Reader(), actor, readBudget,
    activity: { lastEndAt: () => null, noteEnd: () => {}, spaceEntry: async () => { stopped = true; } },
    sleep: async () => {} });
  const result = await reader.collect({ targetUsername: 'own', maxRounds: 1, noNewStop: 1,
    shouldStop: () => stopped, sentinel: new FakeSentinel() as unknown as Sentinel, onObservation: () => {} });
  expect(result.endReason).toBe('stop-requested');
  expect(actor.openCalls).toBe(0);
  expect(consume).not.toHaveBeenCalled();
});
