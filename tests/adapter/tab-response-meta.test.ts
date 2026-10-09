/**
 * The tab's response observer carries REQUEST metadata (method + headers from
 * `Network.requestWillBeSent`) on every emitted response, so a consumer can
 * tell a GraphQL mutation apart from a query by its friendly-name header and
 * a POST mutation from a GET read. Header names are lower-cased so the version
 * module's lookups are case-insensitive by construction.
 */

jest.mock('electron', () => {
  type Handler = (...args: unknown[]) => void;
  const dbgListeners = new Map<string, Handler[]>();
  const state = { attached: false, bodies: new Map<string, string>() };
  const dbg = {
    isAttached: (): boolean => state.attached,
    attach: (): void => {
      state.attached = true;
    },
    detach: (): void => {
      state.attached = false;
    },
    on: (event: string, fn: Handler): void => {
      dbgListeners.set(event, [...(dbgListeners.get(event) ?? []), fn]);
    },
    removeListener: (event: string, fn: Handler): void => {
      dbgListeners.set(
        event,
        (dbgListeners.get(event) ?? []).filter((f) => f !== fn),
      );
    },
    sendCommand: async (method: string, params?: { requestId?: string }): Promise<unknown> => {
      if (method === 'Network.getResponseBody') {
        return { body: state.bodies.get(params?.requestId ?? '') ?? '', base64Encoded: false };
      }
      return {};
    },
    emit: (method: string, params: unknown): void => {
      for (const fn of dbgListeners.get('message') ?? []) fn({}, method, params);
    },
  };
  const webContents = {
    setUserAgent: (): void => {},
    isDestroyed: (): boolean => false,
    on: (): void => {},
    debugger: dbg,
  };
  class WebContentsView {
    webContents = webContents;
  }
  return {
    app: { getPreferredSystemLanguages: () => ['en-US'] },
    session: { fromPartition: () => ({ setUserAgent: (): void => {}, getUserAgent: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Epo/3.1.1 Chrome/148.0.0.0 Electron/44.1.1 Safari/537.36' }) },
    WebContentsView,
    __tabMock: { dbg, state },
  };
});

import { InstagramTab } from '@/adapter/tab';
import type { TabResponse } from '@/types';
import { setLevel } from '@/utils/logger';

interface MockDbg {
  emit(method: string, params: unknown): void;
}
const mock = (
  jest.requireMock('electron') as {
    __tabMock: { dbg: MockDbg; state: { bodies: Map<string, string> } };
  }
).__tabMock;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeAll(() => setLevel('error'));

function attachTab(): { tab: InstagramTab; seen: TabResponse[] } {
  const tab = new InstagramTab();
  const seen: TabResponse[] = [];
  tab.attach({ contentView: { addChildView: (): void => {} } } as never);
  tab.onResponse((r) => seen.push(r));
  return { tab, seen };
}

test('method and lower-cased request headers ride onto the emitted response', async () => {
  const { seen } = attachTab();
  await flush(); // Network.enable settles
  mock.dbg.emit('Network.requestWillBeSent', {
    requestId: 'q1',
    request: {
      url: 'https://www.instagram.com/graphql/query',
      method: 'POST',
      headers: { 'X-FB-Friendly-Name': 'usePolarisFollowMutation', 'Content-Type': 'x' },
    },
  });
  mock.dbg.emit('Network.responseReceived', {
    requestId: 'q1',
    response: { url: 'https://www.instagram.com/graphql/query', status: 200, mimeType: 'application/json' },
  });
  mock.state.bodies.set('q1', '{"data":{}}');
  mock.dbg.emit('Network.loadingFinished', { requestId: 'q1' });

  expect(seen).toHaveLength(1);
  expect(seen[0].method).toBe('POST');
  expect(seen[0].requestHeaders).toEqual({
    'x-fb-friendly-name': 'usePolarisFollowMutation',
    'content-type': 'x',
  });
  expect(seen[0].status).toBe(200);
  await expect(seen[0].getBody()).resolves.toBe('{"data":{}}');
});

test('a response whose request was never seen still emits (metadata absent, never dropped)', async () => {
  const { seen } = attachTab();
  await flush();
  mock.dbg.emit('Network.responseReceived', {
    requestId: 'q2',
    response: { url: 'https://www.instagram.com/api/v1/x/', status: 400, mimeType: 'application/json' },
  });
  mock.dbg.emit('Network.loadingFinished', { requestId: 'q2' });

  expect(seen).toHaveLength(1);
  expect(seen[0].method).toBeUndefined();
  expect(seen[0].requestHeaders).toBeUndefined();
});

test('request metadata is released on loadingFailed (no unbounded growth)', async () => {
  const { tab, seen } = attachTab();
  await flush();
  mock.dbg.emit('Network.requestWillBeSent', {
    requestId: 'q3',
    request: { url: 'https://www.instagram.com/x', method: 'GET', headers: {} },
  });
  mock.dbg.emit('Network.loadingFailed', { requestId: 'q3' });
  expect(seen).toHaveLength(0);
  expect(tab.pendingRequestCount()).toBe(0);
});
