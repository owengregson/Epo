/**
 * The engine's park vocabulary: each long park surfaces as its own reason. The journal has no
 * backoff of its own (spec §9.8: an unavailable account parks per intent, never the loop).
 */
import { ENGINE_WAIT_CLASS, parkReasonFor } from '@/engine/engine-waits';

test('no wait parks the loop for a reconciliation any more: the key is gone', () => {
  expect(parkReasonFor('engine:reconcile-backoff')).toBeNull();
  expect(Object.keys(ENGINE_WAIT_CLASS)).not.toContain('engine:reconcile-backoff');
});

test('enrichment walls keep their own reason', () => {
  expect(parkReasonFor('engine:enrich-backoff')).toBe('enrich-backoff');
});

test('a spent read allowance parks as itself, until its known reopen time (never a 2× retry stretch)', () => {
  expect(parkReasonFor('engine:read-budget-park')).toBe('read-budget');
  // Positive-only boundary offset: never wakes before the window reopens.
  expect(ENGINE_WAIT_CLASS['engine:read-budget-park']).toBe('daily-boundary');
});
