/**
 * The one popover positioner. Every clamp/flip rule the tooltip, the tour card
 * and the graph tip used to implement separately is asserted here once.
 */
import { clampInto, place } from '@/renderer/lib/anchor';

const VIEWPORT = { w: 1000, h: 800 };
const SIZE = { w: 200, h: 100 };

describe('place — preferred side, then flip, then clamp', () => {
  it('sits above the anchor, centred, when there is room', () => {
    const at = place({ x: 400, y: 400, w: 100, h: 40 }, SIZE, VIEWPORT, { side: 'above' });
    expect(at).toEqual({ left: 350, top: 292 });
  });

  it("flips below when 'above' would leave the top gutter", () => {
    const at = place({ x: 400, y: 20, w: 100, h: 40 }, SIZE, VIEWPORT, { side: 'above' });
    expect(at.top).toBe(68); // 20 + 40 + 8
  });

  it('flip:false clamps instead of flipping (the tour keeps its pointing side)', () => {
    const at = place({ x: 400, y: 20, w: 100, h: 40 }, SIZE, VIEWPORT, {
      side: 'above',
      flip: false,
    });
    expect(at.top).toBe(8);
  });

  it("align:'start' left-aligns with the anchor instead of centring", () => {
    const at = place({ x: 400, y: 400, w: 100, h: 40 }, SIZE, VIEWPORT, {
      side: 'above',
      align: 'start',
    });
    expect(at.left).toBe(400);
  });

  it('never lets a right-side placement run past the viewport edge', () => {
    const at = place({ x: 950, y: 400, w: 40, h: 40 }, SIZE, VIEWPORT, { side: 'right' });
    expect(at.left).toBe(792); // 1000 - 200 - 8
  });

  it("'inside' centres on the anchor (the tour's huge targets)", () => {
    const at = place({ x: 200, y: 200, w: 400, h: 300 }, SIZE, VIEWPORT, { side: 'inside' });
    expect(at).toEqual({ left: 300, top: 300 });
  });

  it('the edge gutter wins over the far edge when the element cannot fit', () => {
    const at = place({ x: 0, y: 0, w: 10, h: 10 }, { w: 2000, h: 100 }, VIEWPORT, {
      side: 'below',
    });
    expect(at.left).toBe(8);
  });
});

describe('clampInto — a raw point kept inside its host', () => {
  it('pushes a bottom-right overflow back inside', () => {
    expect(clampInto({ left: 980, top: 780 }, SIZE, VIEWPORT, 4)).toEqual({
      left: 796,
      top: 696,
    });
  });

  it('leaves a point that already fits untouched', () => {
    expect(clampInto({ left: 100, top: 100 }, SIZE, VIEWPORT, 4)).toEqual({
      left: 100,
      top: 100,
    });
  });
});
