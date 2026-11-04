/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The Prune page (spec §7.8): candidates come annotated from main (protected ones behind "Show protected"),
 * protection is read here and edited in Settings, today's allowance is read only, pruning gradually is
 * the one opt-in (asked first), a failed list read never poses as "everyone follows back", and a list
 * too large to check in full says why instead of showing part of it.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import type { PruneCandidateView } from '@/ipc/contract';
import {
  pruneSignal, ShellContext, type ShellControls, ShellControlsContext, settingsFactsSignal, settingsViewSignal,
} from '@/renderer/app/shell-context';
import { GALLERY_SETTINGS_FACTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { PruneView } from '@/renderer/views/PruneView';
import { type FakeBridge, idlePruneStatus, installFakeBridge } from '../kit/render-bridge';

let bridge: FakeBridge;
let confirmAnswer = true;
const confirm = jest.fn(async () => confirmAnswer);
const openSettings = jest.fn();
const controls = { openSettings, showStage: jest.fn() } as unknown as ShellControls;
const shell = (node: ComponentChildren) => (
  <ShellContext.Provider value={{ confirm, toast: jest.fn() }}>
    <ShellControlsContext.Provider value={controls}>{node}</ShellControlsContext.Provider>
  </ShellContext.Provider>
);
const rows: PruneCandidateView[] = [
  { pk: '1', username: 'open.one', protectedBy: null, bioUnread: false },
  { pk: '2', username: 'open.two', protectedBy: null, bioUnread: true },
  { pk: '3', username: 'kept.friend', protectedBy: 'account', bioUnread: false },
] as PruneCandidateView[];
const applied = () => bridge.calls.filter((c) => c[0] === 'applySettings').map((c) => c[1]);

beforeEach(() => {
  bridge = installFakeBridge();
  confirm.mockClear();
  openSettings.mockClear();
  confirmAnswer = true;
  settingsViewSignal.value = GALLERY_SETTINGS_VIEW;
  settingsFactsSignal.value = GALLERY_SETTINGS_FACTS;
  pruneSignal.value = idlePruneStatus({ remaining: 3, candidates: 3, scanReady: true, dailyLimit: 50, dailyDone: 2 });
});

describe('the Prune page', () => {
  it('hides protected candidates behind "Show protected", with the rule that keeps them', async () => {
    bridge.stub('pruneCandidates', { ok: true, candidates: rows });
    render(shell(<PruneView />));
    await screen.findByText('@open.one');
    expect(screen.queryByText('@kept.friend')).toBeNull();
    expect(screen.getByText('Bio not read yet — checked before any unfollow')).toBeTruthy();
    fireEvent.click(screen.getByText('Show protected (1)'));
    expect(screen.getByText('@kept.friend')).toBeTruthy();
    expect(screen.getByText(/Protected · in your list/)).toBeTruthy();
  });

  it('shows today’s allowance read only, with no limit stepper and no schedule', async () => {
    bridge.stub('pruneCandidates', { ok: true, candidates: rows });
    render(shell(<PruneView />));
    await screen.findByText('@open.one');
    expect(screen.getByText('2 of 50 used')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/schedule/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/whitelist/i);
  });

  it('a failed list read says so and offers Try again — never "everyone follows you back"', async () => {
    bridge.stub('pruneCandidates', { ok: false, reason: 'unavailable' });
    render(shell(<PruneView />));
    await screen.findByText('Couldn’t load the list Epo saved.');
    expect(screen.queryByText(/Everyone you follow follows you back/)).toBeNull();
    bridge.stub('pruneCandidates', { ok: true, candidates: rows });
    fireEvent.click(screen.getByText('Try again'));
    await screen.findByText('@open.one');
  });

  it('Prune now counts only unprotected candidates', async () => {
    bridge.stub('pruneCandidates', { ok: true, candidates: rows });
    render(shell(<PruneView />));
    await screen.findByText('@open.one');
    confirmAnswer = false;
    fireEvent.click(screen.getByRole('button', { name: /Prune now/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect((confirm.mock.calls[0] as unknown as [{ body: string }])[0].body).toMatch(/Unfollow 2 accounts/);
    expect(bridge.calls.some((c) => c[0] === 'startPrune')).toBe(false);
  });

  it('Unfollow these gradually asks with the census numbers, then sends the one intent op', async () => {
    bridge.stub('pruneCandidates', { ok: true, candidates: rows });
    bridge.stub('applySettings', { kind: 'saved', view: GALLERY_SETTINGS_VIEW, adjustments: [], conflicts: [], applies: [], inverse: [] });
    render(shell(<PruneView />));
    await screen.findByText('@open.one');
    fireEvent.click(screen.getByRole('button', { name: /Unfollow these gradually/ }));
    await waitFor(() => expect(applied()).toEqual([[{ op: 'intent', key: 'cleanup', value: 'trickle' }]]));
    expect((confirm.mock.calls[0] as unknown as [{ body: string }])[0].body).toMatch(/Epo found 318 accounts/);
  });

  it('protection is read here and edited in Settings', async () => {
    bridge.stub('pruneCandidates', { ok: true, candidates: rows });
    render(shell(<PruneView />));
    await screen.findByText('@open.one');
    expect(screen.getByText('3 accounts and 2 bio keywords are protected.')).toBeTruthy();
    fireEvent.click(screen.getByText('Edit in Settings'));
    expect(openSettings).toHaveBeenCalledWith({ section: 'protection' });
  });

  it('a list too large to check in full says why and shows no partial list', async () => {
    bridge.stub('pruneCandidates', { ok: true, candidates: rows });
    const census = { ...GALLERY_SETTINGS_FACTS.cleanup?.census, at: 1, candidates: 3, protectedAmong: 1, verifiedComplete: false, tooLarge: true };
    settingsFactsSignal.value = { ...GALLERY_SETTINGS_FACTS, cleanup: { census } };
    render(shell(<PruneView />));
    await screen.findByText(/too long to check in full/);
    expect(screen.queryByText('@open.one')).toBeNull();
    expect(within(document.body).queryByRole('button', { name: /Unfollow these gradually/ })).toBeNull();
  });
});


it('run progress tracks handled actionable rows while verified unfollows and raw protected rows stay distinct', async () => {
  bridge.stub('pruneCandidates', { ok: true, candidates: rows });
  pruneSignal.value = idlePruneStatus({ candidates: 2, remaining: 2, rawRemaining: 3, unfollowed: 0, scanReady: true });
  render(shell(<PruneView />));
  await screen.findByText('@open.one');
  const run = screen.getByText('Prune · Run').closest('.card') as HTMLElement;
  const fill = () => run.querySelector<HTMLElement>('.bar i')?.style.width;
  expect(fill()).toBe('0%');
  expect(run.querySelector('.ht-top .v')?.textContent).toBe('0 / 2');
  expect(run.querySelector('.ht-foot')?.textContent).toBe('2 remaining');
  // The first actionable row was visited but did not unfollow (e.g. Practice or a protection added mid-run).
  act(() => { pruneSignal.value = { ...pruneSignal.value!, state: 'running', remaining: 1, rawRemaining: 2 }; });
  expect(fill()).toBe('50%');
  expect(run.querySelector('.ht-top .v')?.textContent).toBe('0 / 2');
  act(() => { pruneSignal.value = { ...pruneSignal.value!, state: 'done', remaining: 0, rawRemaining: 1, unfollowed: 1 }; });
  expect(fill()).toBe('100%');
  expect(run.querySelector('.ht-top .v')?.textContent).toBe('1 / 2');
  expect(run.querySelector('.ht-foot')?.textContent).toBe('0 remaining');
});
