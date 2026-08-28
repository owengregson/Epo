/**
 * Tab health eventing (cdp-detach-undetected fix). A Chromium-side debugger
 * detach, a renderer crash, or a hung renderer used to be observed by NOTHING:
 * onResponse consumers just went quiet forever and input silently fell back to
 * the focus-dependent transport. The tab must now mark itself unhealthy and
 * fire the `onUnhealthy` callback on every such event — and `recoverTab()`
 * must clear the mark and RE-ARM the listeners so the next event reports too.
 *
 * Electron is mocked at module scope with a small event-keyed emitter so tests
 * can fire `detach` / `render-process-gone` / `unresponsive` like Chromium
 * would, and flip the debugger's attached state to force the input fallback.
 */

jest.mock('electron', () => {
  type Handler = (...args: unknown[]) => void;
  const makeEmitter = () => {
    const listeners = new Map<string, Handler[]>();
    return {
      add(event: string, fn: Handler): void {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
      },
      remove(event: string, fn: Handler): void {
        const list = listeners.get(event) ?? [];
        listeners.set(
          event,
          list.filter((f) => f !== fn),
        );
      },
      emit(event: string, ...args: unknown[]): void {
        for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
      },
      count(event: string): number {
        return (listeners.get(event) ?? []).length;
      },
      reset(): void {
        listeners.clear();
      },
    };
  };

  const wcEvents = makeEmitter();
  const dbgEvents = makeEmitter();
  const state = {
    attached: false,
    inputEvents: [] as unknown[],
    reloads: 0,
    wcEvents,
    dbgEvents,
  };
  const dbg = {
    isAttached: (): boolean => state.attached,
    attach: (): void => {
      state.attached = true;
    },
    detach: (): void => {
      state.attached = false;
    },
    on: (event: string, fn: Handler): void => dbgEvents.add(event, fn),
    removeListener: (event: string, fn: Handler): void => dbgEvents.remove(event, fn),
    sendCommand: async (): Promise<unknown> => ({}),
  };
  const webContents = {
    setUserAgent: (): void => {},
    isDestroyed: (): boolean => false,
    loadURL: async (): Promise<void> => {},
    executeJavaScript: async (code: string): Promise<unknown> =>
      code.includes('1 + 1') ? 2 : 7, // canary: echo ok, then 7 rAF ticks
    on: (event: string, fn: Handler): void => wcEvents.add(event, fn),
    once: (event: string, fn: Handler): void => {
      const wrapped: Handler = (...args) => {
        wcEvents.remove(event, wrapped);
        fn(...args);
      };
      wcEvents.add(event, wrapped);
    },
    removeListener: (event: string, fn: Handler): void => wcEvents.remove(event, fn),
    reload: (): void => {
      state.reloads += 1;
      // A real reload settles asynchronously; recoverTab waits (bounded) on it.
      setTimeout(() => wcEvents.emit('did-stop-loading'), 0);
    },
    sendInputEvent: (event: unknown): void => {
      state.inputEvents.push(event);
    },
    debugger: dbg,
  };
  class WebContentsView {
    webContents = webContents;
  }
  return {
    session: { fromPartition: () => ({ setUserAgent: (): void => {} }) },
    WebContentsView,
    __tabMock: state,
  };
});

import { InstagramTab } from '@/adapter/tab';
import { setLevel } from '@/utils/logger';

interface Emitter {
  emit(event: string, ...args: unknown[]): void;
  count(event: string): number;
  reset(): void;
}

interface TabMockState {
  attached: boolean;
  inputEvents: unknown[];
  reloads: number;
  wcEvents: Emitter;
  dbgEvents: Emitter;
}

const mock = (jest.requireMock('electron') as { __tabMock: TabMockState }).__tabMock;

const SHORT_MS = 50;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fresh attached tab + a recorder for its onUnhealthy events. */
async function makeAttachedTab(): Promise<{ tab: InstagramTab; reasons: string[] }> {
  const tab = new InstagramTab({
    timeouts: { gotoMs: SHORT_MS, evaluateMs: SHORT_MS, getBodyMs: SHORT_MS },
  });
  const reasons: string[] = [];
  tab.onUnhealthy((reason) => reasons.push(reason));
  tab.attach({ contentView: { addChildView: (): void => {} } } as never);
  await flush(); // let Network.enable settle debuggerReady
  return { tab, reasons };
}

beforeAll(() => setLevel('error'));

beforeEach(() => {
  mock.attached = false;
  mock.inputEvents.length = 0;
  mock.reloads = 0;
  // Each test builds a fresh tab over the one shared mock — drop the previous
  // tab's listeners so events (and listener counts) stay per-test.
  mock.wcEvents.reset();
  mock.dbgEvents.reset();
});

