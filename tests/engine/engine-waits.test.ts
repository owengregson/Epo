/**
 * The engine's park vocabulary. A failed follow-back reconciliation used to
 * park under `engine:enrich-backoff`, so a live log read "holding enrich-backoff"
 * while the real fault was the notifications read (2026-11-02). Each cause
 * now surfaces as itself.
 */
import { ENGINE_WAIT_CLASS, parkReasonFor } from '@/engine/engine-waits';

test('a reconciliation wait surfaces as its own long-park reason', () => {
  expect(parkReasonFor('engine:reconcile-backoff')).toBe('reconcile-backoff');
  expect(ENGINE_WAIT_CLASS['engine:reconcile-backoff']).toBe('retry-backoff');
});

test('enrichment walls keep their own reason', () => {
  expect(parkReasonFor('engine:enrich-backoff')).toBe('enrich-backoff');
});

test('a spent read allowance parks as itself, until its known reopen time (never a 2× retry stretch)', () => {
  expect(parkReasonFor('engine:read-budget-park')).toBe('read-budget');
  // Positive-only boundary offset: never wakes before the window reopens.
  expect(ENGINE_WAIT_CLASS['engine:read-budget-park']).toBe('daily-boundary');
});
