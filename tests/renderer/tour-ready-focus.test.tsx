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
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => { frames.set(++id, next); return id; });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  // Real Chromium refuses focus inside visibility:hidden. jsdom does not apply
  // the stylesheet, so model that browser boundary rather than permitting a false pass.
  const focus = HTMLElement.prototype.focus;
  jest.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    if (!this.closest('.tour-card.measuring')) focus.call(this, options);
  });
  const tick = async (): Promise<void> => {
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => { for (const frame of pending) frame(0); });
  };
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
    await tick();
    expect(document.activeElement).toBe(app.getByRole('button', { name: 'Take the tour' }));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(app.getByRole('button', { name: 'Skip the tour' }));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(app.getByRole('button', { name: 'Take the tour' }));
    fireEvent.click(app.getByRole('button', { name: 'Take the tour' }));
    await tick();
    expect(document.querySelector('.tour-card.measuring')).not.toBeNull();
    targets.push(target('now'));
    await tick();
    expect(document.querySelector('.tour-card.measuring')).toBeNull();
    await tick(); // The measured card's visible styles settle before focus.
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
    await tick();
    expect(document.activeElement).toBe(app.getByRole('button', { name: 'Finish' }));
    const outside = target('outside');
    outside.tabIndex = 0;
    targets.push(outside);
    outside.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(app.getByRole('button', { name: 'Skip the tour' }));
  } finally {
    app.unmount();
    targets.forEach((el) => {
      el.remove();
    });
    jest.restoreAllMocks();
  }
});

test('the one-shot handoff waits for computed visibility and cancels when the tour closes', async () => {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => { frames.set(++id, next); return id; });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  const tick = async (): Promise<void> => {
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => { for (const frame of pending) frame(0); });
  };
  const props = { onClose: jest.fn(), setStage: jest.fn(), steps: STEPS.slice(0, 1) };
  const app = render(<Tour open {...props} />);
  try {
    const button = app.getByRole('button', { name: 'Finish' });
    // The native regression had no .measuring class, but inherited computed
    // visibility was still hidden after commit and sometimes another frame.
    button.style.visibility = 'hidden';
    await tick();
    await tick();
    expect(document.activeElement).not.toBe(button);
    button.style.visibility = 'visible';
    await tick();
    expect(document.activeElement).toBe(button);
    expect(frames.size).toBe(0);
    app.rerender(<Tour open={false} {...props} />);
    app.rerender(<Tour open {...props} />);
    expect(frames.size).toBe(1);
    app.rerender(<Tour open={false} {...props} />);
    expect(frames.size).toBe(0);
    await tick();
    expect(document.activeElement).not.toBe(button);
  } finally {
    app.unmount();
    jest.restoreAllMocks();
  }
});
