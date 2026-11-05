/** Bounded tab seams: no deferred execution on a ready main document with a slow child resource. */

jest.mock('electron', () => {
  const pendingForever = (): Promise<never> => new Promise<never>(() => {});
  const state = {
    destroyed: false,
    frameDestroyed: false,
    frameExecuteJavaScript: pendingForever as () => Promise<unknown>,
    events: new Map<string, Set<(...args: unknown[]) => void>>(),
    loadURL: pendingForever as () => Promise<unknown>,
    executeJavaScript: pendingForever as () => Promise<unknown>,
    sendCommand: (async () => ({})) as (method: string) => Promise<unknown>,
    messageHandler: null as
      | ((event: unknown, method: string, params: unknown) => void)
      | null,
  };
  const dbg = {
    attached: false,
    isAttached: (): boolean => dbg.attached,
    attach: (): void => {
      dbg.attached = true;
    },
    detach: (): void => {
      dbg.attached = false;
    },
    on: (event: string, fn: (event: unknown, method: string, params: unknown) => void): void => {
      // Event-keyed: the tab also registers a 'detach' health listener now —
      // only the 'message' handler is what these tests drive.
      if (event === 'message') state.messageHandler = fn;
    },
    removeListener: (): void => {},
    sendCommand: (method: string): Promise<unknown> => state.sendCommand(method),
  };
  const webContents = {
    setUserAgent: (): void => {},
    isDestroyed: (): boolean => state.destroyed,
    loadURL: (): Promise<unknown> => state.loadURL(),
    executeJavaScript: (): Promise<unknown> => state.executeJavaScript(),
    mainFrame: {
      isDestroyed: (): boolean => state.frameDestroyed,
      detached: false,
      executeJavaScript: (): Promise<unknown> => state.frameExecuteJavaScript(),
    },
    on: (name: string, cb: (...args: unknown[]) => void): void => {
      if (!state.events.has(name)) state.events.set(name, new Set());
      state.events.get(name)?.add(cb);
    },
    once: (): void => {},
    removeListener: (name: string, cb: (...args: unknown[]) => void): void => { state.events.get(name)?.delete(cb); },
    reload: (): void => {},
    sendInputEvent: (): void => {},
    debugger: dbg,
  };
  class WebContentsView {
    get webContents() {
      if (state.destroyed) throw new Error('Object has been destroyed');
      return webContents;
    }
  }
  return {
    app: { getPreferredSystemLanguages: () => ['en-US'] },
    session: { fromPartition: () => ({ setUserAgent: (): void => {}, getUserAgent: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Epo/3.1.1 Chrome/148.0.0.0 Electron/44.1.1 Safari/537.36' }) },
    WebContentsView,
    __tabMock: state,
  };
});

import { ActionAbortedError, AdapterStaleError, TabUnresponsiveError } from '@/adapter/errors';
import { InstagramTab } from '@/adapter/tab';
import type { TabResponse } from '@/types';
import { setLevel } from '@/utils/logger';

interface TabMockState {
  destroyed: boolean;
  frameDestroyed: boolean;
  frameExecuteJavaScript: () => Promise<unknown>;
  events: Map<string, Set<(...args: unknown[]) => void>>;
  loadURL: () => Promise<unknown>;
  executeJavaScript: () => Promise<unknown>;
  sendCommand: (method: string) => Promise<unknown>;
  messageHandler: ((event: unknown, method: string, params: unknown) => void) | null;
}

const mock = (jest.requireMock('electron') as { __tabMock: TabMockState }).__tabMock;
const pendingForever = (): Promise<never> => new Promise<never>(() => {});

/** Short injected deadlines so the timeout paths resolve in milliseconds. */
const SHORT_MS = 25;
const makeTab = (): InstagramTab =>
  new InstagramTab({ timeouts: { gotoMs: SHORT_MS, evaluateMs: SHORT_MS, getBodyMs: SHORT_MS } });

beforeAll(() => setLevel('error'));

beforeEach(() => {
  mock.destroyed = false;
  mock.frameDestroyed = false;
  mock.frameExecuteJavaScript = pendingForever;
  mock.events.clear();
  mock.loadURL = pendingForever;
  mock.executeJavaScript = pendingForever;
  mock.sendCommand = async () => ({});
  mock.messageHandler = null;
});

test('teardown remains idempotent after the native view is already destroyed', () => {
  const tab = makeTab();
  mock.destroyed = true;
  expect(() => { tab.dispose(); tab.dispose(); }).not.toThrow();
});

describe('tab seams map a never-settling await to TabUnresponsiveError', () => {
  test('goto: loadURL never settles -> TabUnresponsiveError(goto)', async () => {
    const tab = makeTab();
    const err = await tab.goto('https://www.instagram.com/').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TabUnresponsiveError);
    expect((err as TabUnresponsiveError).component).toBe('goto');
    expect((err as TabUnresponsiveError).timeoutMs).toBe(SHORT_MS);
  });

  test('evaluate: main-frame execution never settles -> TabUnresponsiveError(evaluate)', async () => {
    const tab = makeTab();
    const err = await tab.evaluate('1 + 1').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TabUnresponsiveError);
    expect((err as TabUnresponsiveError).component).toBe('evaluate');
    expect((err as TabUnresponsiveError).timeoutMs).toBe(SHORT_MS);
  });

  test('getBody: CDP Network.getResponseBody never settles -> TabUnresponsiveError(getBody)', async () => {
    const tab = makeTab();
    // Attach so the debugger message handler + Network.enable land, then emit
    // one finished response through the CDP path to obtain its getBody thunk.
    tab.attach({ contentView: { addChildView: (): void => {} } } as never);
    await Promise.resolve(); // let Network.enable's promise settle debuggerReady
    let captured: TabResponse | null = null;
    tab.onResponse((r) => {
      captured = r;
    });
    mock.sendCommand = (method: string) =>
      method === 'Network.getResponseBody' ? pendingForever() : Promise.resolve({});
    expect(mock.messageHandler).not.toBeNull();
    mock.messageHandler?.(null, 'Network.responseReceived', {
      requestId: 'r1',
      response: { url: 'https://www.instagram.com/api/x', status: 200, mimeType: 'application/json' },
    });
    mock.messageHandler?.(null, 'Network.loadingFinished', { requestId: 'r1' });
    expect(captured).not.toBeNull();
    const err = await (captured as unknown as TabResponse).getBody().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TabUnresponsiveError);
    expect((err as TabUnresponsiveError).component).toBe('getBody');
    expect((err as TabUnresponsiveError).timeoutMs).toBe(SHORT_MS);
  });
});

