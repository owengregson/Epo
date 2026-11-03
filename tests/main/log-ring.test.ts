/**
 * The log ring (spec §12.9, Appendix C.3): it keeps the newest lines up to its capacity, oldest first, hands out
 * copies, and says whether a Diagnostics panel asked for the stream.
 */

import { DIAGNOSTICS } from '@/kernel/live-policy';
import { LogRing } from '@/main/modules/log-ring';
import type { LogEntry } from '@/shared/log-entry';

const line = (n: number): LogEntry => ({ level: 'info', message: `line ${n}`, at: n });

test('the newest lines up to the capacity, oldest first', () => {
  const ring = new LogRing(3);
  expect(ring.tail()).toEqual([]);
  for (let n = 1; n <= 5; n++) ring.add(line(n));
  expect(ring.tail()).toEqual([line(3), line(4), line(5)]);
});

test('the tail is a copy', () => {
  const ring = new LogRing(DIAGNOSTICS.LOG_RING);
  ring.add(line(1));
  const tail = ring.tail();
  tail.push(line(2));
  expect(ring.tail()).toEqual([line(1)]);
});

test('streaming starts off and follows the panel', () => {
  const ring = new LogRing(DIAGNOSTICS.LOG_RING);
  expect(ring.streaming()).toBe(false);
  ring.setStreaming(true);
  expect(ring.streaming()).toBe(true);
  ring.setStreaming(false);
  expect(ring.streaming()).toBe(false);
});

test('a full ring of the policy size keeps exactly that many lines', () => {
  const ring = new LogRing(DIAGNOSTICS.LOG_RING);
  for (let n = 0; n < DIAGNOSTICS.LOG_RING + 7; n++) ring.add(line(n));
  const tail = ring.tail();
  expect(tail).toHaveLength(DIAGNOSTICS.LOG_RING);
  expect(tail[0]).toEqual(line(7));
});
