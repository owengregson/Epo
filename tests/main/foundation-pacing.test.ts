/**
 * The session-paced model (`pacingModel: 'organic'`) is the DEFAULT and must
 * actually reach the engine: a Foundation built with default settings injects
 * the plan, which surfaces as a non-null `pacing` readout on the engine status.
 * An install that stored 'legacy' runs on the plan as well: there is no other pacer.
 */

import { builtFoundation, cleanupMainHarness, newFoundation } from '../kit/main-harness';

afterAll(cleanupMainHarness);

test('default settings build the engine WITH the plan (organic reachable + default)', async () => {
  const { foundation: f, userDataDir } = newFoundation();
  // No settings file exists yet in this userData dir → pure defaults.
  expect((await f.getSettings()).pacingModel).toBe('organic');

  expect(await f.ensureBuilt()).toBe(true);
  const s = await f.status();
  // The session readout exists only when the plan was injected into the loop.
  expect(s.pacing).not.toBeNull();
  expect(typeof s.pacing?.dailyTarget).toBe('number');
  expect(typeof s.pacing?.sessionOpen).toBe('boolean');
  expect(userDataDir).toBeTruthy();

  await f.dispose();
});

test('a stored legacy model runs on the plan too: the legacy pacer is gone (spec §5.13 S2)', async () => {
  const { foundation: f } = newFoundation();
  // Persisted BEFORE the build — the graph is constructed from the stored choice.
  await f.updateSettings({ pacingModel: 'legacy' });

  expect(await f.ensureBuilt()).toBe(true);
  const s = await f.status();
  expect(s.pacing).not.toBeNull();

  // The stored value survives a reload untouched (the sanitizer respects 'legacy').
  expect((await f.getSettings()).pacingModel).toBe('legacy');

  await f.dispose();
});

test('the harness builder asserts the lazy build actually completed', async () => {
  const { foundation: f } = await builtFoundation();
  expect((await f.status()).loggedIn).toBe(true);
  await f.dispose();
});
