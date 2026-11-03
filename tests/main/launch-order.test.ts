/**
 * The launch order (spec §12.8): the window is built hidden with the dashboard load held back; IPC is
 * registered before the dashboard loads; the dashboard's first load reveals the window (or the fallback
 * timer does); the updater status is no longer replayed on load (the renderer pulls it).
 */

const order: string[] = [];
let rendererLoad: (() => void) | null = null;
const shellOpts: Array<Record<string, unknown>> = [];

jest.mock('electron', () => ({ app: { getPath: () => '/tmp/epo-launch-test' } }));
jest.mock('@/main/window/shell', () => ({
  createAppShell: jest.fn((opts: Record<string, unknown>) => {
    shellOpts.push(opts);
    order.push('shell');
    return {
      win: { on: jest.fn() },
      tab: {},
      veil: {},
      igFirstLoad: Promise.resolve('ready'),
      setStage: jest.fn(),
      send: jest.fn((channel: string) => order.push(`send:${channel}`)),
      onRendererLoad: jest.fn((cb: () => void) => { rendererLoad = cb; }),
      loadDashboard: jest.fn(() => order.push('loadDashboard')),
      reveal: jest.fn(() => order.push('reveal')),
    };
  }),
}));
jest.mock('@/main/foundation-wiring', () => ({
  Foundation: jest.fn().mockImplementation(() => {
    order.push('foundation');
    return {
      tourPending: () => false,
      setTourHold: jest.fn(),
      setConnectivity: jest.fn(),
      restoreRuntimeIntent: jest.fn(async () => {}),
      landOnOwnProfile: jest.fn(async () => {}),
      startBoot: jest.fn(async () => { order.push('boot.start'); }),
      startScheduledPruneWatcher: jest.fn(),
      startEngineStepWatchdog: jest.fn(),
    };
  }),
}));
jest.mock('@/main/app', () => ({
  composeApp: jest.fn(async () => {
    order.push('composeApp');
    return { updater: { current: () => ({ state: 'idle' }) }, dispose: jest.fn() };
  }),
}));
jest.mock('@/main/ipc', () => ({ registerEpoIpc: jest.fn(() => { order.push('ipc'); return () => {}; }) }));
jest.mock('@/main/connectivity', () => ({
  ConnectivityMonitor: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn() })),
}));
jest.mock('@/main/services/ig-session', () => ({ electronIgSession: () => ({}) }));

import { BOOT } from '@/kernel/boot-policy';
import { type LaunchHandles, launchWindow } from '@/main/launch';

const handles = (): LaunchHandles => ({
  mainWindow: null, instagramTab: null, overlayVeil: null, foundation: null,
  disposeIpc: null, connectivityMonitor: null, composedApp: null,
});

beforeEach(() => {
  order.length = 0;
  shellOpts.length = 0;
  rendererLoad = null;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

test('hidden window, Foundation, modules, IPC, the dashboard load, then the boot sequence', async () => {
  await launchWindow({ handles: handles() });
  expect(shellOpts[0]).toMatchObject({ startHidden: true, deferDashboardLoad: true });
  expect(order.slice(0, 6)).toEqual(['shell', 'foundation', 'composeApp', 'ipc', 'loadDashboard', 'boot.start']);
});

test("the dashboard's first load reveals the window; nothing replays the updater status", async () => {
  await launchWindow({ handles: handles() });
  expect(order).not.toContain('reveal');
  rendererLoad?.();
  expect(order.filter((o) => o === 'reveal')).toHaveLength(1);
  expect(order).not.toContain('send:epo:update-status');
});

test('the fallback timer reveals a window whose dashboard never finishes loading', async () => {
  await launchWindow({ handles: handles() });
  jest.advanceTimersByTime(BOOT.SHOW_FALLBACK_MS - 1);
  expect(order).not.toContain('reveal');
  jest.advanceTimersByTime(1);
  expect(order).toContain('reveal');
});
