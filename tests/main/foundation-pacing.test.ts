/**
 * The session-paced model (`pacingModel: 'organic'`) is the DEFAULT and must
 * actually reach the engine: a Foundation built with default settings injects
 * the plan, which surfaces as a non-null `pacing` readout on the engine status.
 * A 'legacy' write from an old renderer is dropped: there is no other pacer.
 */

import { builtFoundation, cleanupMainHarness, newFoundation } from '../kit/main-harness';

afterAll(cleanupMainHarness);

test('default settings build the engine WITH the plan (organic reachable + default)', async () => {
  const { foundation: f, userDataDir } = newFoundation();
  // No settings file exists yet in this userData dir → pure defaults.
  expect(f.settings.view().capabilities.plan).toBe(false);

  expect(await f.ensureBuilt()).toBe(true);
  const s = await f.status();
  // The session readout exists only when the plan was injected into the loop.
  expect(s.plan).not.toBeNull();
  expect(f.settings.view().capabilities.plan).toBe(true);
  expect(userDataDir).toBeTruthy();

  await f.dispose();
});


test('the harness builder asserts the lazy build actually completed', async () => {
  const { foundation: f } = await builtFoundation();
  expect((await f.status()).loggedIn).toBe(true);
  await f.dispose();
});
