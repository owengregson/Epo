/**
 * The shell's additive options (spec §12.8, ADR 1007 amendment): the defaults are today's window — shown at
 * construction, maximized there, dashboard loaded at once — and `startHidden` / `deferDashboardLoad` move the
 * show and the load behind `reveal()` / `loadDashboard()`. The stacking order never changes.
 */

const calls: string[] = [];
const windows: Array<Record<string, jest.Mock> & { opts: Record<string, unknown> }> = [];
const views: Array<{ webContents: Record<string, jest.Mock>; setBackgroundColor: jest.Mock; setBounds: jest.Mock }> = [];
let tabGoto: () => Promise<void> = async () => {};
let maximized = false;

jest.mock('electron', () => ({
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }] },
  BaseWindow: jest.fn().mockImplementation((opts: Record<string, unknown>) => {
    const win = {
      opts,
      on: jest.fn(),
      maximize: jest.fn(() => calls.push('maximize')),
      show: jest.fn(() => calls.push('show')),
      focus: jest.fn(() => calls.push('focus')),
      isDestroyed: jest.fn(() => false),
      isMaximized: jest.fn(() => false),
      getNormalBounds: jest.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
      getContentBounds: jest.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
      contentView: { addChildView: jest.fn(() => calls.push('add:dashboard')) },
    };
    windows.push(win as never);
    return win;
  }),
  WebContentsView: jest.fn().mockImplementation(() => {
    const view = {
      setBackgroundColor: jest.fn(),
      setBounds: jest.fn(),
      webContents: {
        loadFile: jest.fn(async () => { calls.push('load:dashboard'); }),
        on: jest.fn(),
        send: jest.fn(),
        isDestroyed: jest.fn(() => false),
        setVisualZoomLevelLimits: jest.fn(async () => {}),
      },
    };
    views.push(view as never);
    return view;
  }),
}));

jest.mock('@/adapter/tab', () => ({
  IG_HOME_URL: 'https://www.instagram.com/',
  InstagramTab: jest.fn().mockImplementation(() => ({
    attach: jest.fn(() => calls.push('add:tab')),
    goto: jest.fn(() => tabGoto()),
    setBounds: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
  })),
}));

jest.mock('@/main/overlay/veil-view', () => ({
  OverlayVeil: jest.fn().mockImplementation(() => ({
    attach: jest.fn(() => calls.push('add:veil')),
    setBounds: jest.fn(),
    setObscured: jest.fn(),
  })),
}));

jest.mock('@/main/window-state', () => ({
  MIN_WINDOW: { width: 900, height: 600 },
  loadWindowState: () => ({ width: 1200, height: 800, maximized }),
  saveWindowState: jest.fn(),
}));

import { createAppShell } from '@/main/window/shell';

beforeEach(() => {
  calls.length = 0;
  windows.length = 0;
  views.length = 0;
  tabGoto = async () => {};
  maximized = false;
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("the defaults are today's: shown and maximized at construction, the dashboard loaded at once", async () => {
  maximized = true;
  createAppShell({ windowStateFile: '/tmp/none.json' });
  await flush();
  expect(windows[0].opts.show).not.toBe(false);
  // The recovery wrapper starts the load on the next microtask, after the views are stacked.
  expect(calls).toEqual(['maximize', 'add:dashboard', 'add:tab', 'add:veil', 'load:dashboard']);
});

test('the window and the dashboard paint the graphite background, and the dashboard never zooms', () => {
  createAppShell({ windowStateFile: '/tmp/none.json' });
  expect(windows[0].opts.backgroundColor).toBe('#0d0d0f');
  expect(views[0].setBackgroundColor).toHaveBeenCalledWith('#0d0d0f');
  expect(views[0].webContents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);
});

test('startHidden constructs the window hidden and reveal() maximizes it once, then focuses', () => {
  maximized = true;
  const shell = createAppShell({ windowStateFile: '/tmp/none.json', startHidden: true });
  expect(windows[0].opts.show).toBe(false);
  expect(calls).not.toContain('maximize');
  shell.reveal();
  shell.reveal();
  expect(calls.filter((c) => c === 'maximize' || c === 'show' || c === 'focus')).toEqual(['maximize', 'focus']);
});

test('a hidden window whose saved state is not maximized is shown by reveal()', () => {
  const shell = createAppShell({ windowStateFile: '/tmp/none.json', startHidden: true });
  shell.reveal();
  expect(calls.filter((c) => c === 'maximize' || c === 'show' || c === 'focus')).toEqual(['show', 'focus']);
});

test('deferDashboardLoad holds the page until loadDashboard(), which loads it exactly once', async () => {
  const shell = createAppShell({ windowStateFile: '/tmp/none.json', startHidden: true, deferDashboardLoad: true });
  await flush();
  expect(calls).toEqual(['add:dashboard', 'add:tab', 'add:veil']);
  shell.loadDashboard();
  shell.loadDashboard();
  await flush();
  expect(calls.filter((c) => c === 'load:dashboard')).toHaveLength(1);
});

test('igFirstLoad settles ready after the home load and failed when it throws', async () => {
  expect(await createAppShell({ windowStateFile: '/tmp/none.json' }).igFirstLoad).toBe('ready');
  tabGoto = async () => { throw new Error('offline'); };
  expect(await createAppShell({ windowStateFile: '/tmp/none.json' }).igFirstLoad).toBe('failed');
});
