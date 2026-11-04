/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The People stage (spec §12.5): it renders at once from what the shell fetched
 * before the reveal, reads again only while shown, speaks in plain words (steps,
 * people found, days left, the five lanes, Kept), keeps the starting account's
 * one empty state, and details the source Epo would resume.
 */
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { chainListSignal, growthSeriesSignal, queueLanesSignal } from '@/renderer/app/live-signals';
import { type ShellControls, ShellControlsContext, settingsViewSignal, stageSignal, statusSignal } from '@/renderer/app/shell-context';
import { runwayText } from '@/renderer/cards/chain/PoolRunwayCard';
import { keptWhy } from '@/renderer/cards/queues/QueueRowItem';
import { crumbTier, detailTargetPk } from '@/renderer/hooks/useTargetDetail';
import { PeoplePage } from '@/renderer/pages/PeoplePage';
import { chainTarget, type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

let bridge: FakeBridge;
const openSettings = jest.fn();
const CONTROLS = { openSettings } as unknown as ShellControls;

const row = (pk: string, username: string) => ({ pk, username, ratio: 0.97, isPrivate: false, mutuals: 4 });
const LANES = {
  next: { rows: [row('1', 'next.one')], truncated: false },
  waiting: { rows: [], truncated: false },
  back: { rows: [], truncated: false },
  leaving: { rows: [], truncated: false },
  kept: { kind: 'ok' as const, rows: [{ pk: '9', username: 'friend', reason: 'bio-word', match: 'family', keptAt: 1, recheckAt: null }], total: 3 },
};

beforeEach(() => {
  bridge = installFakeBridge();
  openSettings.mockReset();
  statusSignal.value = idleStatus({ queued: 7, pendingFollowback: 2, currentTargetPk: '200' });
  chainListSignal.value = [
    chainTarget({ accountPk: '100', username: 'first', status: 'retired' }),
    chainTarget({ accountPk: '200', username: 'second', source: 'discovered', chainIndex: 1 }),
  ];
  growthSeriesSignal.value = { points: [], baselineAt: null };
  queueLanesSignal.value = LANES;
});

function mount(): void {
  render(
    <ShellControlsContext.Provider value={CONTROLS}>
      <PeoplePage />
    </ShellControlsContext.Provider>,
  );
}

const reads = (): string[] =>
  bridge.calls.map((c) => c[0]).filter((m) => ['queueList', 'keptList', 'chainDetail', 'growthSeries'].includes(m));

describe('PeoplePage', () => {
  it('renders the preloaded data and reads nothing while another stage shows', async () => {
    stageSignal.value = 'graph';
    mount();
    await act(async () => {});
    expect(reads()).toEqual([]);
    expect(screen.getByText('@next.one')).toBeTruthy();
    expect(screen.getByText('Good fit · 4 followers in common')).toBeTruthy();
  });

  it('reads the shown lane, the kept table, the growth and the source once opened', async () => {
    stageSignal.value = 'people';
    mount();
    await act(async () => {});
    expect(new Set(reads())).toEqual(new Set(['queueList', 'keptList', 'chainDetail', 'growthSeries']));
  });

  it('names the five lanes in order, with live counts and the kept total', async () => {
    stageSignal.value = 'graph';
    mount();
    await act(async () => {});
    const lanes = [...document.querySelectorAll('.qstage')].map((b) => b.textContent);
    expect(lanes).toEqual(['7Up next', '2Waiting', '0Following back', '0Leaving soon', '3Kept']);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-lane="kept"]') as HTMLElement);
    });
    expect(screen.getByText('Kept · bio mentions “family”')).toBeTruthy();
    expect(screen.getByText('Showing 1 of 3.')).toBeTruthy();
  });

  it('speaks in plain words: steps, no ratio chip, and a restart’s sources set aside', async () => {
    stageSignal.value = 'graph';
    mount();
    await act(async () => {});
    expect(document.body.textContent).not.toMatch(/r=|Hop|scanned|Queued|Awaiting/);
    await act(async () => {
      fireEvent.click(screen.getByText('Show every step'));
    });
    expect(screen.getByText('Step 1')).toBeTruthy();
    expect(document.body.textContent).toContain('Set aside when you restarted');
  });

  it('with no source yet, shows the one empty state and opens Settings at the starting account', async () => {
    chainListSignal.value = [];
    mount();
    await act(async () => {});
    expect(screen.getByText('No sources yet. Choose a starting account in Settings and press Start.')).toBeTruthy();
    fireEvent.click(screen.getByText('Choose a starting account'));
    expect(openSettings).toHaveBeenCalledWith({ section: 'audience', focus: 'seed' });
  });

  it('shows shapes, not zeros, before the chain list is known', async () => {
    chainListSignal.value = null;
    mount();
    await act(async () => {});
    expect(document.querySelector('[aria-label="Loading your sources"]')).not.toBeNull();
  });
});

