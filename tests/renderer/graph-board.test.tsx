/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, render } from '@testing-library/preact';
import { graphPreloadedSignal } from '@/renderer/app/live-signals';
import { statusSignal } from '@/renderer/app/shell-context';
import { type GraphBoard, useGraphBoard } from '@/renderer/hooks/useGraphBoard';
import type { GraphSnapshot } from '@/types';
import { graphSnapshot } from '../kit/graph-snapshot';
import { installFakeBridge } from '../kit/render-bridge';

let board: GraphBoard;
function Probe({ active }: { active: boolean }): null { board = useGraphBoard(active); return null; }

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('activation during preload preserves the answer and queues a fresh read without overlapping requests', async () => {
  const bridge = installFakeBridge();
  let finish!: (snapshot: GraphSnapshot) => void;
  bridge.stub('graphSnapshot', () => new Promise<GraphSnapshot>((resolve) => { finish = resolve; }));
  const view = render(<Probe active={false} />);
  await act(async () => {});
  expect(graphPreloadedSignal.value).toBe(false);
  view.rerender(<Probe active />);
  await act(async () => {});
  expect(bridge.calls.filter((c) => c[0] === 'graphSnapshot')).toHaveLength(1);
  bridge.stub('graphSnapshot', graphSnapshot('2', 'fresh'));
  await act(async () => finish(graphSnapshot('1', 'preloaded')));
  expect(board.snapshot?.usernames).toEqual(['preloaded']);
  expect(graphPreloadedSignal.value).toBe(true);
  await act(async () => { await jest.advanceTimersByTimeAsync(1_500); });
  expect(board.snapshot?.usernames).toEqual(['fresh']);
  expect(bridge.calls.filter((c) => c[0] === 'graphSnapshot')).toHaveLength(2);
});

test('hidden stages do not refresh after preload, but opening Graph fetches current data', async () => {
  const bridge = installFakeBridge();
  bridge.stub('graphSnapshot', graphSnapshot());
  const view = render(<Probe active={false} />);
  await act(async () => {});
  await act(async () => {
    statusSignal.value = bridge.data.status;
    await jest.advanceTimersByTimeAsync(60_000);
  });
  expect(bridge.calls.filter((c) => c[0] === 'graphSnapshot')).toHaveLength(1);
  bridge.stub('graphSnapshot', graphSnapshot('2', 'current'));
  view.rerender(<Probe active />);
  await act(async () => {});
  expect(board.snapshot?.usernames).toEqual(['current']);
});

test.each(['rejected', 'unavailable'])('a %s refresh preserves the graph and reports unavailable until retry', async (failure) => {
  const bridge = installFakeBridge();
  bridge.stub('graphSnapshot', graphSnapshot());
  render(<Probe active />);
  await act(async () => {});
  if (failure === 'rejected') bridge.failNext('graphSnapshot', 'read failed');
  else bridge.stub('graphSnapshot', { unavailable: true });
  await act(async () => board.retry());
  expect(board.unavailable).toBe(true);
  expect(board.snapshot?.usernames).toEqual(['person']);
  bridge.stub('graphSnapshot', graphSnapshot('42', 'renamed'));
  await act(async () => board.retry());
  expect(board.unavailable).toBe(false);
  expect(board.snapshot?.usernames).toEqual(['renamed']);
});

test('the shell status signal refreshes the active graph as store mutations stream', async () => {
  const bridge = installFakeBridge();
  bridge.stub('graphSnapshot', graphSnapshot());
  render(<Probe active />);
  await act(async () => {});
  bridge.stub('graphSnapshot', graphSnapshot('43', 'arrived'));
  await act(async () => { statusSignal.value = bridge.data.status; });
  await act(async () => { await jest.advanceTimersByTimeAsync(1_500); });
  expect(board.snapshot?.usernames).toEqual(['arrived']);
  expect(bridge.listenerCount('status')).toBe(0);
});


test('a null read before startup builds the store waits for the first built snapshot even while hidden', async () => {
  const bridge = installFakeBridge();
  bridge.stub('graphSnapshot', null);
  render(<Probe active={false} />);
  await act(async () => {});
  expect(graphPreloadedSignal.value).toBe(false);
  bridge.stub('graphSnapshot', graphSnapshot());
  await act(async () => { statusSignal.value = bridge.data.status; });
  expect(board.snapshot?.usernames).toEqual(['person']);
  expect(graphPreloadedSignal.value).toBe(true);
  expect(bridge.calls.filter((c) => c[0] === 'graphSnapshot')).toHaveLength(2);
});

test('signed-out startup settles a null preload without inventing an unavailable graph', async () => {
  const bridge = installFakeBridge();
  bridge.stub('graphSnapshot', null);
  render(<Probe active={false} />);
  await act(async () => {});
  await act(async () => { statusSignal.value = { ...bridge.data.status, basis: 'not-built', loggedIn: false }; });
  expect(graphPreloadedSignal.value).toBe(true);
  expect(board.unavailable).toBe(false);
  expect(board.snapshot).toBeNull();
});
