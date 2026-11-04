/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The shell's live plumbing (spec §12.7, §12.9): one subscription per channel,
 * push-first with a pull backstop, the People data fetched before anything
 * mounts, one ref-counted clock, and motion helpers that never gate logic.
 */
import { act, render, waitFor } from '@testing-library/preact';
import { clockUsers, useNow } from '@/renderer/app/clock';
import {
  activitySignal,
  chainListSignal,
  feedSignal,
  growthSeriesSignal,
  queueLanesSignal,
} from '@/renderer/app/live-signals';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import { settingsFactsSignal, settingsViewSignal } from '@/renderer/app/shell-context';
import { useLiveFeeds } from '@/renderer/hooks/useLiveFeeds';
import { armDeadline, remainingFraction } from '@/renderer/lib/deadline-anim';
import { flipInsert } from '@/renderer/lib/flip';
import { play } from '@/renderer/lib/play';
import { chainTarget, type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

function Feeds(): null {
  useLiveFeeds();
  return null;
}

const pulls = (method: string): number => bridge.calls.filter((c) => c[0] === method).length;

describe('useLiveFeeds', () => {
  it('subscribes once per channel and fills every signal from its first pull', async () => {
    render(<Feeds />);
    await waitFor(() => expect(queueLanesSignal.value).not.toBeNull());
    for (const channel of ['feed', 'activity', 'chainList', 'settings', 'settingsFacts'] as const) {
      expect({ channel, n: bridge.listenerCount(channel) }).toEqual({ channel, n: 1 });
    }
    expect(feedSignal.value).toEqual(bridge.data.feed);
    expect(activitySignal.value).toEqual(bridge.data.activity);
    expect(chainListSignal.value).toEqual([]);
    expect(settingsViewSignal.value).toEqual(bridge.data.settingsView);
    expect(settingsFactsSignal.value).toEqual(bridge.data.settingsFacts);
  });

  it('preloads the default growth window and every lane before anything asks', async () => {
    render(<Feeds />);
    await waitFor(() => expect(queueLanesSignal.value).not.toBeNull());
    expect(growthSeriesSignal.value).toEqual({ points: [], baselineAt: null });
    const lanes = bridge.calls.filter((c) => c[0] === 'queueList').map((c) => c[1]);
    expect(lanes).toEqual(['queued', 'pending_followback', 'followed_back', 'unfollow_queued']);
    expect(bridge.calls.filter((c) => c[0] === 'keptList')).toEqual([['keptList', 0]]);
  });

  it('a push moves its signal with no pull behind it', async () => {
    render(<Feeds />);
    await waitFor(() => expect(chainListSignal.value).not.toBeNull());
    const before = pulls('chainList');
    await act(async () => bridge.emit('chainList', [chainTarget({ username: 'pushed' })]));
    expect(chainListSignal.value?.[0]?.username).toBe('pushed');
    expect(pulls('chainList')).toBe(before);
  });

  it('a lifecycle move in a status push re-pulls the chain (the backstop)', async () => {
    render(<Feeds />);
    await waitFor(() => expect(chainListSignal.value).not.toBeNull());
    const { statusSignal } = await import('@/renderer/app/shell-context');
    await act(async () => {
      statusSignal.value = idleStatus({ queued: 1 });
    });
    const before = pulls('chainList');
    bridge.data.chainList = [chainTarget({ username: 'pulled' })];
    await act(async () => {
      statusSignal.value = idleStatus({ queued: 2 });
    });
    await waitFor(() => expect(chainListSignal.value?.[0]?.username).toBe('pulled'));
    expect(pulls('chainList')).toBe(before + 1);
  });

  it('a chain backstop response cannot replace a newer pushed chain', async () => {
    render(<Feeds />);
    await waitFor(() => expect(chainListSignal.value).not.toBeNull());
    let finish!: (list: ReturnType<typeof chainTarget>[]) => void;
    bridge.stub('chainList', () => new Promise<ReturnType<typeof chainTarget>[]>((resolve) => { finish = resolve; }));
    const { statusSignal } = await import('@/renderer/app/shell-context');
    await act(async () => { statusSignal.value = idleStatus({ queued: 1 }); });
    await act(async () => bridge.emit('chainList', [chainTarget({ username: 'fresh' })]));
    await act(async () => finish([chainTarget({ username: 'stale' })]));
    expect(chainListSignal.value?.[0]?.username).toBe('fresh');
  });

  it('unsubscribes every channel on unmount', async () => {
    const { unmount } = render(<Feeds />);
    await waitFor(() => expect(queueLanesSignal.value).not.toBeNull());
    unmount();
    for (const channel of ['feed', 'activity', 'chainList', 'settings', 'settingsFacts'] as const) {
      expect(bridge.listenerCount(channel)).toBe(0);
    }
  });
});

describe('the clock', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function Second({ on = true }: { on?: boolean }): preact.JSX.Element {
    return <span>{useNow('second', on)}</span>;
  }

  it('one timer serves every reader, ticks on the boundary, and stops with the last one', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 10, 3, 9, 0, 0, 400));
    const a = render(<Second />);
    const b = render(<Second />);
    expect(clockUsers().second).toBe(2);
    const first = Number(a.container.textContent);
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(Number(a.container.textContent)).toBe(first + 600);
    expect(Number(b.container.textContent)).toBe(first + 600);
    a.unmount();
    expect(clockUsers().second).toBe(1);
    b.unmount();
    expect(clockUsers().second).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a disabled reader holds no tick', () => {
    const r = render(<Second on={false} />);
    expect(clockUsers().second).toBe(0);
    r.unmount();
  });
});

describe('motion helpers never gate logic', () => {
  const countdown = { from: 1_000, to: 3_000, toward: 'next-step' as const };

  it('jsdom has no reduced-motion query, so the signal reads false', () => {
    expect(reducedMotionSignal.value).toBe(false);
  });

  it('play resolves at once where nothing can animate', async () => {
    await expect(play(document.createElement('div'), [{ opacity: 0 }, { opacity: 1 }], { duration: 1 })).resolves.toBe(
      undefined,
    );
  });

  it('a deadline arms nothing in jsdom, and its static fraction is the share left', () => {
    expect(armDeadline(document.createElement('div'), countdown, 2_000, 'scaleX')).toBeNull();
    expect(remainingFraction(countdown, 2_000)).toBe(0.5);
    expect(remainingFraction(countdown, 9_000)).toBe(0);
    expect(remainingFraction(countdown, 0)).toBe(1);
  });

  it('flipInsert applies the change exactly once', () => {
    const list = document.createElement('ul');
    list.append(document.createElement('li'));
    let calls = 0;
    flipInsert(list, () => {
      calls += 1;
      list.prepend(document.createElement('li'));
    }, { duration: 1, easing: 'linear' });
    expect(calls).toBe(1);
    expect(list.children).toHaveLength(2);
  });
});
