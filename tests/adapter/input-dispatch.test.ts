import { ActionAbortedError, TabUnresponsiveError } from '@/adapter/errors';
import { InputDispatch } from '@/adapter/input-dispatch';
import type { PointerInputEvent } from '@/interaction/input-driver';

const move: PointerInputEvent = { type: 'mouseMove', x: 20, y: 30 };
const press: PointerInputEvent = { type: 'mouseDown', x: 20, y: 30, button: 'left', clickCount: 1 };
const release: PointerInputEvent = { ...press, type: 'mouseUp' };
const tick = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('does not dispatch another event until the previous acknowledgement', async () => {
  let acknowledge = (): void => {};
  const dispatch = jest.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; })).mockResolvedValue(undefined);
  const queue = new InputDispatch(dispatch, 1000, jest.fn());
  const first = queue.send(press);
  const second = queue.send(release);
  await tick();
  expect(dispatch.mock.calls.map(([event]) => event)).toEqual([press]);
  acknowledge();
  await Promise.all([first, second]);
  expect(dispatch.mock.calls.map(([event]) => event)).toEqual([press, release]);
});

test('recovery invalidates queued events and rejects the old acknowledgement', async () => {
  let acknowledge = (): void => {};
  const failed = jest.fn();
  const dispatch = jest.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; })).mockResolvedValue(undefined);
  const queue = new InputDispatch(dispatch, 1000, failed);
  const first = queue.send(move);
  const oldPress = queue.send(press);
  const assertions = Promise.all([
    expect(first).rejects.toBeInstanceOf(ActionAbortedError),
    expect(oldPress).rejects.toBeInstanceOf(ActionAbortedError),
  ]);
  await tick();
  queue.invalidate();
  await queue.send(move);
  acknowledge();
  await assertions;
  expect(dispatch.mock.calls.map(([event]) => event)).toEqual([move, move]);
  expect(failed).not.toHaveBeenCalled();
});

test('a stalled press is bounded, uncertain, and cancels every queued release', async () => {
  jest.useFakeTimers();
  try {
    const failed = jest.fn();
    const dispatch = jest.fn(() => new Promise<void>(() => {}));
    const queue = new InputDispatch(dispatch, 25, failed);
    const first = queue.send(press);
    const second = queue.send(release);
    const assertions = Promise.all([
      expect(first).rejects.toMatchObject({ name: 'TabUnresponsiveError', phase: 'post-click' }),
      expect(second).rejects.toBeInstanceOf(ActionAbortedError),
    ]);
    await jest.advanceTimersByTimeAsync(25);
    await assertions;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith(expect.any(TabUnresponsiveError));
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('dispatch rejection reaches the caller and invalidates subsequent input', async () => {
  const failure = new Error('CDP detached');
  const failed = jest.fn();
  const queue = new InputDispatch(async () => { throw failure; }, 100, failed);
  await expect(queue.send(move)).rejects.toBe(failure);
  expect(failed).toHaveBeenCalledWith(failure);
  expect(queue.version()).toBe(1);
});

test.each([press, release])('failed %s acknowledgements are post-click uncertainty', async (event) => {
  const queue = new InputDispatch(async () => { throw new Error('lost ACK'); }, 100, jest.fn());
  await expect(queue.send(event)).rejects.toMatchObject({ name: 'TabUnresponsiveError', phase: 'post-click' });
});
