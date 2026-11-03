/**
 * ResponseWatch's non-blocking reads (ADR 0308, spec §11.1 F4): one watch spans every press of an
 * action, `peek()` answers without waiting, and `markPress()` moves the latency baseline to the
 * press that may fire the response, so the arrival meter stops counting hydration and menu animation.
 */
import { ResponseWatch } from '@/adapter/response-watch';
import type { ResponseHandler, TabResponse } from '@/types';

/** A tab whose responses the test emits, and a clock the test moves. */
function rig() {
  const handlers: ResponseHandler[] = [];
  let at = 1_000;
  const watch = new ResponseWatch<string>({
    op: 'test.watch',
    matches: (r) => r.url.endsWith('/unfollow/'),
    read: async (r) => r.url,
    onError: () => null,
  }, { onResponse: (h: ResponseHandler) => { handlers.push(h); return () => {}; } }, () => at);
  const emit = (url: string): void => {
    const response = { requestId: url, url, status: 200, mimeType: 'application/json', getBody: async () => '{}' };
    for (const h of handlers) h(response as TabResponse);
  };
  return { watch, emit, advance: (ms: number) => { at += ms; } };
}

/** Let the watch's asynchronous body read settle. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('peek answers at once: nothing before the response, the observation after', async () => {
  const { watch, emit } = rig();
  expect(watch.peek()).toBeNull();
  emit('https://www.instagram.com/api/v1/web/friendships/1/unfollow/');
  await settled();
  expect(watch.peek()).toBe('https://www.instagram.com/api/v1/web/friendships/1/unfollow/');
});

test('an unrelated response is never peeked', async () => {
  const { watch, emit } = rig();
  emit('https://www.instagram.com/api/v1/friendships/show/1/');
  await settled();
  expect(watch.peek()).toBeNull();
});

test('the latency runs from the last press, and a press after the arrival moves nothing', async () => {
  const { watch, emit, advance } = rig();
  advance(4_000); // hydration and the menu's animation, before the confirm press
  watch.markPress();
  advance(300);
  emit('https://www.instagram.com/api/v1/web/friendships/1/unfollow/');
  await settled();
  watch.markPress();
  expect(watch.latencyMs()).toBe(300);
});

test('without a press the baseline stays the arming', async () => {
  const { watch, emit, advance } = rig();
  advance(700);
  emit('https://www.instagram.com/api/v1/web/friendships/1/unfollow/');
  await settled();
  expect(watch.latencyMs()).toBe(700);
});
