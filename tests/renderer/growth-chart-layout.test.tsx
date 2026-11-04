/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, render, screen } from '@testing-library/preact';
import { GrowthChart } from '@/renderer/charts/GrowthChart';

const flat = [
  { dayStartMs: 1_700_000_000_000, cumulativeNet: 0 },
  { dayStartMs: 1_700_086_400_000, cumulativeNet: 0 },
];

test('absent history has an explanation without invented axes or empty date labels', () => {
  const { container } = render(<GrowthChart points={[]} baselineAt={null} />);
  expect(screen.getByText(/No follower history yet/)).toBeTruthy();
  expect(container.querySelector('svg')).toBeNull();
  expect(container.querySelector('.growth-x')).toBeNull();
});

test('measured zero change remains a dated chart, distinct from absent history', () => {
  const { container } = render(<GrowthChart points={flat} baselineAt={flat[0].dayStartMs} />);
  expect(screen.getByText('No change in this range')).toBeTruthy();
  expect(container.querySelector('svg')).not.toBeNull();
  expect(container.querySelector('.growth-x')?.textContent).not.toContain('—');
});

test('resizing changes plot coordinates while retaining CSS-pixel axes and disconnects observation', () => {
  const original = globalThis.ResizeObserver;
  let resize = (): void => {};
  const disconnect = jest.fn();
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resize = () => callback([], this); }
    observe(): void {}
    unobserve(): void {}
    disconnect = disconnect;
  };
  try {
    const { container, unmount } = render(<GrowthChart points={flat} baselineAt={flat[0].dayStartMs} />);
    const host = container.firstElementChild as HTMLElement;
    Object.defineProperty(host, 'clientWidth', { value: 850, configurable: true });
    act(resize);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 850 180');
    expect(container.querySelector('.growth-grid')?.getAttribute('x2')).toBe('802');
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.ResizeObserver = original;
  }
});
