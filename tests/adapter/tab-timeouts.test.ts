/**
 * Deadline-bounded tab seams (adapter-awaits-unbounded fix). A wedged
 * webContents can leave `loadURL` / `executeJavaScript` / CDP `sendCommand`
 * pending FOREVER — each seam must surface that as a typed
 * `TabUnresponsiveError` (with the right component) instead of parking the
 * caller. Electron is mocked at module scope: the fake webContents' behavior
 * per call is switchable through the mock's exposed state, and the timeouts
 * are injected short so no test waits out the production deadlines.
 */

jest.mock('electron', () => {
  const pendingForever = (): Promise<never> => new Promise<never>(() => {});
  const state = {
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
    isDestroyed: (): boolean => false,
    loadURL: (): Promise<unknown> => state.loadURL(),
    executeJavaScript: (): Promise<unknown> => state.executeJavaScript(),
    on: (): void => {},
    once: (): void => {},
    removeListener: (): void => {},
    reload: (): void => {},
    sendInputEvent: (): void => {},
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

import { ActionAbortedError, AdapterStaleError, TabUnresponsiveError } from '@/adapter/errors';
import { InstagramTab } from '@/adapter/tab';
import type { TabResponse } from '@/types';
import { setLevel } from '@/utils/logger';

interface TabMockState {
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
  mock.loadURL = pendingForever;
  mock.executeJavaScript = pendingForever;
  mock.sendCommand = async () => ({});
  mock.messageHandler = null;
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

  test('evaluate: executeJavaScript never settles -> TabUnresponsiveError(evaluate)', async () => {
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
  test('goto: ERR_ABORTED (superseded navigation) stays benign', async () => {
    mock.loadURL = () =>
      Promise.reject(Object.assign(new Error('aborted'), { code: 'ERR_ABORTED', errno: -3 }));
    const tab = makeTab();
    await expect(tab.goto('https://www.instagram.com/')).resolves.toBeUndefined();
  });

  test('goto: a non-abort load failure still rethrows unchanged', async () => {
    const boom = Object.assign(new Error('net down'), { code: 'ERR_INTERNET_DISCONNECTED' });
    mock.loadURL = () => Promise.reject(boom);
    const tab = makeTab();
    await expect(tab.goto('https://www.instagram.com/')).rejects.toBe(boom);
  });

  test('evaluate: a fast settlement passes its value through', async () => {
    mock.executeJavaScript = async () => 42;
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
