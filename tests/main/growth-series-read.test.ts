/**
 * The `growth:series` read envelope through a BUILT Foundation: the `days`
 * parameter reaches the store's parameterized series (window → series length),
 * omitted/invalid days fall back to the 14-day default, and the envelope
 * carries the followers-measurement baseline the renderer's honesty gates
 * (window "All", the momentum delta) read.
 */

import { builtFoundation, cleanupMainHarness, foundationStore } from '../kit/main-harness';

afterAll(cleanupMainHarness);

/** `k` days before now, same time of day (Date arithmetic — DST-safe). */
function daysAgo(k: number): number {
  const d = new Date();
  d.setDate(d.getDate() - k);
  return d.getTime();
}

test('growth:series read: days parameter, default, and baseline envelope', async () => {
  const { foundation: f } = await builtFoundation();
  const store = foundationStore(f);

  // Measurement began 20 days ago; gains landed 10 and 3 days ago.
  const baselineAt = daysAgo(20);
  store.ensureFollowersBaseline(baselineAt);
  store.observeOwnFollowerEvent('f1', '4242', daysAgo(10));
  store.observeOwnFollowerEvent('f2', '4242', daysAgo(10));
  store.observeOwnFollowerEvent('f3', '4242', daysAgo(3));

  // Default window: 14 points, both gains inside, baseline in the envelope.
  const dflt = await f.growthSeries();
  expect(dflt.points).toHaveLength(14);
  expect(dflt.points[13].cumulativeNet).toBe(3);
  expect(dflt.baselineAt).toBe(baselineAt);

  // The days parameter reaches the store read: window → series length.
  expect((await f.growthSeries(30)).points).toHaveLength(30);
  expect((await f.growthSeries(90)).points).toHaveLength(90);

  // A narrower window drops the older gains — the same parameterized read.
  const week = await f.growthSeries(7);
  expect(week.points).toHaveLength(7);
  expect(week.points[6].cumulativeNet).toBe(1);

  // Invalid days fall back to the 14-day default, never an empty fabrication.
  expect((await f.growthSeries(0)).points).toHaveLength(14);
  expect((await f.growthSeries(Number.NaN)).points).toHaveLength(14);

  await f.dispose();
});
