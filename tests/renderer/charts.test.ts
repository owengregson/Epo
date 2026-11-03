import { smoothPath } from '@/renderer/charts/catmull-rom';

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
