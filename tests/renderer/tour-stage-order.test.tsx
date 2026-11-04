/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { options, render } from 'preact';
import { useState } from 'preact/hooks';
import { StageHost } from '@/renderer/app/StageHost';
import type { TourStep } from '@/renderer/tour/steps';
import { Tour } from '@/renderer/tour/Tour';
import type { StageMode } from '@/shared/stage-mode';

const STEPS: readonly TourStep[] = [{ id: 'settings', title: 'Make it yours', body: 'Choose a starting account.',
  target: 'seed', stage: 'settings', side: 'below' }];

test('replaying the tour on cached Settings keeps its target visible after activation effects', () => {
  // Keep browser frames and after-paint effects distinct: act() normally drains
  // both together and hides the race between a reveal and a later scroll reset.
  const previous = { render: options.debounceRendering, effects: options.requestAnimationFrame };
  const renders: Array<() => void> = [];
  const effects: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  options.debounceRendering = (cb) => renders.push(cb);
  options.requestAnimationFrame = (cb) => effects.push(cb);
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.set(++frameId, cb); return frameId; });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  const drain = (queue: Array<() => void>) => { while (queue.length > 0) queue.shift()?.(); };
  let showGraph = () => {};
  let openTour = () => {};
  function Shell() {
    const [stage, setStage] = useState<StageMode>('settings');
    const [open, setOpen] = useState(false);
    showGraph = () => setStage('graph');
    openTour = () => setOpen(true);
    return <>
      <StageHost mode="settings" active={stage === 'settings'} mount="lazy">
        <div class="stage-page"><div data-tour="seed">Starting account</div></div>
      </StageHost>
      <Tour open={open} onClose={() => setOpen(false)} setStage={setStage} steps={STEPS} />
    </>;
  }
  const root = document.createElement('div');
  document.body.append(root);
  try {
    render(<Shell />, root);
    drain(effects);
    const host = root.querySelector('[data-stage="settings"]') as HTMLElement;
    const target = root.querySelector('[data-tour="seed"]') as HTMLElement;
    target.getBoundingClientRect = () => {
      const top = 1_200 - host.scrollTop;
      return { x: 500, y: top, width: host.hidden ? 0 : 360, height: host.hidden ? 0 : 160,
        top, bottom: top + 160, left: 500, right: 860, toJSON: () => ({}) };
    };
    const scroll = jest.fn(() => { host.scrollTop = 1_100; });
    target.scrollIntoView = scroll;
    showGraph();
    drain(renders);
    drain(effects);
    expect(host.hidden).toBe(true);
    openTour();
    drain(renders);
    drain(effects); // Tour requests Settings and schedules its first frame.
    drain(renders); // The cached Settings DOM is visible before after-paint effects.
    expect(host.hidden).toBe(false);
    const readyFrames = [...frames.values()];
    frames.clear();
    for (const frame of readyFrames) frame(0);
    drain(renders);
    expect(scroll).toHaveBeenCalledTimes(1);
    drain(effects); // A late activation reset must not undo the one-shot reveal.
    expect(host.scrollTop).toBe(1_100);
    expect(target.getBoundingClientRect().top).toBe(100);
    expect(document.activeElement).toBe(root.querySelector('.tour-next'));
  } finally {
    render(null, root);
    root.remove();
    options.debounceRendering = previous.render;
    options.requestAnimationFrame = previous.effects;
    jest.restoreAllMocks();
  }
});
