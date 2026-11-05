/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, render } from '@testing-library/preact';
import type { TourStep } from '@/renderer/tour/steps';
import { Tour } from '@/renderer/tour/Tour';

const STEPS: readonly TourStep[] = [{ id: 'settings', title: 'Make it yours', body: 'Choose a starting account.',
  target: 'seed', stage: 'settings', side: 'below' }];

test('a delayed, offscreen tour target is revealed once before measuring without taking button focus', async () => {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => { frames.set(++id, next); return id; });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  const tick = async () => {
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => { for (const frame of pending) frame(0); });
  };
  const target = document.createElement('div');
  target.dataset.tour = 'seed';
  let measurable = false;
  let top = 1_200;
  target.getBoundingClientRect = () => ({ x: 500, y: top, width: measurable ? 360 : 0, height: measurable ? 160 : 0,
    top, bottom: top + 160, left: 500, right: 860, toJSON: () => ({}) });
  const scroll = jest.fn(() => { top = 120; });
  target.scrollIntoView = scroll;
  const app = render(<Tour open onClose={jest.fn()} setStage={jest.fn()} steps={STEPS} />);
  try {
    await tick();
    expect(document.querySelector('.tour-ring')).toBeNull();
    document.body.append(target);
    await tick();
    expect(scroll).not.toHaveBeenCalled();
    measurable = true;
    await tick();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: 'start', inline: 'nearest', behavior: 'instant' });
    expect((document.querySelector('.tour-ring') as HTMLElement).style.top).toBe('114px');
    await tick();
    expect(document.activeElement).toBe(app.getByRole('button', { name: 'Finish' }));
    // Resize/layout tracking must update the ring without restarting the scroll.
    top = 170;
    await tick();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect((document.querySelector('.tour-ring') as HTMLElement).style.top).toBe('164px');
  } finally {
    app.unmount();
    target.remove();
    jest.restoreAllMocks();
  }
});
