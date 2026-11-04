import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import { AdapterBackedOwnFollowersTargetSource } from '@/rim/own-followers-target-source';
import type { ProfileEnricher } from '@/rim/profile-enricher';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { openTestStore } from '../kit/store';

const OWN = 'me';

let store: KnowledgeStore;
beforeEach(() => {
  store = openTestStore(':memory:');
});
afterEach(() => store.close());

const source = (): AdapterBackedOwnFollowersTargetSource =>
  new AdapterBackedOwnFollowersTargetSource({ store, ownPk: OWN });

/** Record `pk` as one of our followers (active edge pk → me) with a follower count. */
const addFollower = (pk: string, followers: number): void => {
  store.observe({ accountPk: pk, observedAt: 100, source: 'profile', fields: { username: pk, followers, following: 10 } });
  store.observeEdge(pk, OWN, 'follows', true, 100);
};

test('picks the follower with the highest known follower count', async () => {
  addFollower('a', 100);
  addFollower('b', 500);
  addFollower('c', 400);

  expect(await source().pick()).toBe('b');
});

test('skips followers that are already chain targets', async () => {
  addFollower('a', 100);
  addFollower('b', 500); // best by count, but already a target
  addFollower('c', 400);
  store.addTarget({ accountPk: 'b', source: 'own_followers', status: 'active', chainIndex: 0 });

  expect(await source().pick()).toBe('c');
});

test('returns null when we have no eligible followers', async () => {
  expect(await source().pick()).toBeNull();

  // Even with a follower, if it is already a target there is nothing to pick.
  addFollower('a', 100);
  store.addTarget({ accountPk: 'a', source: 'own_followers', status: 'active', chainIndex: 0 });
  expect(await source().pick()).toBeNull();
});

/** An own follower listed without counts, so a pick has to enrich before it can rank. */
const addCountless = (pk: string): void => {
  store.observe({ accountPk: pk, observedAt: 100, source: 'followers-list', fields: { username: pk } });
  store.observeEdge(pk, OWN, 'follows', true, 100);
};

test('a pick enriches at most EXPLORATION_POLICY.ownFollowersPickMax count-less followers first', async () => {
  for (let i = 0; i < EXPLORATION_POLICY.ownFollowersPickMax + 4; i += 1) addCountless(`p${i}`);
  const batches: string[][] = [];
  const enricher: ProfileEnricher = {
    enrich: async (usernames) => {
      batches.push(usernames);
      return 0;
    },
  };
  await new AdapterBackedOwnFollowersTargetSource({ store, ownPk: OWN, enricher }).pick();
  expect(batches.map((b) => b.length)).toEqual([EXPLORATION_POLICY.ownFollowersPickMax]);
});

test('with no pool floor handed in, the recommended one applies', async () => {
  addFollower('small', SETTINGS_POLICY.RECOMMENDED.minPoolSize - 1);
  addFollower('enough', SETTINGS_POLICY.RECOMMENDED.minPoolSize);
  expect(await source().candidates()).toEqual(['enough']);
});

test('ties on count rank by profile completeness, then pk', async () => {
  addFollower('b', 500);
  addFollower('a', 500);
  store.observe({ accountPk: 'c', observedAt: 100, source: 'followers-list', fields: { username: 'c', followers: 500 } });
  store.observeEdge('c', OWN, 'follows', true, 100);
  expect(await source().candidates()).toEqual(['a', 'b', 'c']);
});
