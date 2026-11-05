import fc from 'fast-check';
import type { FollowEvent } from '@/adapter/surface-types';
import {
  advanceWatermark, classifyBody, eventKey, type FeedWatermark, gapOf, reached,
} from '@/rim/feed-watermark';

const NOW = 2_000_000_000_000;
const TOL = 5 * 60_000;

const arbEvent: fc.Arbitrary<FollowEvent> = fc.record({
  pk: fc.constantFrom('1', '2', '3', '4', '5', '6'),
  username: fc.constant(null),
  atMs: fc.option(fc.integer({ min: NOW - 1_000_000, max: NOW + 2 * TOL }), { nil: null }),
});
const arbBody = fc.array(arbEvent, { maxLength: 12 });
const arbWatermark: fc.Arbitrary<FeedWatermark | null> = fc.option(fc.record({
  atMs: fc.integer({ min: NOW - 1_000_000, max: NOW }),
  keysAtMs: fc.constant([] as string[]),
  readAt: fc.constant(NOW - 1),
  filteredAt: fc.constant(null),
  gap: fc.constant(null),
}), { nil: null });

describe('L9: the drawer watermark', () => {
  test('a body replayed after its pass hands nothing over again (idempotence)', () => {
    fc.assert(fc.property(arbWatermark, arbBody, (w, body) => {
      const first = classifyBody(body, w, NOW, TOL);
      const next = advanceWatermark(w, first.fresh, NOW, false, null);
      expect(classifyBody(body, next, NOW, TOL).fresh).toEqual([]);
    }));
  });

  test('every dated event past the watermark is fresh; nothing at or below it is', () => {
    fc.assert(fc.property(arbWatermark, arbBody, (w, body) => {
      const { fresh } = classifyBody(body, w, NOW, TOL);
      for (const e of body) {
        if (e.atMs === null || e.atMs > NOW + TOL) continue;
        const beyond = w === null || e.atMs > w.atMs;
        expect(fresh.includes(e)).toBe(beyond || (e.atMs === w?.atMs && !w.keysAtMs.includes(eventKey(e))));
      }
    }));
  });

  test('the watermark never moves back, and later passes keep its keys at the same instant', () => {
    fc.assert(fc.property(arbWatermark, arbBody, arbBody, (w, a, b) => {
      const one = advanceWatermark(w, classifyBody(a, w, NOW, TOL).fresh, NOW, false, null);
      const two = advanceWatermark(one, classifyBody(b, one, NOW, TOL).fresh, NOW, false, null);
      expect(one.atMs).toBeGreaterThanOrEqual(w?.atMs ?? 0);
      expect(two.atMs).toBeGreaterThanOrEqual(one.atMs);
      if (two.atMs === one.atMs) for (const k of one.keysAtMs) expect(two.keysAtMs).toContain(k);
    }));
  });

  test('a time later than the local clock allows is undated, never a watermark', () => {
    const late: FollowEvent = { pk: '9', username: 'x', atMs: NOW + TOL + 1 };
    const c = classifyBody([late], null, NOW, TOL);
    expect(c.fresh).toEqual([]);
    expect(c.undated).toEqual([late]);
    expect(advanceWatermark(null, c.fresh, NOW, false, null).atMs).toBe(0);
  });

  test('a tie at the watermark instant is fresh only for an unseen key', () => {
    const w = advanceWatermark(null, [{ pk: '1', username: null, atMs: NOW - 10 }], NOW - 5, false, null);
    const c = classifyBody([{ pk: '1', username: null, atMs: NOW - 10 }, { pk: '2', username: null, atMs: NOW - 10 }],
      w, NOW, TOL);
    expect(c.fresh.map((e) => e.pk)).toEqual(['2']);
  });
});

describe('reached and the gap', () => {
  const w: FeedWatermark = { atMs: 1_000, keysAtMs: [], readAt: 5, filteredAt: null, gap: null };

  test('no watermark or nothing dated is reached; an oldest event above it is not', () => {
    expect(reached(null, 5_000)).toBe(true);
    expect(reached(w, null)).toBe(true);
    expect(reached(w, 1_000)).toBe(true);
    expect(reached(w, 1_001)).toBe(false);
  });

  test('an unreached pass records the span it left, merged with an older one the head walk still owes', () => {
    expect(gapOf(w, 1_000)).toBeNull();
    expect(gapOf(w, 3_000)).toEqual({ fromAtMs: 1_000, toAtMs: 3_000 });
    const owed = { ...w, gap: { fromAtMs: 500, toAtMs: 900 } };
    expect(advanceWatermark(owed, [], 9, false, { fromAtMs: 1_000, toAtMs: 3_000 }).gap)
      .toEqual({ fromAtMs: 500, toAtMs: 3_000 });
    expect(advanceWatermark(owed, [], 9, false, null).gap).toEqual({ fromAtMs: 500, toAtMs: 900 });
  });

  test('the filtered stamp moves only on a pass that read a post-chip body', () => {
    expect(advanceWatermark(w, [], 9, true, null).filteredAt).toBe(9);
    expect(advanceWatermark({ ...w, filteredAt: 4 }, [], 9, false, null).filteredAt).toBe(4);
  });
});