describe('the People lanes mark outside changes until the following check ran (spec §9.1, Appendix E.2)', () => {
  const own = (followingUnverified: number) => ({ followers: null, following: { count: 10, at: 1 }, followingUnverified });

  it('marks a following count that moved outside Epo as not yet verified', async () => {
    statusSignal.value = { ...idleStatus({ queued: 7 }), own: own(3) };
    mount();
    await act(async () => {});
    expect(screen.getByText('Changed outside Epo · not yet verified')).toBeTruthy();
  });

  it('drops the mark once the check accounted for every change', async () => {
    statusSignal.value = { ...idleStatus({ queued: 7 }), own: own(0) };
    mount();
    await act(async () => {});
    expect(screen.queryByText('Changed outside Epo · not yet verified')).toBeNull();
  });
});

describe('the People page’s plain readings', () => {
  it('details Epo’s current source, else the one it would resume', () => {
    expect(detailTargetPk(idleStatus({ currentTargetPk: '1' }))).toBe('1');
    expect(detailTargetPk(idleStatus({ resumeTarget: { pk: '2', username: null } }))).toBe('2');
    expect(detailTargetPk(null)).toBeNull();
  });

  it('marks "Now" for Epo’s source alone; a shown source is only highlighted', () => {
    expect(crumbTier('a', 'a', 'b')).toBe('current');
    expect(crumbTier('b', 'a', 'b')).toBe('viewing');
    expect(crumbTier('c', 'a', 'b')).toBe('plain');
    expect(crumbTier('a', null, 'a')).toBe('viewing');
  });

  it('says how long a source lasts in days, clamped past the cap', () => {
    expect(runwayText({ days: 0.4, overCap: false })).toBe('Enough people for about 1 day');
    expect(runwayText({ days: 5.2, overCap: false })).toBe('Enough people for about 6 days');
    expect(runwayText({ days: 400, overCap: true })).toMatch(/^Enough people for more than \d+ days$/);
  });

  it('says why someone is kept, and never shows a raw key', () => {
    expect(keptWhy({ reason: 'account', match: null })).toBe('Kept · on your protection list');
    expect(keptWhy({ reason: 'unreadable-bio', match: null })).toMatch(/^Kept until Epo can read the profile/);
    expect(keptWhy({ reason: 'something-new', match: null })).toBe('Kept · protected');
  });
});


describe('queue progress uses the effective v2 settings', () => {
  const DAY = 86_400_000;
  it('updates the waiting bar when the persisted wait window changes', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(10 * DAY);
    try {
      const settings = bridge.data.settingsView;
      settingsViewSignal.value = { ...settings, effective: { ...settings.effective, waitDays: 4 } };
      queueLanesSignal.value = { ...LANES, waiting: { rows: [{ ...row('2', 'waiting'), followedAt: 9 * DAY }], truncated: false } };
      mount();
      await act(async () => { fireEvent.click(document.querySelector('[data-lane="waiting"]') as HTMLElement); });
      expect(document.querySelector<HTMLElement>('.qbar i')?.style.width).toBe('25%');
      await act(async () => { settingsViewSignal.value = { ...settings, effective: { ...settings.effective, waitDays: 2 } }; });
      expect(document.querySelector<HTMLElement>('.qbar i')?.style.width).toBe('50%');
    } finally { jest.restoreAllMocks(); }
  });

  it('a keep-followers setting removes the stale unfollow countdown and progress bar', async () => {
    const settings = bridge.data.settingsView;
    settingsViewSignal.value = { ...settings, effective: { ...settings.effective, holdDays: null } };
    queueLanesSignal.value = { ...LANES, back: { rows: [{ ...row('2', 'follower'), holdUntil: Date.now() + DAY }], truncated: false } };
    mount();
    await act(async () => { fireEvent.click(document.querySelector('[data-lane="back"]') as HTMLElement); });
    expect(screen.getByText('Followed you back · kept')).toBeTruthy();
    expect(document.querySelector('.qbar')).toBeNull();
  });
});
