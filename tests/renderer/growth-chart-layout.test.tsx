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

test('an in-flight reveal finishes across the resized plot instead of restoring its old clip', () => {
  const original = globalThis.ResizeObserver;
  let resize = (): void => {};
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resize = () => callback([], this); }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const request = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  const cancel = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((key) => { frames.delete(key); });
  try {
    const points = flat.map((p, i) => ({ ...p, cumulativeNet: i * 10 }));
    const { container, unmount } = render(<GrowthChart points={points} baselineAt={points[0].dayStartMs} />);
    const tick = (now: number): void => act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(now));
    });
    tick(0);
    tick(34);
    Object.defineProperty(container.firstElementChild, 'clientWidth', { value: 850, configurable: true });
    act(resize);
    for (let now = 68; now < 2200; now += 34) tick(now);
    expect(container.querySelector('clipPath rect')?.getAttribute('width')).toBe('804.0');
    expect(container.querySelector('.growth-dot')?.getAttribute('cx')).toBe('802.0');
    unmount();
  } finally {
    request.mockRestore();
    cancel.mockRestore();
    globalThis.ResizeObserver = original;
  }
});
