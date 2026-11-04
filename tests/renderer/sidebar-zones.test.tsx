/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The live column's zones (spec §12.2–12.3): every posture renders its headline and its primary; nothing
 * shows a digit before the store is built (L-ZERO); Get started on a first run; the Boost control in each
 * state; the reason line; the Why? popover; Stop asks for nothing and offers Undo.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { settingsViewSignal } from '@/renderer/app/shell-context';
import type { BoostView } from '@/shared/boost';
import type { BootView } from '@/shared/boot';
import type { PlanProjection } from '@/shared/plan-projection';
import type { EpoStatus } from '@/types';
import { type FakeBridge, idlePruneStatus, idleStatus, installFakeBridge } from '../kit/render-bridge';

const SEEDED = { seed: 'someone', app: { tourCompletedAt: 1 } };
const T = Date.now();
const RUNTIME = { desired: 'running' as const, phase: 'ready' as const, blockedReason: null, lastProgressAt: null, progressPhase: null, incidents: [] };
const BOOT: BootView = {
  phase: 'live', identity: 'signed-in', data: 'open', dataProblem: null, tab: 'settled', ig: 'ready',
  startedAt: T - 9_000, revealBy: T, startup: { step: null, startQueued: false, done: true },
};

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge(SEEDED);
  bridge.data.status = idleStatus({ lastActionAt: T - 60_000 });
});

async function mount(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(bridge.calls.some((c) => c[0] === 'settingsView')).toBe(true));
  await act(async () => {});
}

const push = async (over: Partial<EpoStatus>): Promise<void> => {
  await act(async () => bridge.emit('status', idleStatus({ lastActionAt: T - 60_000, ...over })));
};
const q = (s: string): Element | null => document.querySelector(s);
const word = (): string => q('.sb-now__word')?.textContent ?? '';
const primary = (): string => q('.sb-now__buttons .sb-btn--primary')?.textContent?.trim() ?? '';
const reason = (): string => q('.sb-now__reason')?.textContent ?? '';

describe('every posture renders its headline and primary', () => {
  const running = (over: Partial<EpoStatus>): Partial<EpoStatus> => ({ state: 'running', runtime: RUNTIME, lastStep: 'acted', ...over });
  const cases: Array<[string, Partial<EpoStatus>, string, string]> = [
    ['working', running({ nextActionAt: T + 60_000 }), 'Working', 'Pause'],
    ['resting', running({ parkReason: 'session', parkedUntil: T + 3_600_000 }), 'Resting', 'Pause'],
    ['first step resting', running({ lastStep: null, parkReason: 'session', parkedUntil: T + 3_600_000 }), 'Resting', 'Pause'],
    ['pacing', running({ parkReason: 'velocity', parkedUntil: T + 600_000 }), 'Pacing', 'Pause'],
    ['retrying', running({ parkReason: 'enrich-backoff', parkedUntil: T + 60_000 }), 'Retrying soon', 'Pause'],
    ['done for today', running({ parkReason: 'daily-ceiling', parkedUntil: T + 9_000_000 }), 'Done for today', 'Pause'],
    ['taking a break', running({ recovery: { phase: 'holding', attempt: 2, maxAttempts: 3, resumeAt: T + 60_000 } }), 'Taking a break', 'Pause'],
    ['offline', running({ online: false }), 'Offline', 'Pause'],
    ['sleeping', running({ runtime: { ...RUNTIME, phase: 'suspended' } }), 'Sleeping', 'Pause'],
    ['reconnecting', running({ runtime: { ...RUNTIME, phase: 'recovering' } }), 'Reconnecting', 'Pause'],
    ['paused', { state: 'paused', runtime: { ...RUNTIME, desired: 'paused' } }, 'Paused', 'Resume'],
    ['stopped', {}, 'Stopped', 'Start'],
    ['needs attention', { state: 'halted', haltReason: 'seed-unresolved' }, 'Needs attention', 'Choose account'],
    ['signed out', { loggedIn: false }, 'Signed out', 'Sign in'],
    ['catching up', { boot: { ...BOOT, startup: { step: 'catch-up', startQueued: false, done: false } } }, 'Catching up', 'Start'],
    ['start queued between steps', { boot: { ...BOOT, startup: { step: null, startQueued: true, done: false } } }, 'Starting', 'Starting…'],
    ['data unavailable', { boot: { ...BOOT, data: 'unavailable', dataProblem: 'locked' } }, "Can't open data", 'Diagnostics'],
  ];
  it.each(cases)('%s', async (_name, over, headline, button) => {
    await mount();
    await push(over);
    expect(word()).toBe(headline);
    expect(primary()).toBe(button);
    expect(word().length).toBeLessThanOrEqual(15);
  });

  it('a prune holding the page drives the column and its buttons', async () => {
    await mount();
    await act(async () => bridge.emit('pruneStatus', idlePruneStatus({ state: 'paused' })));
    expect(word()).toBe('Pruning paused');
    expect(primary()).toBe('Resume pruning');
    expect(q('.sb-now__buttons .sb-btn--ghost')?.textContent).toBe('Stop pruning');
  });

  it('an attention names its fix and holds scheduled work, in plain words', async () => {
    await mount();
    await push({ state: 'halted', haltReason: 'sentinel:logged-out' });
    expect(q('.sb-now__line')?.textContent).toBe('Instagram signed you out. Sign in on the Live tab, then press Start.');
    expect(primary()).toBe('Open Live');
    expect(reason()).toBe('Scheduled work waits until you press Start.');
    await push({ state: 'halted', haltReason: 'brand-new-key' });
    expect(q('.sb-now__line')?.textContent).toContain('Something needs a look');
    expect(reason()).toBe('Code: brand-new-key');
  });
});

