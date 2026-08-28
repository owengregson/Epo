import {
  accumulateFrame,
  easeInOutCubic,
  GROWTH_REVEAL_DELAY_MS,
  GROWTH_REVEAL_DUR_MS,
  GROWTH_REVEAL_MAX_FRAME_MS,
} from '@/renderer/lib/motion';

describe('accumulateFrame (capped reveal accumulator)', () => {
  it('contributes nothing on the first frame (no previous timestamp)', () => {
    expect(accumulateFrame(0, null, 123456.7)).toBe(0);
    expect(accumulateFrame(250, null, 99999)).toBe(250);
  });

  it('adds the real delta for an ordinary frame', () => {
    expect(accumulateFrame(100, 1000, 1016)).toBe(116);
    expect(accumulateFrame(0, 5000, 5008.4)).toBeCloseTo(8.4, 10);
  });

  it('caps a stalled frame at GROWTH_REVEAL_MAX_FRAME_MS', () => {
    // A 500ms main-thread stall (whole-App re-render, view-enter teardown)
    // must slow the draw, never materialize the skipped span in one frame.
    expect(accumulateFrame(100, 1000, 1500)).toBe(100 + GROWTH_REVEAL_MAX_FRAME_MS);
  });

  it('a stall longer than the whole tween cannot finish the reveal in one frame', () => {
    const stallTs = GROWTH_REVEAL_DELAY_MS + GROWTH_REVEAL_DUR_MS + 5000;
    const after = accumulateFrame(0, 0, stallTs);
    expect(after).toBe(GROWTH_REVEAL_MAX_FRAME_MS);
    expect(after).toBeLessThan(GROWTH_REVEAL_DELAY_MS + GROWTH_REVEAL_DUR_MS);
  });

  it('ignores non-increasing timestamps (clock anomalies never rewind progress)', () => {
    expect(accumulateFrame(100, 1000, 990)).toBe(100);
    expect(accumulateFrame(100, 1000, 1000)).toBe(100);
  });

  it('accumulates monotonically across a frame sequence with mixed stalls', () => {
    const frames = [0, 16, 32, 700, 716, 2000];
    let elapsed = 0;
    let last: number | null = null;
    const seen: number[] = [];
    for (const ts of frames) {
      elapsed = accumulateFrame(elapsed, last, ts);
      last = ts;
      seen.push(elapsed);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    // 16 + 16 + cap + 16 + cap
    expect(elapsed).toBe(16 + 16 + GROWTH_REVEAL_MAX_FRAME_MS + 16 + GROWTH_REVEAL_MAX_FRAME_MS);
  });
});

describe('easeInOutCubic (reveal curve)', () => {
  it('pins the endpoints and midpoint', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it('enters gently — no 3×-speed jump out of the hold', () => {
    // easeOutCubic left the hold at derivative 3; the replacement's first 5%
    // of time must cover well under 5% of the path.
    expect(easeInOutCubic(0.05)).toBeLessThan(0.05);
    expect(easeInOutCubic(0.05)).toBeCloseTo(4 * 0.05 ** 3, 10);
  });

  it('settles the tail symmetrically', () => {
    expect(easeInOutCubic(0.95)).toBeGreaterThan(0.95);
    expect(1 - easeInOutCubic(0.95)).toBeCloseTo(easeInOutCubic(0.05), 10);
  });

  it('is monotonic across the domain', () => {
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = easeInOutCubic(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
