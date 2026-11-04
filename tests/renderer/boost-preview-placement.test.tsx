/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { settingsViewSignal } from '@/renderer/app/shell-context';
import { idleStatus, installFakeBridge } from '../kit/render-bridge';

const rect = (x: number, y: number, width: number, height: number): DOMRect => ({
  x, y, width, height, top: y, bottom: y + height, left: x, right: x + width, toJSON: () => ({}),
});

test.each([200, 489])('Boost preview clears a trigger at column y=%i and dismisses when its anchor moves', async (top) => {
  const bridge = installFakeBridge({ seed: 'someone', app: { tourCompletedAt: 1 } });
  bridge.data.status = idleStatus({ lastActionAt: Date.now() - 60_000 });
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('sb-boostcard') ? 120 : 0;
  });
  const app = render(<App />);
  try {
    await waitFor(() => expect(bridge.calls.some(([name]) => name === 'settingsView')).toBe(true));
    await act(async () => {});
    bridge.stub('previewBoost', { hours: 12, endsAt: Date.now() + 3_600_000, effectiveFrom: Date.now(),
      startsSessionNow: true, extraFollowsToday: 9, unfollowsWaiting: 6, why: 'ready' });
    await act(async () => {
      const view = settingsViewSignal.value;
      if (view !== null) settingsViewSignal.value = { ...view, capabilities: { ...view.capabilities, boost: true } };
    });
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>('.sb-btn--boost')?.disabled).toBe(false));
    await act(async () => {});
    const button = document.querySelector('.sb-btn--boost') as HTMLButtonElement;
    const column = document.querySelector('.sidebar') as HTMLElement;
    Object.defineProperty(column, 'clientHeight', { value: 584 });
    Object.defineProperty(column, 'clientWidth', { value: 460 });
    column.getBoundingClientRect = () => rect(0, 40, 460, 584);
    button.getBoundingClientRect = () => rect(180, 40 + top, 120, 36);
    await act(async () => { button.blur(); button.focus(); });
    const preview = document.querySelector('.sb-boostcard') as HTMLElement;
    expect(preview).not.toBeNull();
    const cardTop = Number.parseFloat(preview.style.top);
    expect(cardTop).toBeGreaterThanOrEqual(8);
    expect(cardTop + 120).toBeLessThanOrEqual(584 - 8);
    if (top === 200) expect(cardTop).toBeGreaterThanOrEqual(top + 36 + 8);
    else expect(cardTop + 120).toBeLessThanOrEqual(top - 8);

    await act(async () => { fireEvent.scroll(document.querySelector('.sb-middle') as HTMLElement); });
    expect(document.querySelector('.sb-boostcard')).toBeNull();
    await act(async () => { button.blur(); button.focus(); });
    expect(document.querySelector('.sb-boostcard')).not.toBeNull();
    await act(async () => { fireEvent.resize(window); });
    expect(document.querySelector('.sb-boostcard')).toBeNull();
    await act(async () => { button.blur(); button.focus(); });
    fireEvent.click(button);
    await waitFor(() => expect(bridge.calls.some(([name]) => name === 'startBoost')).toBe(true));
    expect(document.querySelector('.sb-boostcard')).toBeNull();
  } finally {
    app.unmount();
    jest.restoreAllMocks();
  }
});
