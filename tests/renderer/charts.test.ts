import { computeProjection, projNet, pnoise } from '@/renderer/charts/growth-model';
import { smoothPath } from '@/renderer/charts/catmull-rom';

describe('growth-model', () => {
  const base = {
    rate: 55,
    yieldMult: 1,
    privateBoost: 0.15,
    bandWidth: 0.6,
    waitDays: 4,
    holdDays: 2,
    days: 30,
  };

  it('returns three scenarios with one point per day', () => {
    const r = computeProjection(base);
    expect(r.scenarios).toHaveLength(3);
    for (const s of r.scenarios) expect(s.pts).toHaveLength(31);
    expect(r.days).toBe(30);
  });

  it('orders endpoints cautious ≤ expected ≤ optimistic and sets vmax to the optimistic end', () => {
    const [bad, avg, good] = computeProjection(base).scenarios;
    expect(bad.end).toBeLessThanOrEqual(avg.end);
    expect(avg.end).toBeLessThanOrEqual(good.end);
    expect(computeProjection(base).vmax).toBeCloseTo(Math.max(1, good.end));
  });

  it('starts at zero net and grows with a higher yield multiplier', () => {
    const low = computeProjection({ ...base, yieldMult: 0.5 });
    const high = computeProjection({ ...base, yieldMult: 1.5 });
    // smooth endpoint (noise-free) grows with yield
    expect(high.scenarios[2].end).toBeGreaterThan(low.scenarios[2].end);
    // projNet at t=0 is exactly 0
    expect(projNet(0, base.rate, 0.2, 0.66, 6)).toBe(0);
  });

  it('fans the scenarios out more as the yield scalar rises (super-linear spread)', () => {
    const spread = (m: number): number => {
      const s = computeProjection({ ...base, yieldMult: m }).scenarios;
      return s[2].end - s[0].end;
    };
    expect(spread(1.5)).toBeGreaterThan(spread(1.0));
    expect(spread(1.0)).toBeGreaterThan(spread(0.6));
  });

  it('pnoise is deterministic and bounded to [-1, 1]', () => {
    expect(pnoise(7)).toBe(pnoise(7));
    for (let i = 0; i < 200; i++) {
      const n = pnoise(i);
      expect(n).toBeGreaterThanOrEqual(-1);
      expect(n).toBeLessThanOrEqual(1);
    }
  });
});

describe('smoothPath', () => {
  it('handles empty and single points', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([[1, 2]])).toBe('M1.0,2.0');
  });

  it('produces a cubic path starting at the first point', () => {
    const d = smoothPath([
      [0, 0],
      [10, 5],
      [20, 2],
    ]);
    expect(d.startsWith('M0.0,0.0')).toBe(true);
    expect(d).toContain('C');
  });
});
