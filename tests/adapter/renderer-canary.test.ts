/** @jest-environment jsdom */
import { measureRendererCanary } from '@/adapter/page/renderer-canary';
import { assessRendererCanary, rendererCanaryScript, rendererCanaryTiming } from '@/adapter/renderer-canary';

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

function framesEvery(ms: number): void {
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
    window.setTimeout(() => callback(performance.now()), ms));
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id));
}

test('normal frame throughput is healthy and retires its backstop', async () => {
  framesEvery(16);
  const measuring = measureRendererCanary(rendererCanaryTiming(500));
  await jest.advanceTimersByTimeAsync(512);
  const sample = await measuring;
  expect(sample).toEqual({ rafTicks: 32, elapsedMs: 512 });
  expect(assessRendererCanary(sample)).toMatchObject({ healthy: true, fps: 62.5 });
  expect(jest.getTimerCount()).toBe(0);
});

test('one frame per second is unhealthy despite a nonzero frame count', async () => {
  framesEvery(1000);
  const measuring = measureRendererCanary(rendererCanaryTiming(500));
  await jest.advanceTimersByTimeAsync(1000);
  const sample = await measuring;
  expect(sample).toEqual({ rafTicks: 1, elapsedMs: 1000 });
  expect(assessRendererCanary(sample)).toMatchObject({ healthy: false, fps: 1 });
  expect(jest.getTimerCount()).toBe(0);
});

test('a zero-frame renderer finishes at the backstop and cancels pending rAF', async () => {
  framesEvery(10_000);
  const measuring = measureRendererCanary(rendererCanaryTiming(500));
  await jest.advanceTimersByTimeAsync(2000);
  const sample = await measuring;
  expect(sample).toEqual({ rafTicks: 0, elapsedMs: 2000 });
  expect(assessRendererCanary(sample).healthy).toBe(false);
  expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('a 1ms injected window still permits a normally scheduled first frame', async () => {
  framesEvery(16);
  const measuring = measureRendererCanary(rendererCanaryTiming(1));
  await jest.advanceTimersByTimeAsync(16);
  const sample = await measuring;
  expect(sample).toEqual({ rafTicks: 1, elapsedMs: 16 });
  expect(assessRendererCanary(sample).healthy).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

test('the compiled injection runs in its function scope without a page-global marker', async () => {
  framesEvery(16);
  expect(Object.hasOwn(window, '__epoPage')).toBe(false);
  const measuring = new Function(`return ${rendererCanaryScript(1)}`)() as Promise<unknown>;
  await jest.advanceTimersByTimeAsync(16);
  expect(assessRendererCanary(await measuring).healthy).toBe(true);
  expect(Object.hasOwn(window, '__epoPage')).toBe(false);
  expect(jest.getTimerCount()).toBe(0);
});

test('a late backstop reports measured elapsed time instead of its nominal delay', async () => {
  framesEvery(10_000);
  const now = jest.spyOn(performance, 'now').mockReturnValue(0);
  const measuring = measureRendererCanary(rendererCanaryTiming(500));
  now.mockReturnValue(3500);
  await jest.advanceTimersByTimeAsync(2000);
  expect(await measuring).toEqual({ rafTicks: 0, elapsedMs: 3500 });
  expect(jest.getTimerCount()).toBe(0);
});

test('callbacks delivered after completion cannot restart the page loop', async () => {
  let lateFrame: FrameRequestCallback = () => {};
  const request = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    lateFrame = callback;
    return 1;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const measuring = measureRendererCanary(rendererCanaryTiming(500));
  await jest.advanceTimersByTimeAsync(2000);
  await measuring;
  lateFrame(performance.now());
  expect(request).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test.each([null, 7, {}, { rafTicks: 1, elapsedMs: 0 }, { rafTicks: -1, elapsedMs: 500 },
  { rafTicks: 1, elapsedMs: Infinity }])('malformed sample %j cannot pass the health gate', (sample) => {
  expect(assessRendererCanary(sample).healthy).toBe(false);
});
