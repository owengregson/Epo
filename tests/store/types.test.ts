import { ratioOf, SOURCE_CONFIDENCE } from '@/store/types';
test('ratioOf computes following/followers', () => {
  expect(ratioOf(100, 120)).toBeCloseTo(1.2);
  expect(ratioOf(0, 50)).toBeUndefined();
  expect(ratioOf(undefined, 50)).toBeUndefined();
});
test('profile reads outrank list reads', () => {
  expect(SOURCE_CONFIDENCE.profile).toBeGreaterThan(SOURCE_CONFIDENCE['followers-list']);
});
