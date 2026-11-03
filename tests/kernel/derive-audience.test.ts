/**
 * The audience derivations (spec §6.4): `likely` is the policy curve; `wide` widens it in log space around
 * the plateau, keeping the plateau and the order; each account size names its policy range.
 */

import { audienceCurve, audienceRange } from '@/kernel/derive-audience';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';

const points = (c: ReturnType<typeof audienceCurve>): number[] =>
  [c.hardLow, c.bandLow, c.peakLow, c.peakHigh, c.bandHigh, c.hardHigh];

test('likely is the policy curve', () => {
  expect(audienceCurve('likely')).toEqual(SETTINGS_POLICY.RATIO_CURVE);
});

test('wide keeps the plateau, stays ordered and reaches further on both sides', () => {
  const likely = audienceCurve('likely');
  const wide = audienceCurve('wide');
  expect([wide.peakLow, wide.peakHigh]).toEqual([likely.peakLow, likely.peakHigh]);
  expect(points(wide)).toEqual([...points(wide)].sort((a, b) => a - b));
  expect(wide.hardLow).toBeLessThan(likely.hardLow);
  expect(wide.bandLow).toBeLessThan(likely.bandLow);
  expect(wide.bandHigh).toBeGreaterThan(likely.bandHigh);
  expect(wide.hardHigh).toBeGreaterThan(likely.hardHigh);
});

test('wide is the log-space stretch by the widen factor around the plateau centre', () => {
  const { RATIO_CURVE: c, AUDIENCE_WIDEN_FACTOR: k } = SETTINGS_POLICY;
  const centre = Math.sqrt(c.peakLow * c.peakHigh);
  const wide = audienceCurve('wide');
  expect(Math.log(wide.hardHigh / centre)).toBeCloseTo(k * Math.log(c.hardHigh / centre), 10);
  expect(Math.log(centre / wide.hardLow)).toBeCloseTo(k * Math.log(centre / c.hardLow), 10);
});

test('each size names its policy range', () => {
  for (const size of ['small', 'everyday', 'larger'] as const) {
    expect(audienceRange(size)).toEqual(SETTINGS_POLICY.AUDIENCE_SIZE[size]);
  }
});
