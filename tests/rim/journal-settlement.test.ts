/**
 * The journal's settlement step (spec §9.8) against a real store: one due intent per call, one read
 * of its account, the pure table applied — F6 end to end, parks that take the intent out of `due`,
 * terminals, walls, refused reads, renames, and accepted requests settled from channel evidence.
 */
import { FakeClock } from '@/governors/clock';
import type { ParkSlots } from '@/kernel/derive-parks';
import { type JournalSettlementDeps, settleFromChannels, settleNextIntent } from '@/rim/journal-settlement';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { MutationAction } from '@/store/types';
import { openTestStore } from '../kit/store';

const DAY = 86_400_000;
let store: KnowledgeStore;
let clock: FakeClock;
let visit: jest.Mock<Promise<ProfileVisit>, [string]>;
let viewer: { following: boolean | null; requested: boolean | null; followsUs: boolean | null };
let permit: { allowed: boolean; resumeAt: number | null };
let token: AbortController;

beforeEach(() => {
  store = openTestStore(':memory:');
  clock = new FakeClock(Date.UTC(2026, 10, 3, 12));
  viewer = { following: true, requested: false, followsUs: false };
  permit = { allowed: true, resumeAt: null };
  token = new AbortController();
  visit = jest.fn(async (username: string): Promise<ProfileVisit> => ({
    ok: true, viewer, obs: { accountPk: 'a', observedAt: clock.now(), source: 'profile', fields: { username } },
  }));
});
afterEach(() => store.close());

const slots = (): ParkSlots => ({ nextSessionAt: null, planDayStartAfter: (k) => clock.now() + k * DAY });
const deps = (over: Partial<JournalSettlementDeps> = {}): JournalSettlementDeps => ({
  store, profiles: { visit }, ownPk: 'me', clock, readBudget: { consume: () => permit }, slots, maxRetries: () => 3,
  signal: () => token.signal, ...over,
});
const open = (action: MutationAction = 'unfollow', channel: 'growth' | 'accept-request' = 'growth') => {
  const i = store.beginEffectIntent({ accountPk: 'a', username: 'alice', action, channel, at: clock.now() - 1_000 });
  store.markEffectUncertain(i.id, clock.now() - 900);
  return i;
};
const queuedForUnfollow = () => store.upsertFollowRecord({ accountPk: 'a', targetPk: 'seed', state: 'unfollow_queued',
  retryCount: 0, followedAt: clock.now() - 9 * DAY });

test('nothing due: no read, no visit', async () => {
  expect(await settleNextIntent(deps())).toEqual({ outcome: 'none' });
  expect(visit).not.toHaveBeenCalled();
});

test('F6: an uncertain unfollow still following is cancelled and its record stays queued for unfollow', async () => {
  queuedForUnfollow();
  const i = open();
  expect(await settleNextIntent(deps())).toEqual({ outcome: 'settled' });
  expect(store.getEffectIntent(i.id)).toMatchObject({ state: 'settled', result: 'cancelled' });
  expect(store.getFollowRecord('a')).toMatchObject({ state: 'unfollow_queued', reconciledAt: clock.now() });
  expect(store.getEdge('me', 'a', 'follows')?.status).toBe('active');
});

test('an unfollow that landed closes the record and our follow edge', async () => {
  queuedForUnfollow();
  viewer = { following: false, requested: false, followsUs: false };
  const i = open();
  await settleNextIntent(deps());
  expect(store.getEffectIntent(i.id)).toMatchObject({ result: 'external' });
  expect(store.getFollowRecord('a')?.state).toBe('unfollowed');
  expect(store.getEdge('me', 'a', 'follows')?.status).toBe('removed');
});

