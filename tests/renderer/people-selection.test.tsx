/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { peopleTargetSignal } from '@/renderer/app/shell-context';
import { openPerson } from '@/renderer/app/shell-services';
import { SelectedPerson } from '@/renderer/pages/people/SelectedPerson';
import type { GraphSnapshot } from '@/types';
import { graphSnapshot as snapshot } from '../kit/graph-snapshot';
import { installFakeBridge } from '../kit/render-bridge';

beforeEach(() => installFakeBridge());

test('the selected pk fetches and displays its current name and lifecycle outside the queue page', async () => {
  const bridge = installFakeBridge();
  bridge.stub('graphSnapshot', snapshot('42', 'renamed'));
  openPerson({ pk: '42', username: 'oldname' });
  const view = render(<SelectedPerson active />);
  await waitFor(() => expect(view.getByText('@renamed')).toBeTruthy());
  expect(view.getByText('Previously @oldname')).toBeTruthy();
  expect(view.getByText('Followed back · holding')).toBeTruthy();
  expect(view.getByText('42 followers')).toBeTruthy();
  expect(document.activeElement?.id).toBe('selected-person');
  await act(async () => { fireEvent.click(view.getByText('Close')); });
  expect(peopleTargetSignal.value).toBeNull();
});

test('a stale read for the previous selection cannot replace the newly selected person', async () => {
  const bridge = installFakeBridge();
  let resolve!: (value: GraphSnapshot) => void;
  bridge.stub('graphSnapshot', () => new Promise<GraphSnapshot>((done) => { resolve = done; }));
  openPerson({ pk: '1', username: 'first' });
  const view = render(<SelectedPerson active />);
  await waitFor(() => expect(resolve).toBeDefined());
  bridge.stub('graphSnapshot', snapshot('2', 'second'));
  await act(async () => openPerson({ pk: '2', username: 'second' }));
  await waitFor(() => expect(view.getByText('42 followers')).toBeTruthy());
  await act(async () => resolve(snapshot('1', 'first')));
  expect(view.queryByText('@first')).toBeNull();
  expect(view.getByText('@second')).toBeTruthy();
});

test.each(['rejected', 'unavailable'])('a %s read stays unavailable, offers retry, and never reads while hidden', async (failure) => {
  const bridge = installFakeBridge();
  openPerson({ pk: '1', username: 'selected' });
  const view = render(<SelectedPerson active={false} />);
  await act(async () => {});
  expect(bridge.calls.filter((c) => c[0] === 'graphSnapshot')).toHaveLength(0);
  if (failure === 'rejected') bridge.failNext('graphSnapshot', 'store closed');
  else bridge.stub('graphSnapshot', { unavailable: true });
  view.rerender(<SelectedPerson active />);
  await waitFor(() => expect(view.getByText('Try again')).toBeTruthy());
  expect(view.queryByText(/no longer in the current graph/)).toBeNull();
  bridge.stub('graphSnapshot', snapshot('1', 'selected'));
  await act(async () => { fireEvent.click(view.getByText('Try again')); });
  await waitFor(() => expect(view.getByText('42 followers')).toBeTruthy());
});
