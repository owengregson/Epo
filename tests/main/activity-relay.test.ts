/**
 * The activity relay (spec §12.9, Appendix C.3): the veil gets every report at once; the sidebar's `LiveTab`
 * push goes out at once for a new op or a hold change, on a trailing throttle for a count-only change, and a
 * clear only after the null hold, so the now line never blinks between steps.
 */

import { createActivityRelay, timerAfter } from '@/main/modules/activity-relay';
import type { ActivityInfo, LiveTab } from '@/shared/live-op';

const THROTTLE = 300;
const HOLD = 200;
const T0 = 1_800_000_000_000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});
afterEach(() => jest.useRealTimers());

function relayed() {
  const pushed: LiveTab[] = [];
  const veil: (ActivityInfo | null)[] = [];
  const relay = createActivityRelay({
    veil: { setActivity: (info) => veil.push(info) },
    push: (tab) => pushed.push(tab),
    clock: { now: () => Date.now() },
    after: timerAfter,
    throttleMs: THROTTLE,
    nullHoldMs: HOLD,
  });
  return { relay, pushed, veil };
}

const follow = (username: string): ActivityInfo => ({ kind: 'page', op: { op: 'follow', username } });
const reading = (done: number, total: number | null = 250): ActivityInfo =>
  ({ kind: 'api', op: { op: 'read-list', list: 'followers', of: 'studio', done, total } });

test('a new op reaches the veil and the sidebar at once, with when it began', () => {
  const { relay, pushed, veil } = relayed();
  relay.report(follow('jane'));
  expect(veil).toEqual([follow('jane')]);
  expect(pushed).toEqual([{ activity: { info: follow('jane'), since: T0 }, busy: false, holds: [] }]);
  jest.advanceTimersByTime(50);
  relay.report(follow('kai'));
  expect(pushed.at(-1)?.activity).toEqual({ info: follow('kai'), since: T0 + 50 });
});

test('count-only changes trail the throttle with the latest counts; an identical report sends nothing', () => {
  const { relay, pushed, veil } = relayed();
  relay.report(reading(0));
  relay.report(reading(0));
  relay.report(reading(50));
  relay.report(reading(120));
  expect(veil).toHaveLength(4);
  expect(pushed).toHaveLength(1);
  expect(relay.current().activity?.info).toEqual(reading(120));
  jest.advanceTimersByTime(THROTTLE - 1);
  expect(pushed).toHaveLength(1);
  jest.advanceTimersByTime(1);
  expect(pushed.at(-1)?.activity).toEqual({ info: reading(120), since: T0 });
  jest.advanceTimersByTime(THROTTLE * 4);
  expect(pushed).toHaveLength(2);
});

test('a clear is pushed only when no op follows within the hold; the veil clears at once', () => {
  const { relay, pushed, veil } = relayed();
  relay.report(follow('jane'));
  relay.clear();
  expect(veil.at(-1)).toBeNull();
  jest.advanceTimersByTime(HOLD - 1);
  relay.report(reading(10));
  jest.advanceTimersByTime(HOLD * 5);
  expect(pushed.map((t) => t.activity?.info.op.op ?? null)).toEqual(['follow', 'read-list']);

  relay.clear();
  jest.advanceTimersByTime(HOLD);
  expect(pushed.at(-1)?.activity).toBeNull();
  expect(relay.current().activity).toBeNull();
});

test('the same op reported after a clear starts afresh, at once, with no null between', () => {
  const { relay, pushed } = relayed();
  relay.report(follow('jane'));
  relay.clear();
  jest.advanceTimersByTime(100);
  relay.report(follow('jane'));
  expect(pushed.map((t) => t.activity?.since)).toEqual([T0, T0 + 100]);
  jest.advanceTimersByTime(HOLD * 5);
  expect(pushed).toHaveLength(2);
});

test('a hold change is pushed at once with the latest counts; an unchanged one is not', () => {
  const { relay, pushed } = relayed();
  relay.onHolds(true, ['engine']);
  expect(pushed).toEqual([{ activity: null, busy: true, holds: ['engine'] }]);
  relay.onHolds(true, ['engine']);
  expect(pushed).toHaveLength(1);
  relay.report(reading(1));
  relay.report(reading(2));
  relay.onHolds(true, ['engine', 'prune-scan']);
  expect(pushed.at(-1)).toEqual({ activity: { info: reading(2), since: T0 }, busy: true, holds: ['engine', 'prune-scan'] });
  jest.advanceTimersByTime(THROTTLE * 2);
  expect(pushed).toHaveLength(3);
  relay.onHolds(false, []);
  expect(pushed.at(-1)).toMatchObject({ busy: false, holds: [] });
});

test('timerAfter cancels', () => {
  const fn = jest.fn();
  const cancel = timerAfter(10, fn);
  cancel();
  jest.advanceTimersByTime(20);
  expect(fn).not.toHaveBeenCalled();
});
