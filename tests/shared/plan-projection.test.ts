/** `paceLabel` names a session's pace factor with one word per pace band (spec §5.17). */

import { PLAN_BOUNDS } from '@/kernel/plan/policy';
import { paceLabel as label } from '@/shared/plan-projection';

const paceLabel = (pace: number) => label(pace, PLAN_BOUNDS.PACE_WORDS);

test('a slower-than-reference session is relaxed, a brisker one quick, the band between normal', () => {
  expect(paceLabel(1.45)).toBe('relaxed');
  expect(paceLabel(1.16)).toBe('relaxed');
  expect(paceLabel(1.15)).toBe('normal');
  expect(paceLabel(1)).toBe('normal');
  expect(paceLabel(0.87)).toBe('normal');
  expect(paceLabel(0.86)).toBe('quick');
  expect(paceLabel(0.7)).toBe('quick');
});
