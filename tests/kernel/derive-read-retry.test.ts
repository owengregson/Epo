/**
 * The read retry's waits (spec §17.8, D4): derived from the envelope fetch's measured latency and the
 * retry bounds, never a literal; the ladder the effect policy declares stays inside the fetch deadline.
 */

import { EFFECT_POLICY } from '@/engine/effect-policy';
import { attempts, baseMs } from '@/engine/schedule';
import { retryWait, TAB, timeoutFor } from '@/kernel/derive';
import { READ_RETRY_MS } from '@/kernel/derive-read-retry';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { RUNTIME_POLICY } from '@/kernel/runtime-policy';

test('the first wait spreads the envelope fetch deadline over the retries; the cap is that deadline', () => {
  expect(READ_RETRY_MS.cap).toBe(timeoutFor('fetchEnvelope'));
  expect(READ_RETRY_MS.cap).toBe(TAB.FETCH_ABORT_MS);
  expect(READ_RETRY_MS.base).toBe(retryWait(READ_RETRY_MS.cap, RUNTIME_POLICY.READ_RETRY_ATTEMPTS));
});

test('every wait is longer than a typical fetch and no longer than the fetch deadline', () => {
  const ladder = EFFECT_POLICY['list-walk'].retry;
  expect(attempts(ladder)).toBe(RUNTIME_POLICY.READ_RETRY_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts(ladder); attempt += 1) {
    const wait = baseMs(ladder, attempt);
    expect(wait).toBeGreaterThan(EMPIRICAL.LATENCY.fetchEnvelope.p50);
    expect(wait).toBeLessThanOrEqual(READ_RETRY_MS.cap);
  }
  expect(baseMs(ladder, 2)).toBe(Math.min(READ_RETRY_MS.cap, READ_RETRY_MS.base * RUNTIME_POLICY.READ_RETRY_GROWTH));
});

test('both reads share the one ladder', () => {
  expect(EFFECT_POLICY.enrich.retry).toBe(EFFECT_POLICY['list-walk'].retry);
});
