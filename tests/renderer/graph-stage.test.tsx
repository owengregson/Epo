/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, fireEvent, render } from '@testing-library/preact';
import { galleryGraph } from '@/renderer/gallery/fixtures';
import { GraphStage } from '@/renderer/graph/GraphStage';
import type { GraphBoard } from '@/renderer/hooks/useGraphBoard';

const snapshot = (state: 'populated' | 'empty'): GraphBoard['snapshot'] => {
  const read = galleryGraph(state);
  if (read === null || 'unavailable' in read) throw new Error('Expected snapshot');
  return read;
};
const board = (over: Partial<GraphBoard> = {}): GraphBoard => ({
  snapshot: snapshot('populated'), loading: false, unavailable: false,
  hidden: new Set(), toggleStatus: jest.fn(), retry: jest.fn(), ...over,
});

beforeEach(() => jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null));
afterEach(() => jest.restoreAllMocks());

test.each([
  { snapshot: null, loading: true },
  { snapshot: null },
  { snapshot: snapshot('empty') },
  { snapshot: null, unavailable: true },
])('no-data message has no competing filter overlay: %p', async (over) => {
  const state = board(over);
  const view = render(<GraphStage board={state} active />);
  await act(async () => {});
  expect(document.querySelector('.graph-empty')).not.toBeNull();
  expect(document.querySelector('.graph-legend')).toBeNull();
  if (state.unavailable) {
    fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    expect(state.retry).toHaveBeenCalledTimes(1);
  }
});

test('the populated graph starts unobscured and explicitly expanded filters remain available after refresh failure', async () => {
  const state = board();
  const view = render(<GraphStage board={state} active />);
  await act(async () => {});
  const legend = view.getByRole('button', { name: 'Legend 445' });
  expect(legend.getAttribute('aria-expanded')).toBe('false');
  expect(view.queryByRole('button', { name: 'Fit view' })).toBeNull();
  fireEvent.click(legend);
  expect(legend.getAttribute('aria-expanded')).toBe('true');
  expect(view.getByRole('button', { name: 'Fit view' })).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'Known 64' }));
  expect(state.toggleStatus).toHaveBeenCalledWith('known');
  view.rerender(<GraphStage board={{ ...state, unavailable: true }} active />);
  expect(document.querySelector('.graph-legend')).not.toBeNull();
  expect(view.getByText('Epo can’t refresh the graph. Showing the last available view.')).toBeTruthy();
  fireEvent.click(legend);
  expect(view.queryByRole('button', { name: 'Fit view' })).toBeNull();
});
