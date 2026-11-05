/**
 * The live-data rows (spec §15.1): once launch binds the process's live parts, the live tab, the log ring, its
 * stream switch and the log folder answer from them, and the feed pull answers what the feed push last said
 * while a graph is built (the not-built feed otherwise); unbound, every row keeps its typed fallback.
 */

import { bindLiveIpc, FeedMirror, type LivePorts, liveHandlers, NO_ACTIVITY } from '@/main/ipc-live';
import { notBuiltFeed } from '@/main/modules/not-built';
import type { FeedView } from '@/shared/feed';
import type { LiveTab } from '@/shared/live-op';
import type { LogEntry } from '@/shared/log-entry';
import type { UpdateStatus } from '@/shared/update-status';
import * as logger from '@/utils/logger';

const UPDATE: UpdateStatus = { state: 'unchecked', mode: 'off', current: '3.1.1', version: null, percent: null, error: null, checkedAt: null };
const TAB: LiveTab = { activity: { info: { kind: 'page', op: { op: 'follow', username: 'jane' } }, since: 5 }, busy: true, holds: ['engine'] };
const LINE: LogEntry = { level: 'info', message: 'hello', at: 7 };
const FEED: FeedView = { items: [], awayFrom: 3, windowStart: 1, shapedAt: 2 };

function ports(over: Partial<LivePorts> = {}): LivePorts & { streaming: boolean[]; opened: string[] } {
  const streaming: boolean[] = [];
  const opened: string[] = [];
  const mirror = new FeedMirror();
  mirror.note('feed', FEED);
  return {
    streaming, opened,
    activity: { current: () => TAB },
    log: { tail: () => [LINE], setStreaming: (on) => streaming.push(on) },
    feed: mirror,
    built: async () => true,
    logsDir: '/data/logs',
    openPath: async (dir) => { opened.push(dir); return ''; },
    ...over,
  };
}

test('unbound, every row answers its typed fallback', async () => {
  const live = liveHandlers(() => UPDATE);
  expect(await live.activityNow()).toEqual(NO_ACTIVITY);
  expect(await live.feedView()).toMatchObject({ items: [], awayFrom: null });
  expect(await live.logTail()).toEqual([]);
  expect(await live.setLogStream(true)).toBeUndefined();
  expect(await live.openLogFolder()).toBeUndefined();
  expect(await live.updateStatus()).toBe(UPDATE);
});

test('bound, the rows answer from the live parts', async () => {
  const p = ports();
  const unbind = bindLiveIpc(p);
  const live = liveHandlers(() => UPDATE);
  expect(await live.activityNow()).toBe(TAB);
  expect(await live.feedView()).toBe(FEED);
  expect(await live.logTail()).toEqual([LINE]);
  await live.setLogStream(true);
  await live.setLogStream(false);
  expect(p.streaming).toEqual([true, false]);
  await live.openLogFolder();
  expect(p.opened).toEqual(['/data/logs']);
  unbind();
  expect(await live.activityNow()).toEqual(NO_ACTIVITY);
});

test('the feed pull answers the not-built feed while no graph is built, or before the first feed push', async () => {
  const closed = liveHandlers(() => UPDATE, () => ports({ built: async () => false }));
  expect(await closed.feedView()).toMatchObject({ items: [], awayFrom: null });
  const fresh = liveHandlers(() => UPDATE, () => ports({ feed: new FeedMirror() }));
  expect((await fresh.feedView()).awayFrom).toBeNull();
});

test('the mirror keeps only feed pushes, newest last', () => {
  const mirror = new FeedMirror();
  expect(mirror.latest()).toBeNull();
  mirror.note('feed', FEED);
  mirror.note('status', {} as never);
  const next = { ...notBuiltFeed(9), awayFrom: 4 };
  mirror.note('feed', next);
  expect(mirror.latest()).toBe(next);
});

test('a folder that did not open is reported', async () => {
  const warnings: string[] = [];
  logger.setLevel('warn');
  logger.setSink((level, message) => { if (level === 'warn') warnings.push(message); });
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const live = liveHandlers(() => UPDATE, () => ports({ openPath: async () => 'no such folder' }));
    await live.openLogFolder();
    expect(warnings).toEqual(['log: the logs folder did not open']);
  } finally {
    quiet.mockRestore();
    logger.setSink(null);
    logger.setLevel('error');
  }
});
