import { AdapterBackedOwnFollowersTargetSource } from '@/rim/own-followers-target-source';
import { KnowledgeStore } from '@/store/knowledge-store';

const OWN = 'me';

let store: KnowledgeStore;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
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
  addFollower('c', 200);

  expect(await source().pick()).toBe('b');
});

test('skips followers that are already chain targets', async () => {
  addFollower('a', 100);
  addFollower('b', 500); // best by count, but already a target
  addFollower('c', 200);
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
