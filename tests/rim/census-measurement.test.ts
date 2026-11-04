import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import { FollowersPageReader as PageReader } from '@/rim/followers-page-reader';
import { createIgActivityClock } from '@/rim/ig-activity-clock';
import type { ListPageWalker } from '@/rim/list-page-walker';
import type { WalkArgs } from '@/rim/list-walk-types';
import { walkOwnList } from '@/rim/walk-own-list';
import type { Observation } from '@/store/types';
import { FakeActor, FakeSentinel, FakeTab, followersBody, followersUrl, mkResp } from '../kit/fakes';

const rows = (count: number, prefix: string): Observation[] => Array.from({ length: count }, (_, i) => ({
  accountPk: `${prefix}${i}`, observedAt: 1, source: 'followers-list', fields: {},
}));

test.each([5, 0])('the census measures full pages and excludes the final short page/probe (%s rows)', async (lastSize) => {
  const pages = [rows(20, 'a'), rows(20, 'b'), rows(lastSize, 'c')];
  const walker = { walkAll: async (a: WalkArgs) => {
    for (const page of pages) { for (const row of page) a.onObservation(row, null); a.stopAfterPage?.(page); }
    return { pks: pages.flat().map((o) => o.accountPk), pages: pages.length, complete: true,
      endConfirmed: true, quarantined: 0, reason: 'no-more-pages', cursor: null };
  } } as ListPageWalker;
  const result = await walkOwnList({ which: 'followers', label: 'test', ownUsername: 'me', ownPk: 'ME',
    sentinel: new FakeSentinel() as unknown as Sentinel, walker, pageReader: {} as FollowersPageReader,
    bounds: { maxRounds: 10, noNewStop: 3 }, onRow: () => {} });
  expect(result.rowsPerPage).toBe(20);
});

test('the dialog fallback enters on the shared clock and records its final read before the next operation', async () => {
  let now = 1000;
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); now += ms; };
  const activity = createIgActivityClock({ now: () => now, sleep, rng: () => 0.5 });
  const tab = new FakeTab();
  const actor = new FakeActor();
  let openedAt = 0;
  actor.onOpen = () => { openedAt = now; tab.emit(mkResp(followersUrl('ME'), followersBody(['1'], null, false))); };
  activity.noteEnd(now);
  const reader = new PageReader({ tab, actor, reader: new Reader(), activity, clock: { now: () => now },
    sleep, scrollWaitMs: 1, rng: () => 0.5 });
  await reader.collect({ targetUsername: 'me', onObservation: () => {},
    sentinel: new FakeSentinel() as unknown as Sentinel, maxRounds: 1, noNewStop: 3 });
  expect(openedAt).toBe(1000 + waits[0]);
  expect(openedAt).toBeGreaterThan(1000);
  expect(activity.lastEndAt()).toBe(now);
  const ended = now;
  await activity.spaceEntry();
  expect(now).toBeGreaterThan(ended);
});
