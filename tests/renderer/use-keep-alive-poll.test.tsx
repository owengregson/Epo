/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { signal } from '@preact/signals';
import { act, render } from '@testing-library/preact';
import { useKeepAlivePoll } from '@/renderer/hooks/useKeepAlivePoll';
import { POLL } from '@/timing/config';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mountFeed() {
  const sink = signal<number | null>(null);
  const requests: ReturnType<typeof deferred<number>>[] = [];
  const errors: unknown[] = [];
  let push!: (value: number) => void;
  function Feed() {
    useKeepAlivePoll({
      subscribe: (apply) => { push = apply; return () => {}; },
      pull: () => {
        const request = deferred<number>();
        requests.push(request);
        return request.promise;
      },
      sink,
      onError: (error) => errors.push(error),
    });
    return null;
  }
  const view = render(<Feed />);
  return { sink, requests, errors, push: (value: number) => push(value), unmount: view.unmount };
}

afterEach(() => jest.useRealTimers());

test('a delayed bootstrap response cannot replace a fresh settings push', async () => {
  const feed = mountFeed();
  act(() => feed.push(2));
  await act(async () => feed.requests[0]!.resolve(1));
  expect(feed.sink.value).toBe(2);
});

test('a delayed failure after a push does not mark a working subscription unavailable', async () => {
  const feed = mountFeed();
  act(() => feed.push(2));
  await act(async () => feed.requests[0]!.reject(new Error('stale request')));
  expect(feed.errors).toEqual([]);
  expect(feed.sink.value).toBe(2);
});

test('a direct save or retry result also supersedes an older bootstrap read', async () => {
  const feed = mountFeed();
  act(() => { feed.sink.value = 3; });
  await act(async () => feed.requests[0]!.resolve(1));
  expect(feed.sink.value).toBe(3);
});

test('quiet-stream pulls cannot land out of order', async () => {
  jest.useFakeTimers();
  const feed = mountFeed();
  act(() => jest.advanceTimersByTime(POLL.KEEPALIVE_MS));
  expect(feed.requests).toHaveLength(2);
  await act(async () => feed.requests[1]!.resolve(2));
  await act(async () => feed.requests[0]!.resolve(1));
  expect(feed.sink.value).toBe(2);
});

test('an unmounted subscription ignores a pending response and failure', async () => {
  jest.useFakeTimers();
  const feed = mountFeed();
  act(() => jest.advanceTimersByTime(POLL.KEEPALIVE_MS));
  feed.unmount();
  await act(async () => {
    feed.requests[0]!.resolve(1);
    feed.requests[1]!.reject(new Error('gone'));
  });
  expect(feed.sink.value).toBeNull();
  expect(feed.errors).toEqual([]);
});
