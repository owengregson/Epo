/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The compatibility surfaces (spec §10.7, Appendix D.2): the panel pulls on mount and on every
 * `status.surface` revision, explains each area, hides the technical details until asked, and copies the
 * main-built report; the Easy line and the sidebar notice read only the status push.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { ShellContext, statusSignal } from '@/renderer/app/shell-context';
import { SURFACE_SCENARIOS } from '@/renderer/gallery/fixtures-surface';
import { CompatibilityNotice } from '@/renderer/live/CompatibilityNotice';
import { CompatibilityLine } from '@/renderer/settings/compatibility/CompatibilityLine';
import { CompatibilityPanel } from '@/renderer/settings/compatibility/CompatibilityPanel';
import type { SurfaceReport, SurfaceSummary } from '@/shared/surface-health';
import { type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const summaryOf = (key: string): SurfaceSummary => {
  const found = SURFACE_SCENARIOS.find((s) => s.key === key)?.status.surface;
  if (found === undefined || found === null) throw new Error(`no scenario ${key}`);
  return found;
};

let fake: FakeBridge;
const toast = jest.fn();
const shell = (node: preact.ComponentChildren) => (
  <ShellContext.Provider value={{ confirm: async () => true, toast }}>{node}</ShellContext.Provider>
);
const report = (over: Partial<SurfaceReport> = {}): SurfaceReport => ({
  ...fake.data.surfaceReport,
  surfaceId: '2026-08-12',
  areas: fake.data.surfaceReport.areas.map((a) => (a.area === 'lists'
    ? { ...a, state: 'paused', paused: ['cleanup', 'exploration'], lastReadAt: Date.UTC(2026, 10, 2) } : { ...a, state: 'ok' })),
  changes: [{ area: 'lists', endpoint: 'followers-list', cls: 'more-without-cursor', field: 'has_more', path: 'has_more',
    firstSeenAt: Date.UTC(2026, 10, 2), lastSeenAt: Date.UTC(2026, 10, 2), seen: 2, state: 'open', witnesses: 0, hint: null,
    hasSample: false }],
  copyText: 'Epo · Instagram compatibility report',
  ...over,
});

beforeEach(() => {
  fake = installFakeBridge();
  toast.mockReset();
});

test('the panel explains each area and its recent changes, in the Prune vocabulary', async () => {
  fake.data.surfaceReport = report();
  render(shell(<CompatibilityPanel />));
  await screen.findByText('Follower and following lists');
  expect(screen.getByText('Paused')).toBeTruthy();
  expect(screen.getByText(/so pruning waits/)).toBeTruthy();
  expect(screen.getByText(/the next-page marker changed · scans stop early instead of guessing/)).toBeTruthy();
  expect(screen.queryByText(/Typical load/)).toBeNull();
  fireEvent.click(screen.getByText('Show technical details'));
  expect(screen.getByText(/Typical load/)).toBeTruthy();
});

test('the panel pulls on mount and again when the surface revision moves', async () => {
  fake.data.surfaceReport = report();
  statusSignal.value = idleStatus({ surface: { ...summaryOf('surface-adapted'), revision: 1 } });
  render(shell(<CompatibilityPanel />));
  await waitFor(() => expect(fake.calls.filter(([m]) => m === 'surfaceReport')).toHaveLength(1));
  statusSignal.value = idleStatus({ surface: { ...summaryOf('surface-adapted'), revision: 2 } });
  await waitFor(() => expect(fake.calls.filter(([m]) => m === 'surfaceReport')).toHaveLength(2));
});

test('Copy report puts the main-built text on the clipboard and says what it holds', async () => {
  fake.data.surfaceReport = report({ copyText: 'the copied text' });
  const writeText = jest.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
  render(shell(<CompatibilityPanel />));
  fireEvent.click(await screen.findByText('Copy report'));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('success', 'Report copied. It contains no usernames, names or account IDs.'));
  expect(writeText).toHaveBeenCalledWith('the copied text');
});

test('the Easy line names the worst state and its Details opens the panel', () => {
  statusSignal.value = idleStatus({ surface: summaryOf('surface-unfollows-paused') });
  const onDetails = jest.fn();
  render(shell(<CompatibilityLine onDetails={onDetails} />));
  expect(screen.getByText('Instagram compatibility: Paused')).toBeTruthy();
  fireEvent.click(screen.getByText('Details'));
  expect(onDetails).toHaveBeenCalledTimes(1);
});

test('the sidebar notice: calm while adapting, attention when finding people pauses, gone when all is well', () => {
  statusSignal.value = idleStatus({ surface: summaryOf('surface-adapted') });
  const { container, rerender } = render(shell(<CompatibilityNotice onDetails={() => {}} />));
  expect(container.textContent).toBe('Adapted to an Instagram change in notifications. Following continues.');
  statusSignal.value = idleStatus({ surface: summaryOf('surface-exploration-paused') });
  rerender(shell(<CompatibilityNotice onDetails={() => {}} />));
  expect(container.textContent).toContain('Finding new people paused: Instagram changed how follower lists look.');
  expect(screen.getByText('Details')).toBeTruthy();
  statusSignal.value = idleStatus({ surface: { ...summaryOf('surface-adapted'), attention: [], worst: 'ok' } });
  rerender(shell(<CompatibilityNotice />));
  expect(container.textContent).toBe('');
});