describe('law L-ZERO and Get started', () => {
  it('before the store is built Today and Results hold skeletons, never a digit', async () => {
    bridge.data.status = idleStatus({ basis: 'not-built', lastActionAt: T - 60_000 });
    await mount();
    expect(q('[data-zone="today"] .skeleton')).not.toBeNull();
    expect(q('[data-zone="results"] .skeleton')).not.toBeNull();
    expect(q('[data-zone="results"]')?.textContent ?? '').not.toMatch(/\d/);
  });

  it('a first run shows the three steps, checking off live', async () => {
    bridge.data.status = idleStatus({ loggedIn: false, lastActionAt: null });
    await mount();
    const steps = (): string[] => [...document.querySelectorAll('.sb-start li')].map((li) => li.className);
    expect(q('.sb-start__title span')?.textContent).toBe('1 of 3');
    expect(steps()).toEqual(['is-now', 'is-done', '']);
    await push({ loggedIn: true, lastActionAt: null });
    expect(q('.sb-start__title span')?.textContent).toBe('2 of 3');
    await push({ state: 'running', runtime: RUNTIME, lastStep: 'acted' });
    expect(q('.sb-start')).toBeNull();
    expect(q('[data-zone="today"]')).not.toBeNull();
  });
});

describe('the Boost control', () => {
  const view = (boost: boolean): void => {
    const v = settingsViewSignal.value;
    if (v !== null) settingsViewSignal.value = { ...v, capabilities: { ...v.capabilities, boost } };
  };
  const band = (b: Partial<BoostView>): BoostView => ({
    state: 'on', startedAt: T - 3_600_000, endsAt: T + 7_200_000, effectiveFrom: null, followsDuring: 3, lastEnded: null, ...b,
  });

  it('waits with the honest reason until Boost is available', async () => {
    await mount();
    const button = q('.sb-btn--boost') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(q('.sb-boost')?.getAttribute('data-tip')).toBe('Boost works once today’s plan is ready.');
  });

  it('a nothing-to-shift preview disables it with the deck line; ready starts in one tap with the saved length', async () => {
    bridge.stub('previewBoost', { hours: 12, endsAt: T + 1, effectiveFrom: T, startsSessionNow: false, extraFollowsToday: 0, unfollowsWaiting: 0, why: 'nothing-to-shift' });
    await mount();
    await act(async () => view(true));
    await waitFor(() => expect((q('.sb-btn--boost') as HTMLButtonElement).disabled).toBe(true));
    expect(q('.sb-boost')?.getAttribute('data-tip')).toBe('Today is already at Epo\'s fullest day, and Epo is already working.');

    bridge.stub('previewBoost', { hours: 12, endsAt: T + 1, effectiveFrom: T, startsSessionNow: true, extraFollowsToday: 9, unfollowsWaiting: 6, why: 'ready' });
    await push({ state: 'running', runtime: RUNTIME, lastStep: 'acted' });
    await waitFor(() => expect((q('.sb-btn--boost') as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(q('.sb-btn--boost') as HTMLButtonElement);
    });
    const start = bridge.calls.find((c) => c[0] === 'startBoost');
    expect(start?.[2]).toEqual({ alsoStart: false });
    expect(typeof start?.[1]).toBe('number');
  });

  it('on, waiting and paused become a band with one-tap End; the pill in Now is an indicator only', async () => {
    await mount();
    await push({ state: 'running', runtime: RUNTIME, lastStep: 'acted', boost: band({}) });
    expect(q('.sb-band')?.getAttribute('data-boost')).toBe('on');
    expect(q('.sb-band__text')?.textContent).toMatch(/^Boost on · ends .+ · 2 h 0 m left$/);
    expect(q('.sb-now .sb-pill--boost')?.tagName).toBe('SPAN');
    await push({ boost: band({ state: 'paused' }) });
    expect(q('.sb-band__text')?.textContent).toMatch(/^Boost on until .+ · Epo is stopped$/);
    expect(reason()).toBe('Press Start to use Boost.');
    await push({ state: 'running', runtime: RUNTIME, lastStep: 'acted', boost: band({ state: 'waiting', effectiveFrom: T + 3_600_000 }) });
    expect(q('.sb-band__text')?.textContent).toMatch(/^Boost starts at .+ \(quiet hours\)$/);
    await act(async () => {
      fireEvent.click(q('.sb-band .sb-btn') as HTMLButtonElement);
    });
    expect(bridge.calls.some((c) => c[0] === 'endBoost')).toBe(true);
  });
});

describe('Today and Results', () => {
  const HOUR = 3_600_000;
  const session = (idx: number, state: PlanProjection['sessions'][number]['state'], from: number) => ({
    idx, startAt: T + from * HOUR, endAt: T + (from + 1) * HOUR, planned: 10, done: state === 'done' ? 10 : 3, state,
    mix: 'normal' as const, probation: false, censusHost: false, pace: 'normal' as const,
  });
  const plan = (over: Partial<PlanProjection> = {}): PlanProjection => ({
    day: { key: 'd', startsAt: T - 6 * HOUR, endsAt: T + 18 * HOUR, quietMinute: 0, light: false, lateStart: false, binding: 'none', dayOff: false },
    revision: 1, cause: 'day-start',
    totals: { planned: 44, done: 26, remaining: 18, automaticMax: 48, ceiling: 65, outside: 0 },
    kinds: { follow: { planned: 30, done: 18 }, unfollow: { planned: 10, done: 6 }, accept: { planned: 4, done: 2 } },
    reads: { profiles: { planned: 0, done: 0 }, pages: { planned: 0, done: 0 }, checks: { planned: 0, done: 0 } },
    sessions: [session(0, 'done', -3), session(1, 'now', -0.5), session(2, 'next', 3)],
    now: { sessionIdx: 1, nextAt: T + 3 * HOUR, closesAt: T + 0.5 * HOUR },
    detail: { caps: { automaticMax: 48, day: 65, hour: 22, unfollowHour: 22, probationHour: 14, acceptsPerPass: 4 }, sessions: [] },
    ...over,
  });
  const followers = { count: 1284, at: T - 5 * 60_000, seenSince: { gained: 0, lost: 0 } };

  it('the summary adds up to the plan, approvals included, and the strip draws every session', async () => {
    await mount();
    await push({ plan: plan() });
    expect(q('.sb-today__sum')?.textContent).toBe('18 of 30 follows · 6 of 10 unfollows · 2 of 4 approvals');
    expect(document.querySelectorAll('.sb-strip__block')).toHaveLength(3);
    expect(q('.sb-today__next')?.textContent).toMatch(/^This session until about /);
  });

  it('no plan yet is one sentence, never a strip of zeros', async () => {
    await mount();
    await push({ plan: null });
    expect(q('.sb-today__none')?.textContent).toBe('Your plan for today appears once Epo has made it.');
    expect(q('.sb-strip')).toBeNull();
  });

  it('law L-FRESH: the follower count always carries its age', async () => {
    await mount();
    await push({ own: { followers, following: null } });
    expect(q('.sb-results__followers')?.textContent).toMatch(/^1,284 followers · checked /);
    await push({ own: { followers, following: null }, catchUp: { state: 'running', mode: 'launch', skipped: null, isReturn: true, since: null, startedAt: T, finishedAt: null, steps: [], summary: null } });
    expect(q('.sb-results__followers')?.textContent).toBe('1,284 followers · checking now…');
    await push({ own: { followers: null, following: null } });
    expect(q('.sb-results__followers')?.textContent).toBe('Epo shows your follower count after it opens your profile.');
  });
});

describe('controls', () => {
  it('Stop asks nothing and offers Undo, which starts Epo again', async () => {
    await mount();
    await push({ state: 'running', runtime: RUNTIME, lastStep: 'acted', nextActionAt: T + 60_000 });
    await act(async () => {
      fireEvent.click(q('.sb-now__buttons .sb-btn--ghost') as HTMLButtonElement);
    });
    await waitFor(() => expect(q('.toast__msg')?.textContent).toBe('Stopped. Today’s progress is kept.'));
    expect(q('.scrim.open')).toBeNull();
    expect(bridge.calls.some((c) => c[0] === 'stopEngine')).toBe(true);
    await act(async () => {
      fireEvent.click(q('.toast__action') as HTMLButtonElement);
    });
    expect(bridge.calls.some((c) => c[0] === 'startEngine')).toBe(true);
  });

  it('a Stop main refused says why on the reason line and offers no Undo', async () => {
    bridge.stub('stopEngine', () => idleStatus({ refusal: 'manual-running' }));
    await mount();
    await push({ state: 'running', runtime: RUNTIME, lastStep: 'acted', nextActionAt: T + 60_000 });
    await act(async () => {
      fireEvent.click(q('.sb-now__buttons .sb-btn--ghost') as HTMLButtonElement);
    });
    await waitFor(() => expect(reason()).toBe('Epo is finishing a quick task. Try again in a moment.'));
    expect(q('.toast__msg')).toBeNull();
  });

  it("Why? opens the posture's explanation in the shell's popover", async () => {
    await mount();
    await push({ state: 'running', runtime: RUNTIME, lastStep: 'acted', parkReason: 'session', parkedUntil: T + 3_600_000 });
    await act(async () => {
      fireEvent.click(q('.sb-why-link') as HTMLButtonElement);
    });
    expect(q('.popover .sb-why p')?.textContent).toContain('Epo works in a few sessions spread across the day');
    expect(q('.popover')?.closest('.sidebar')).toBeNull();
  });
});
