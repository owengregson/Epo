/**
 * The shared intent tuples restate the kernel's ordinal keys (Appendix B.1): each
 * tuple equals the kernel's key set, so `src/shared` stays import-free while the
 * kernel stays the source of meaning. Cleanup is the kernel's set minus `deep`.
 */

import { PREFERENCES, SCALES } from '@/kernel';
import {
  ACTIVITY_LEVELS, AUDIENCE_FOCUSES, AUDIENCE_SIZES, CAUTIONS, CLEANUP_LEVELS, CONSISTENCIES, DAY_SHAPES,
  INTENT_KEYS, MUTUAL_POLICIES, PACE_CARDS, PATIENCES, RHYTHMS, WEEKLY_SHAPES,
} from '@/shared/settings-intent';

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

test('each ordinal tuple equals the kernel key set', () => {
  expect(sorted(ACTIVITY_LEVELS)).toEqual(sorted(Object.keys(SCALES.activity)));
  expect(sorted(CAUTIONS)).toEqual(sorted(Object.keys(SCALES.caution)));
  expect(sorted(RHYTHMS)).toEqual(sorted(Object.keys(SCALES.rhythm)));
  expect(sorted(CONSISTENCIES)).toEqual(sorted(Object.keys(SCALES.consistency)));
  expect(sorted(PATIENCES)).toEqual(sorted(Object.keys(PREFERENCES.patience)));
  expect(sorted(DAY_SHAPES)).toEqual(sorted([...Object.keys(PREFERENCES.dayShape), 'balanced']));
  expect(sorted(WEEKLY_SHAPES)).toEqual(sorted([...Object.keys(PREFERENCES.weeklyShape), 'realistic']));
});

test("cleanup is the kernel's set without the retired deep level", () => {
  expect(sorted(CLEANUP_LEVELS)).toEqual(sorted(Object.keys(PREFERENCES.cleanup).filter((k) => k !== 'deep')));
});

test('the product-only vocabularies and the pace cards are closed', () => {
  expect(MUTUAL_POLICIES).toEqual(['rotate', 'keep']);
  expect(AUDIENCE_FOCUSES).toEqual(['likely', 'wide']);
  expect(AUDIENCE_SIZES).toEqual(['small', 'everyday', 'larger']);
  expect(PACE_CARDS).toEqual({
    gentle: { activity: 'light', caution: 'cautious' },
    balanced: { activity: 'moderate', caution: 'standard' },
    faster: { activity: 'active', caution: 'standard' },
  });
});

test('INTENT_KEYS names the fourteen intent keys once', () => {
  expect(new Set(INTENT_KEYS).size).toBe(14);
});
