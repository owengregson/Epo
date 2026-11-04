/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * Diagnostics (spec §12.9, owner Q30): the panel pulls main's log tail on mount and streams new lines only
 * while it is mounted; it filters by level, searches, pauses, copies and opens the log folder; incidents
 * read in plain words with their codes beside them.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { DIAGNOSTICS } from '@/kernel/live-policy';
import { ShellContext, type ShellServices, statusSignal } from '@/renderer/app/shell-context';
import { DiagnosticsPanel } from '@/renderer/diagnostics/DiagnosticsPanel';
import { LOG_SHOWN_MAX } from '@/renderer/diagnostics/useLogTail';
import type { LogEntry } from '@/shared/log-entry';
import { type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const T = Date.now();
const line = (level: LogEntry['level'], message: string, ago: number): LogEntry => ({ level, message, at: T - ago });
const TAIL: LogEntry[] = [line('info', 'engine started', 3_000), line('warn', 'slow page load', 2_000), line('error', 'read failed', 1_000)];

let bridge: FakeBridge;
const toasts: Array<[string, string]> = [];
const services: ShellServices = { confirm: () => Promise.resolve(true), toast: (kind, message) => toasts.push([kind, message]) };

beforeEach(() => {
  bridge = installFakeBridge({ app: { tourCompletedAt: 1 } });
  bridge.stub('logTail', TAIL);
  toasts.length = 0;
});

async function mount(): Promise<() => void> {
  const view = render(
    <ShellContext.Provider value={services}>
      <DiagnosticsPanel />
    </ShellContext.Provider>,
  );
  await act(async () => {});
  return view.unmount;
}

const lines = (): string[] => [...document.querySelectorAll('.diag-log li .diag-msg')].map((el) => el.textContent ?? '');
const calls = (method: string): unknown[][] => bridge.calls.filter((c) => c[0] === method);

describe('the Diagnostics panel', () => {
  it('shows as many lines as main keeps', () => {
    expect(LOG_SHOWN_MAX).toBe(DIAGNOSTICS.LOG_RING);
  });

  it('pulls the tail on mount and streams only while mounted', async () => {
    const unmount = await mount();
    expect(lines()).toEqual(['engine started', 'slow page load', 'read failed']);
    expect(calls('setLogStream')).toEqual([['setLogStream', true]]);
    await act(async () => bridge.emit('log', line('info', 'step done', 0)));
    expect(lines().at(-1)).toBe('step done');
    unmount();
    expect(calls('setLogStream').at(-1)).toEqual(['setLogStream', false]);
  });

  it('filters by level and searches', async () => {
    await mount();
    await act(async () => {
      fireEvent.click([...document.querySelectorAll('.diag-levels button')].find((b) => b.textContent === 'Warnings') as Element);
    });
    expect(lines()).toEqual(['slow page load', 'read failed']);
    await act(async () => {
      fireEvent.input(document.querySelector('.diag-search') as HTMLInputElement, { target: { value: 'READ' } });
    });
    expect(lines()).toEqual(['read failed']);
  });

  it('pause holds the view still until resume', async () => {
    await mount();
    const pause = (): HTMLButtonElement => [...document.querySelectorAll('.diag-bar .tbtn')][0] as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(pause());
    });
    await act(async () => bridge.emit('log', line('info', 'while paused', 0)));
    expect(lines()).not.toContain('while paused');
    await act(async () => {
      fireEvent.click(pause());
    });
    expect(lines()).toContain('while paused');
  });

  it('copies the shown lines and opens the log folder', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount();
    await act(async () => {
      fireEvent.click([...document.querySelectorAll('.diag-bar .tbtn')].find((b) => b.textContent === 'Copy') as Element);
    });
    await waitFor(() => expect(toasts).toEqual([['success', 'Log copied.']]));
    expect(String((writeText.mock.calls[0] as unknown[])[0])).toContain('ERROR read failed');
    await act(async () => {
      fireEvent.click([...document.querySelectorAll('.diag-bar .tbtn')].find((b) => b.textContent === 'Open log folder') as Element);
    });
    expect(calls('openLogFolder')).toHaveLength(1);
  });

  it('reads incidents in plain words with their codes beside them', async () => {
    statusSignal.value = idleStatus({
      runtime: {
        desired: 'stopped', phase: 'ready', blockedReason: null, lastProgressAt: null, progressPhase: null,
        incidents: [{ at: T - 60_000, reason: 'tab-recovery-failed' }, { at: T, reason: 'something-new', detail: 'x' }],
      },
    });
    await mount();
    const items = [...document.querySelectorAll('.diag-incidents li')].map((li) => li.textContent ?? '');
    expect(items[0]).toContain('something-new · x');
    expect(items[1]).toContain('The Instagram page didn’t recover by itself.');
    expect(items[1]).toContain('tab-recovery-failed');
  });
});