describe('health events mark the tab unhealthy and fire onUnhealthy', () => {
  test('a Chromium-side debugger detach fires onUnhealthy with the reason', async () => {
    const { tab, reasons } = await makeAttachedTab();
    expect(tab.isMarkedUnhealthy()).toBe(false);

    mock.dbgEvents.emit('detach', null, 'target closed');

    expect(reasons).toEqual(['debugger-detach:target closed']);
    expect(tab.isMarkedUnhealthy()).toBe(true);
  });

  test('render-process-gone fires onUnhealthy with the crash reason', async () => {
    const { tab, reasons } = await makeAttachedTab();

    mock.wcEvents.emit('render-process-gone', null, { reason: 'oom' });

    expect(reasons).toEqual(['render-process-gone:oom']);
    expect(tab.isMarkedUnhealthy()).toBe(true);
  });

  test('unresponsive fires onUnhealthy', async () => {
    const { tab, reasons } = await makeAttachedTab();

    mock.wcEvents.emit('unresponsive');

    expect(reasons).toEqual(['unresponsive']);
    expect(tab.isMarkedUnhealthy()).toBe(true);
  });

  test('checkHealth reports unhealthy while a mark stands, even with live rAF', async () => {
    const { tab } = await makeAttachedTab();
    // Baseline: the canary alone says healthy (echo ok + rAF ticks).
    await expect(tab.checkHealth(1)).resolves.toMatchObject({ healthy: true, evaluateOk: true });

    mock.dbgEvents.emit('detach', null, 'target closed');

    // The renderer still ticks, but the CDP layer is dead — unhealthy.
    const health = await tab.checkHealth(1);
    expect(health.healthy).toBe(false);
    expect(health.evaluateOk).toBe(true);
    expect(health.rafTicks).toBeGreaterThan(0);
  });
});

describe('input fallback is a health event, once per attach epoch', () => {
  test('first CDP→webContents fallback fires onUnhealthy(input-fallback); repeats do not', async () => {
    const { tab, reasons } = await makeAttachedTab();
    // Kill the CDP transport out from under the input path.
    mock.attached = false;

    tab.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 } as never);
    await flush();
    tab.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 } as never);
    await flush();

    // Both events were still dispatched through the fallback transport…
    expect(mock.inputEvents).toHaveLength(2);
    // …but the health event fired exactly ONCE for the whole session.
    expect(reasons).toEqual(['input-fallback']);
    expect(tab.isMarkedUnhealthy()).toBe(true);
  });
});

describe('recoverTab clears the mark and re-arms everything', () => {
  test('recovery clears the unhealthy mark without firing a deliberate-detach event', async () => {
    const { tab, reasons } = await makeAttachedTab();
    mock.dbgEvents.emit('detach', null, 'target closed');
    expect(tab.isMarkedUnhealthy()).toBe(true);
    expect(reasons).toHaveLength(1);

    await tab.recoverTab();

    // Reloaded, re-attached, mark cleared — and recoverTab's own deliberate
    // detach fired NO extra health event.
    expect(mock.reloads).toBe(1);
    expect(mock.attached).toBe(true);
    expect(tab.isMarkedUnhealthy()).toBe(false);
    expect(reasons).toHaveLength(1);
  });

  test('the detach listener is re-registered: a post-recovery detach fires again', async () => {
    const { tab, reasons } = await makeAttachedTab();
    mock.dbgEvents.emit('detach', null, 'target closed');
    await tab.recoverTab();

    mock.dbgEvents.emit('detach', null, 'canceled by renderer');

    expect(reasons).toEqual([
      'debugger-detach:target closed',
      'debugger-detach:canceled by renderer',
    ]);
    expect(tab.isMarkedUnhealthy()).toBe(true);
    // Never doubled: exactly one live detach listener after the re-attach.
    expect(mock.dbgEvents.count('detach')).toBe(1);
  });

  test('the input-fallback event re-arms too: a fresh epoch reports again', async () => {
    const { tab, reasons } = await makeAttachedTab();
    mock.attached = false;
    tab.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 } as never);
    await flush();
    expect(reasons).toEqual(['input-fallback']);

    await tab.recoverTab();
    await flush(); // Network.enable → debuggerReady on the fresh session
    mock.attached = false; // the new epoch's transport dies as well
    tab.sendInputEvent({ type: 'mouseMove', x: 3, y: 3 } as never);
    await flush();

    expect(reasons).toEqual(['input-fallback', 'input-fallback']);
  });
});
