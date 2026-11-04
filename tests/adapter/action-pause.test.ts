import { actionPause } from '@/adapter/action-pause';
import { sleep } from '@/timing/primitives';
import { setLevel, setSink } from '@/utils/logger';

const events: { message: string; meta: unknown }[] = [];
const context = { op: 'actor.unfollow', username: 'example', layer: 'dialog' };

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  events.length = 0;
  setLevel('info');
  setSink((_level, message, meta) => { events.push({ message, meta }); });
});
afterEach(() => { setSink(null); setLevel('error'); jest.restoreAllMocks(); jest.useRealTimers(); });

test('observes exactly one supplied pause and records elapsed time only when it completes', async () => {
  const pause = jest.fn(sleep);
  const pending = actionPause('ui.step-pause', 250, pause, undefined, context);
  expect(events).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(250);
  await pending;
  expect(pause).toHaveBeenCalledTimes(1);
  expect(pause).toHaveBeenCalledWith(250, undefined);
  expect(events[1]).toMatchObject({ message: 'action: pause finished',
    meta: { requestedMs: 250, elapsedMs: 250, outcome: 'completed', ...context } });
});

test('an interruptible sleep resolving early is reported aborted, never as a completed dwell', async () => {
  const token = new AbortController();
  const pending = actionPause('dwell.before-press', 500, sleep, token.signal, context);
  await jest.advanceTimersByTimeAsync(100);
  token.abort();
  await pending;
  expect(events[1]).toMatchObject({ meta: { requestedMs: 500, elapsedMs: 100, outcome: 'aborted' } });
  expect(jest.getTimerCount()).toBe(0);
});

test('a failed pause still propagates its original error and is never reported completed', async () => {
  const error = new Error('pause failed');
  await expect(actionPause('ui.step-pause', 250, async () => { throw error; }, undefined, context)).rejects.toBe(error);
  expect(events[1]).toMatchObject({ meta: { outcome: 'error' } });
});
