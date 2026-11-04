/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * NumberTicker arms one frame after mount (spec §12.7): the first value shows at once and never rolls, and
 * only a rise after that reports itself (the "+N" chip).
 */
import { act, render } from '@testing-library/preact';
import { NumberTicker } from '@/renderer/ui/NumberTicker';

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

describe('NumberTicker', () => {
  it('shows its first value without a roll, then arms', async () => {
    const { container } = render(<NumberTicker value={1284} />);
    const ticker = container.querySelector('.nt') as HTMLElement;
    expect(ticker.getAttribute('aria-label')).toBe('1,284');
    expect(ticker.classList.contains('is-armed')).toBe(false);
    const reel = container.querySelector('.nt-reel') as HTMLElement;
    expect(reel.style.transition).toBe('none');
    await act(frame);
    expect((container.querySelector('.nt') as HTMLElement).classList.contains('is-armed')).toBe(true);
  });

  it('reports a rise after it armed, never the first value or a fall', async () => {
    const rises: number[] = [];
    const onIncrease = (d: number): void => {
      rises.push(d);
    };
    const { rerender } = render(<NumberTicker value={10} signed onIncrease={onIncrease} />);
    rerender(<NumberTicker value={12} signed onIncrease={onIncrease} />);
    expect(rises).toEqual([]);
    await act(frame);
    rerender(<NumberTicker value={15} signed onIncrease={onIncrease} />);
    rerender(<NumberTicker value={14} signed onIncrease={onIncrease} />);
    expect(rises).toEqual([3]);
  });

  it('writes a loss with the true minus sign when asked', () => {
    const { container } = render(<NumberTicker value={-3} signed minus />);
    expect(container.querySelector('.nt')?.getAttribute('aria-label')).toBe('−3');
  });
});
