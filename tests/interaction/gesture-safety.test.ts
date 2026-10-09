import { ActionAbortedError, AdapterStaleError } from '@/adapter/errors';
import { ObservedInputDriver } from '@/interaction/input-driver';
import { Interactor } from '@/interaction/interactor';

const target = { x: 500, y: 300, width: 140, height: 44 };
const driver = () => ({ mouseMove: jest.fn(), mouseDown: jest.fn(), mouseUp: jest.fn(), wheel: jest.fn() });
const tick = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('Pause interrupts travel before pressing, even if the active signal is replaced', async () => {
  const input = driver();
  const controller = new AbortController();
  let current = controller.signal;
  const interactor = new Interactor({ driver: input, abortSignal: () => current, sleep: async () => {
    controller.abort();
    current = new AbortController().signal;
  } });
  await expect(interactor.click(target)).rejects.toBeInstanceOf(ActionAbortedError);
  expect(input.mouseMove).not.toHaveBeenCalled();
  expect(input.mouseDown).not.toHaveBeenCalled();
});

test('navigation during travel invalidates the gesture coordinates', async () => {
  const input = driver();
  let version = 1;
  const interactor = new Interactor({ driver: input, contextVersion: () => version, sleep: async () => { version++; } });
  await expect(interactor.click(target)).rejects.toBeInstanceOf(ActionAbortedError);
  expect(input.mouseDown).not.toHaveBeenCalled();
});

test('covered or shifted targets cannot receive a press', async () => {
  const input = driver();
  const canClick = jest.fn(async () => false);
  const interactor = new Interactor({ driver: input, canClick, sleep: async () => {} });
  await expect(interactor.click(target)).rejects.toBeInstanceOf(AdapterStaleError);
  expect(canClick).toHaveBeenCalledTimes(1);
  expect(input.mouseDown).not.toHaveBeenCalled();
});

test('slow dispatch cannot become a backlog of cursor events', async () => {
  let acknowledge = (): void => {};
  const input = driver();
  input.mouseMove.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
  const interactor = new Interactor({ driver: input, sleep: async () => {} });
  const moving = interactor.moveTo(900, 600);
  await tick();
  expect(input.mouseMove).toHaveBeenCalledTimes(1);
  acknowledge();
  await moving;
  expect(interactor.position()).toEqual({ x: 900, y: 600 });
});

test('already accepted press is released when its hold is interrupted', async () => {
  const input = driver();
  const controller = new AbortController();
  input.mouseDown.mockImplementation(() => { controller.abort(); });
  const interactor = new Interactor({ driver: input, abortSignal: () => controller.signal, sleep: async () => {} });
  await interactor.click(target);
  expect(input.mouseUp).toHaveBeenCalledTimes(1);
  await expect(interactor.click(target)).rejects.toBeInstanceOf(ActionAbortedError);
  expect(input.mouseDown).toHaveBeenCalledTimes(1);
});

test('navigation after a press prevents releasing onto another document', async () => {
  const input = driver();
  let version = 1;
  input.mouseDown.mockImplementation(() => { version++; });
  const interactor = new Interactor({ driver: input, contextVersion: () => version, sleep: async () => {} });
  await expect(interactor.click(target)).rejects.toMatchObject({ phase: 'post-click' });
  expect(input.mouseUp).not.toHaveBeenCalled();
});

test('two concurrent clicks serialize complete gestures', async () => {
  const input = driver();
  const events: string[] = [];
  input.mouseDown.mockImplementation(() => { events.push('down'); });
  input.mouseUp.mockImplementation(() => { events.push('up'); });
  const interactor = new Interactor({ driver: input, sleep: async () => {} });
  await Promise.all([interactor.click(target), interactor.click(target)]);
  expect(events).toEqual(['down', 'up', 'down', 'up']);
});

test('hover-safe scrolling never drifts off the supplied anchor', async () => {
  const input = driver();
  const interactor = new Interactor({ driver: input, sleep: async () => {} });
  const rest = { x: 501, y: 320 };
  await interactor.scroll(target, 4000, rest);
  expect(input.wheel.mock.calls.length).toBeGreaterThan(1);
  for (const [x, y] of input.wheel.mock.calls) expect({ x, y }).toEqual(rest);
});

test('observer never advertises an unacknowledged or failed press', async () => {
  const input = driver();
  input.mouseDown.mockRejectedValue(new Error('detached'));
  const observer = { moved: jest.fn(), pressed: jest.fn() };
  const observed = new ObservedInputDriver(input, observer);
  await expect(observed.mouseDown(1.2, 3.4)).rejects.toThrow('detached');
  expect(observer.pressed).not.toHaveBeenCalled();
});

test('observer errors cannot strand an accepted button press', async () => {
  const input = driver();
  const observer = { moved: () => { throw new Error('veil destroyed'); }, pressed: jest.fn() };
  const observed = new ObservedInputDriver(input, observer);
  const interactor = new Interactor({ driver: observed, sleep: async () => {} });
  await interactor.click(target);
  expect(input.mouseDown).toHaveBeenCalledTimes(1);
  expect(input.mouseUp).toHaveBeenCalledTimes(1);
});

test('remote target handles are released even when Pause interrupts travel', async () => {
  const controller = new AbortController();
  const targetGuard = { validate: jest.fn(async () => true), dispose: jest.fn(async () => {}) };
  const interactor = new Interactor({ driver: driver(), abortSignal: () => controller.signal,
    prepareClick: async () => targetGuard, sleep: async () => { controller.abort(); } });
  await expect(interactor.click(target)).rejects.toBeInstanceOf(ActionAbortedError);
  expect(targetGuard.dispose).toHaveBeenCalledTimes(1);
  expect(targetGuard.validate).not.toHaveBeenCalled();
});

test('small viewports constrain every emitted point and partially visible target presses', async () => {
  const input = driver();
  const bounds = { x: 0, y: 0, width: 160, height: 100 };
  const interactor = new Interactor({ driver: input, viewport: async () => bounds, sleep: async () => {} });
  await interactor.click({ x: 145, y: 70, width: 80, height: 40 });
  for (const [x, y] of input.mouseMove.mock.calls) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(bounds.width);
    expect(y).toBeLessThanOrEqual(bounds.height);
  }
  const [x, y] = input.mouseDown.mock.calls[0];
  expect(x).toBeGreaterThan(145);
  expect(x).toBeLessThan(160);
  expect(y).toBeGreaterThan(70);
  expect(y).toBeLessThan(100);
});

test('invalid scroll distance is rejected before any cursor input', async () => {
  const input = driver();
  const interactor = new Interactor({ driver: input, sleep: async () => {} });
  await expect(interactor.scroll(target, Infinity)).rejects.toBeInstanceOf(RangeError);
  expect(input.mouseMove).not.toHaveBeenCalled();
  expect(input.wheel).not.toHaveBeenCalled();
});

test('an uncertain down attempts cleanup on the same healthy input context', async () => {
  const input = driver();
  input.mouseDown.mockRejectedValue(new Error('ack lost'));
  const interactor = new Interactor({ driver: input, sleep: async () => {} });
  await expect(interactor.click(target)).rejects.toThrow('ack lost');
  expect(input.mouseUp).toHaveBeenCalledTimes(1);
});