test('a gone account parks to a new plan-day, leaves the due set, and the second sighting expires it', async () => {
  queuedForUnfollow();
  visit.mockResolvedValue({ ok: false, kind: 'gone', detail: {} });
  const i = open();
  expect(await settleNextIntent(deps())).toEqual({ outcome: 'parked' });
  expect(store.getEffectIntent(i.id)).toMatchObject({ state: 'uncertain', attempts: 1, nextAttemptAt: clock.now() + DAY });
  expect(store.getFollowRecord('a')).toMatchObject({ parkReason: 'unreachable', recheckAt: clock.now() + DAY });
  expect(await settleNextIntent(deps())).toEqual({ outcome: 'none' });
  clock.advance(DAY);
  expect(await settleNextIntent(deps())).toEqual({ outcome: 'expired' });
  expect(store.getEffectIntent(i.id)).toMatchObject({ state: 'settled', result: 'expired' });
  expect(store.getFollowRecord('a')?.state).toBe('external');
});

test('a renamed page (another pk under the old name) is unreachable; the visit uses the current username', async () => {
  store.observe({ accountPk: 'a', observedAt: clock.now() - 10, source: 'profile', fields: { username: 'alice.new' } });
  visit.mockImplementation(async (username) => ({ ok: true, viewer,
    obs: { accountPk: 'someone-else', observedAt: clock.now(), source: 'profile', fields: { username } } }));
  const i = open();
  expect(await settleNextIntent(deps())).toEqual({ outcome: 'parked' });
  expect(visit).toHaveBeenCalledWith('alice.new', { pk: 'a' });
  expect(store.getEffectIntent(i.id)?.attempts).toBe(1);
});

test('a wall counts no attempt; a refused read parks to the allowance with no visit', async () => {
  visit.mockResolvedValue({ ok: false, kind: 'walled', detail: {} });
  const i = open();
  expect(await settleNextIntent(deps())).toEqual({ outcome: 'walled' });
  expect(store.getEffectIntent(i.id)).toMatchObject({ state: 'uncertain', attempts: 0, nextAttemptAt: null });
  visit.mockClear();
  permit = { allowed: false, resumeAt: clock.now() + 5_000 };
  expect(await settleNextIntent(deps())).toEqual({ outcome: 'parked' });
  expect(visit).not.toHaveBeenCalled();
  expect(store.getEffectIntent(i.id)).toMatchObject({ attempts: 0, nextAttemptAt: clock.now() + 5_000 });
});

test('a stop during the visit settles nothing', async () => {
  const i = open();
  visit.mockImplementation(async (username) => {
    token.abort();
    return { ok: true, viewer, obs: { accountPk: 'a', observedAt: clock.now(), source: 'profile', fields: { username } } };
  });
  expect(await settleNextIntent(deps())).toEqual({ outcome: 'aborted' });
  expect(store.getEffectIntent(i.id)).toMatchObject({ state: 'uncertain', attempts: 0 });
});

test('an accepted request that landed opens the follower edge and closes the request edge', async () => {
  store.observeEdge('a', 'me', 'requests', true, clock.now() - 2_000);
  viewer = { following: false, requested: false, followsUs: true };
  const i = open('accept-request', 'accept-request');
  await settleNextIntent(deps());
  expect(store.getEffectIntent(i.id)?.result).toBe('external');
  expect(store.getEdge('a', 'me', 'follows')?.status).toBe('active');
  expect(store.getEdge('a', 'me', 'requests')?.status).toBe('removed');
});

test('channel evidence settles an open accept with zero reads: a later follow lands it, a later listing cancels it', () => {
  const landed = open('accept-request', 'accept-request');
  const at = clock.now();
  expect(settleFromChannels({ store, ownPk: 'me', now: at }, { follower: { pk: 'a', atMs: at - 2_000 } })).toBe(0);
  expect(settleFromChannels({ store, ownPk: 'me', now: at }, { follower: { pk: 'a', atMs: at } })).toBe(1);
  expect(store.getEffectIntent(landed.id)?.result).toBe('external');
  const listed = open('accept-request', 'accept-request');
  expect(settleFromChannels({ store, ownPk: 'me', now: at }, { stillRequesting: { pk: 'a', at } })).toBe(1);
  expect(store.getEffectIntent(listed.id)?.result).toBe('cancelled');
  expect(visit).not.toHaveBeenCalled();
});
