/**
 * The notifications drawer on the activity clock (spec §5.13 S2b, §5.16): the bell is pressed a drawn
 * `dwell.visit` after the last Instagram operation ended, the pass's end (the drawer closed) is noted,
 * and a pass that never opens the drawer notes nothing.
 */
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { referenceTempoSource } from '@/kernel/tempo';
import { AdapterBackedFollowNotifications, type NotificationsActor } from '@/rim/follow-notifications';
import { createIgActivityClock, type IgActivityClock } from '@/rim/ig-activity-clock';
import { sample } from '@/timing/primitives';
import { setLevel } from '@/utils/logger';
import { FakeSentinel, FakeTab, mkResp } from '../kit/fakes';

beforeAll(() => setLevel('error'));

const INBOX_URL = 'https://www.instagram.com/api/v1/news/inbox/';
const DRAWN = sample(referenceTempoSource().policy('dwell.visit'), () => 0.5);

/** Fake time the clock and the drawer share: a sleep advances it. */
function fakeTime(start = 2_000_000) {
  let t = start;
  return {
    now: (): number => t,
    sleep: async (ms: number): Promise<void> => {
      t += ms;
    },
  };
}

/** A drawer whose bell, when pressed, answers with an empty feed; every press is timed. */
function rig(clock: IgActivityClock, time: ReturnType<typeof fakeTime>, opts: { sentinel?: FakeSentinel; stop?: AbortController } = {}) {
  const tab = new FakeTab();
  const presses: number[] = [];
  let closedAt: number | null = null;
  const actor: NotificationsActor = {
    clickNotifications: async () => {
      presses.push(time.now());
      tab.emit(mkResp(INBOX_URL, { counts: {}, new_stories: [], old_stories: [] }));
      return true;
    },
    clickNotificationsFollowsFilter: async () => false,
    clickNotificationsClose: async () => {
      closedAt = time.now();
      return true;
    },
    scrollNotificationsList: async () => false,
    clickFollowRequestsEntry: async () => false,
    confirmNextFollowRequest: async () => ({ clicked: false, username: null, remaining: 0 }),
    probeFollowRequestHead: async () => ({ found: false, username: null, remaining: 0 }),
  };
  const drawer = new AdapterBackedFollowNotifications({
    tab, actor, reader: new Reader(), sentinel: (opts.sentinel ?? new FakeSentinel()) as unknown as Sentinel,
    responseWaitMs: 500, sleep: time.sleep, now: time.now, activity: clock, abortSignal: () => opts.stop?.signal,
  });
  return { drawer, presses, closedAt: (): number | null => closedAt };
}

test('the bell is pressed a drawn dwell after the last operation ended; the closed drawer is the end', async () => {
  const time = fakeTime();
  const clock = createIgActivityClock({ now: time.now, sleep: time.sleep, rng: () => 0.5 });
  clock.noteEnd(time.now());
  const { drawer, presses, closedAt } = rig(clock, time);

  expect((await drawer.fetchRecent()).ok).toBe(true);
  expect(presses).toHaveLength(1);
  expect((presses[0] ?? 0) - 2_000_000).toBe(DRAWN);
  expect(closedAt()).not.toBeNull();
  expect(clock.lastEndAt()).toBe(time.now());
  expect(clock.lastEndAt()).toBeGreaterThanOrEqual(closedAt() ?? Number.POSITIVE_INFINITY);
});

test('a page the sentinel refuses opens nothing and notes no end', async () => {
  const time = fakeTime();
  const clock = createIgActivityClock({ now: time.now, sleep: time.sleep, rng: () => 0.5 });
  clock.noteEnd(time.now());
  const { drawer, presses } = rig(clock, time, { sentinel: new FakeSentinel([], 'challenge') });

  expect(await drawer.fetchRecent()).toMatchObject({ ok: false, reason: 'sentinel:challenge' });
  expect(presses).toEqual([]);
  expect(clock.lastEndAt()).toBe(2_000_000);
});

test('a stop during the spacing ends the pass before the bell', async () => {
  const time = fakeTime();
  const stop = new AbortController();
  const clock = createIgActivityClock({ now: time.now, rng: () => 0.5, sleep: async () => {
    stop.abort();
  } });
  clock.noteEnd(time.now());
  const { drawer, presses } = rig(clock, time, { stop });

  expect(await drawer.fetchRecent()).toMatchObject({ ok: false, reason: 'aborted' });
  expect(presses).toEqual([]);
});