describe('non-timeout error semantics are preserved', () => {
  test('input awaiting setup cannot be dispatched after navigation invalidates it', async () => {
    let ready = (): void => {};
    const renderer = new Promise<void>((resolve) => { ready = resolve; });
    let dispatches = 0;
    mock.sendCommand = async (method) => {
      if (method === 'Input.dispatchMouseEvent') dispatches++;
      else await renderer;
      return {};
    };
    mock.loadURL = async () => { ready(); };
    const tab = makeTab();
    tab.attach({ contentView: { addChildView: (): void => {} } } as never);
    const input = tab.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    const rejected = expect(input).rejects.toBeInstanceOf(ActionAbortedError);
    await Promise.resolve();
    await tab.goto('https://fixture.invalid/');
    await rejected;
    expect(dispatches).toBe(0);
    tab.dispose();
  });

  test('cold navigation creates the renderer before waiting for CDP readiness', async () => {
    let rendererReady = (): void => {};
    const renderer = new Promise<void>((resolve) => { rendererReady = resolve; });
    mock.sendCommand = async () => { await renderer; return {}; };
    mock.loadURL = async () => { rendererReady(); };
    const tab = makeTab();
    tab.attach({ contentView: { addChildView: (): void => {} } } as never);
    await expect(tab.goto('https://fixture.invalid/')).resolves.toBeUndefined();
    expect(tab.isMarkedUnhealthy()).toBe(false);
    tab.dispose();
  });

  test('setup failure propagates rather than reporting a ready tab', async () => {
    const failed = new Error('Network domain unavailable');
    mock.sendCommand = async () => { throw failed; };
    mock.loadURL = async () => {};
    const tab = makeTab();
    tab.attach({ contentView: { addChildView: (): void => {} } } as never);
    await expect(tab.goto('https://fixture.invalid/')).rejects.toBe(failed);
    expect(tab.isMarkedUnhealthy()).toBe(true);
    tab.dispose();
  });

  test('recovery reload timeout cannot clear an unhealthy tab', async () => {
    const tab = makeTab();
    tab.attach({ contentView: { addChildView: (): void => {} } } as never);
    await expect(tab.recoverTab()).rejects.toMatchObject({ component: 'recovery-reload' });
    expect(tab.isMarkedUnhealthy()).toBe(true);
    tab.dispose();
  });

  test('goto: ERR_ABORTED without a ready replacement never reports readiness', async () => {
    mock.loadURL = () =>
      Promise.reject(Object.assign(new Error('aborted'), { code: 'ERR_ABORTED', errno: -3 }));
    const tab = makeTab();
    await expect(tab.goto('https://www.instagram.com/')).rejects.toMatchObject({ component: 'goto' });
  });

  test('goto: a non-abort load failure still rethrows unchanged', async () => {
    const boom = Object.assign(new Error('net down'), { code: 'ERR_INTERNET_DISCONNECTED' });
    mock.loadURL = () => Promise.reject(boom);
    const tab = makeTab();
    await expect(tab.goto('https://www.instagram.com/')).rejects.toBe(boom);
  });

  test('evaluate: a fast settlement passes its value through', async () => {
    mock.executeJavaScript = async () => 42;
    mock.frameExecuteJavaScript = async () => 42;
    const tab = makeTab();
    await expect(tab.evaluate<number>('40 + 2')).resolves.toBe(42);
  });
});

