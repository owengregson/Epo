/**
 * The surface health vocabulary (Appendix D.1): six areas and five meters, closed;
 * the meters restate the adapter's measured quantities import-free; the gate is
 * F2a's, re-exported rather than restated, so nothing pauses by default.
 */

import { NEVER_PAUSED as GATE_DEFAULT } from '@/shared/surface-gate';
import { NEVER_PAUSED, SURFACE_AREAS, SURFACE_METERS } from '@/shared/surface-health';
import { SURFACE_METRICS } from '@/surface/meter';

test('the six areas are closed', () => {
  expect(SURFACE_AREAS).toEqual([
    'profiles', 'notifications', 'follow-requests', 'lists', 'relationship-checks', 'follow-actions',
  ]);
});

test("the meters are the adapter's five measured quantities", () => {
  expect(SURFACE_METERS).toEqual(['hydration', 'mutation-arrival', 'list-page', 'body-read', 'scroll-settle']);
  expect([...SURFACE_METERS].sort()).toEqual([...SURFACE_METRICS].sort());
});

test('the gate is re-exported, not restated: nothing pauses by default', () => {
  expect(NEVER_PAUSED).toBe(GATE_DEFAULT);
  expect(NEVER_PAUSED.paused('unfollows')).toBe(false);
});
