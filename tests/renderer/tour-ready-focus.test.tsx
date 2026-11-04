/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, fireEvent, render } from '@testing-library/preact';
import type { TourStep } from '@/renderer/tour/steps';
import { Tour } from '@/renderer/tour/Tour';

const STEPS: readonly TourStep[] = [
  { id: 'hello', title: 'Hello', body: 'Welcome.', stage: 'tab' },
  { id: 'now', title: 'Now', body: 'Your current status.', target: 'now', stage: 'tab' },
  { id: 'seed', title: 'Settings', body: 'Your starting account.', target: 'seed', stage: 'settings' },
];

test('each newly measured card receives focus once, without stealing focus during target tracking', async () => {
  let frame: FrameRequestCallback | undefined;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => { frame = next; return 1; });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  // Real Chromium refuses focus inside visibility:hidden. jsdom does not apply
  // the stylesheet, so model that browser boundary rather than permitting a false pass.
  const focus = HTMLElement.prototype.focus;
  jest.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    if (!this.closest('.tour-card.measuring')) focus.call(this, options);
  });
  const tick = async (): Promise<void> => { await act(async () => { frame?.(0); }); };
  let top = 120;
  const target = (token: string): HTMLElement => {
    const el = document.createElement('div');
    el.dataset.tour = token;
    el.getBoundingClientRect = () => ({ x: 500, y: top, width: 300, height: 100,
      top, bottom: top + 100, left: 500, right: 800, toJSON: () => ({}) });
    document.body.append(el);
    return el;
  };
  const app = render(<Tour open onClose={jest.fn()} setStage={jest.fn()} steps={STEPS} />);
  const targets: HTMLElement[] = [];
  try {
    expect(document.activeElement).toBe(app.getByRole('button', { name: 'Take the tour' }));
    fireEvent.click(app.getByRole('button', { name: 'Take the tour' }));
    await tick();
    expect(document.querySelector('.tour-card.measuring')).not.toBeNull();
    targets.push(target('now'));
    await tick();
    expect(document.querySelector('.tour-card.measuring')).toBeNull();
    expect(document.activeElement).toBe(app.getByRole('button', { name: 'Next' }));
    const back = app.getByRole('button', { name: 'Back' });
    back.focus();
    top = 200;
    await tick();
    expect(document.activeElement).toBe(back);
    fireEvent.click(app.getByRole('button', { name: 'Next' }));
    // The previous step's measurement must not make this different target ready.
    expect(document.querySelector('.tour-card.measuring')).not.toBeNull();
    await tick();
    targets.push(target('seed'));
    await tick();
    expect(document.activeElement).toBe(app.getByRole('button', { name: 'Finish' }));
  } finally {
    app.unmount();
    targets.forEach((el) => {
      el.remove();
    });
    jest.restoreAllMocks();
  }
});