describe('TabUnresponsiveError is typed distinctly from the drift/abort errors', () => {
  test('a stall is never an AdapterStaleError (would be scored as selector drift)', () => {
    const err = new TabUnresponsiveError('evaluate', 15_000);
    expect(err).toBeInstanceOf(TabUnresponsiveError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AdapterStaleError);
    expect(err).not.toBeInstanceOf(ActionAbortedError);
    expect(err.name).toBe('TabUnresponsiveError');
    expect(err.component).toBe('evaluate');
    expect(err.timeoutMs).toBe(15_000);
  });

  test('an AdapterStaleError is not a TabUnresponsiveError either', () => {
    const err = new AdapterStaleError('actor.follow', 'action-button');
    expect(err).not.toBeInstanceOf(TabUnresponsiveError);
  });
});

const emit = (name: string, ...args: unknown[]): void => {
  for (const cb of mock.events.get(name) ?? []) cb(...args);
};

describe('usable main document while a child resource is still loading', () => {
  test('goto waits for a new main commit and DOM readiness, not a child resource', async () => {
    const tab = makeTab();
    let done = false;
    const navigation = tab.goto('https://fixture.invalid/').then(() => { done = true; });
    emit('dom-ready'); // an earlier document is not this navigation
    emit('did-frame-navigate', {}, 'https://fixture.invalid/child', 200, '', false);
    emit('dom-ready');
    await Promise.resolve();
    expect(done).toBe(false);
    emit('did-frame-navigate', {}, 'https://fixture.invalid/', 200, '', true);
    emit('dom-ready');
    await navigation;
    expect(done).toBe(true);
    expect(mock.events.get('dom-ready')?.size ?? 0).toBe(0);
    expect(mock.events.get('did-frame-navigate')?.size ?? 0).toBe(0);
  });

  test('evaluate uses the main frame without Electron WebContents load deferral', async () => {
    mock.executeJavaScript = pendingForever;
    mock.frameExecuteJavaScript = async () => ({ nested: [1, null, false] });
    await expect(makeTab().evaluate('fixture()')).resolves.toEqual({ nested: [1, null, false] });
  });

  test('a main navigation invalidates an outstanding evaluation result', async () => {
    let finish!: (value: number) => void;
    const pending = new Promise<number>((resolve) => { finish = resolve; });
    mock.executeJavaScript = () => pending;
    mock.frameExecuteJavaScript = () => pending;
    const tab = makeTab();
    tab.attach({ contentView: { addChildView: (): void => {} } } as never);
    const evaluated = tab.evaluate('fixture()');
    const rejected = expect(evaluated).rejects.toBeInstanceOf(ActionAbortedError);
    emit('did-start-navigation', { isMainFrame: true });
    finish(42);
    await rejected;
    tab.dispose();
  });
});
