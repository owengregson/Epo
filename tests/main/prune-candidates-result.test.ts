import { cleanupMainHarness, foundationStore, newFoundation } from '../kit/main-harness';

afterAll(cleanupMainHarness);

test('an empty saved list is success; a failed graph read is typed unavailable', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  expect(await foundation.pruneCandidates()).toEqual({ ok: true, candidates: [] });
  const store = foundationStore(foundation);
  const failed = jest.spyOn(store, 'getPruneScan').mockImplementation(() => { throw new Error('unreadable census'); });
  expect(await foundation.pruneCandidates()).toEqual({ ok: false, reason: 'unavailable' });
  failed.mockRestore();
  await foundation.dispose();
});
