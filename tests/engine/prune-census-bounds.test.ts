import { makePruneHarness } from '../kit/engine-harness';
import { fakePrunePlan } from '../kit/harness-plan';

test('a census too large for its host session refuses before either list opens', async () => {
  const h = makePruneHarness({ following: ['a'], followers: [], plan: {
    ...fakePrunePlan({ pruneCountSince: () => 0 }),
    censusBounds: () => ({ followers: 10, following: 2, walkMax: 11 }),
  } });
  await expect(h.engine.scan()).rejects.toThrow('too-large');
  expect(h.ownFollowing.calls).toBe(0);
  expect(h.ownFollowers.calls).toBe(0);
  expect(h.store.getPruneCensus()).toBeNull();
});

test('a complete census persists its measured rows per page for the next plan', async () => {
  const followers = Array.from({ length: 20 }, (_, i) => `f${i}`);
  const h = makePruneHarness({ following: [...followers, 'candidate'], followers, plan: {
    ...fakePrunePlan({ pruneCountSince: () => 0 }),
    censusBounds: () => ({ followers: 2, following: 2, walkMax: 4 }),
  } });
  jest.spyOn(h.ownFollowers, 'fetchAllPks').mockResolvedValue({ pks: followers, complete: true, reason: 'no-more-pages', pages: 2, rowsPerPage: 10 });
  expect((await h.engine.scan()).aborted).toBe(false);
  expect(h.store.getPruneCensus()?.rowsPerPage).toBe(10);
  expect(h.ownFollowing.lastOpts?.census).toEqual({ pages: 2, walkMax: 4 });
  expect(h.ownFollowers.fetchAllPks).toHaveBeenCalledWith(expect.objectContaining({ census: { pages: 2, walkMax: 2 } }));
});
