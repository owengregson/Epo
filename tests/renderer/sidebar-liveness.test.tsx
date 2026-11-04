/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The live column mirrors the graph live (PRINCIPLES §2, spec §12.1): a pushed status, feed or activity
 * moves the rendered value at once, with no pull behind it.
 */
import type { Signal } from '@preact/signals';
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import type { FeedView } from '@/shared/feed';
import type { LiveTab } from '@/shared/live-op';
import type { EpoStatus } from '@/types';
import { type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const SEEDED = { seed: 'someone', app: { tourCompletedAt: 1 } };
const T = Date.now();
const RUNTIME = {
  desired: 'running' as const, phase: 'ready' as const, blockedReason: null, lastProgressAt: null,
  progressPhase: null, incidents: [],
};
const RUNNING: Partial<EpoStatus> = { state: 'running', runtime: RUNTIME, lastStep: 'acted', lastActionAt: T - 60_000 };

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

const pulls = (method: string): number => bridge.calls.filter((c) => c[0] === method).length;
const text = (selector: string): string => document.querySelector(selector)?.textContent ?? '';

function feed(items: FeedView['items']): FeedView {
  return { items, awayFrom: null, windowStart: T - 86_400_000, shapedAt: T };
}

describe('the live column follows its pushes', () => {
  it("a status push moves the posture word and today's net at once", async () => {
    await mount();
    const before = pulls('status');
    await act(async () => bridge.emit('status', idleStatus({ ...RUNNING, nextActionAt: T + 60_000, netToday: 3 })));
    expect(text('.sb-now__word')).toBe('Working');
    expect(document.querySelector('[data-zone="results"] .nt')?.getAttribute('aria-label')).toBe('+3');
    await act(async () => bridge.emit('status', idleStatus({ ...RUNNING, nextActionAt: T + 60_000, netToday: 7 })));
    expect(document.querySelector('[data-zone="results"] .nt')?.getAttribute('aria-label')).toBe('+7');
    expect(pulls('status')).toBe(before);
  });

  it('a feed push adds its row with no pull', async () => {
    await mount();
    const before = pulls('feedView');
    const person = { pk: '1', username: 'jane' };
    await act(async () =>
      bridge.emit('feed', feed([{ id: 'a', at: T - 1_000, kind: 'followed', people: [person], via: 'plan', practice: false }])),
    );
    expect(text('[data-zone="activity"]')).toContain('Followed @jane');
    await act(async () =>
      bridge.emit(
        'feed',
        feed([
          { id: 'b', at: T, kind: 'followed-back', person: { pk: '2', username: 'bob' }, afterMs: null, dated: false },
          { id: 'a', at: T - 1_000, kind: 'followed', people: [person], via: 'plan', practice: false },
        ]),
      ),
    );
    expect(text('[data-zone="activity"]')).toContain('@bob followed you back');
    expect(pulls('feedView')).toBe(before);
  });

  it('an activity push names the step on the now line, and its clearing gives the line back', async () => {
    await mount();
    await act(async () => bridge.emit('status', idleStatus({ ...RUNNING, nextActionAt: T + 60_000 })));
    const before = pulls('activityNow');
    const tab: LiveTab = {
      activity: { info: { kind: 'page', op: { op: 'follow', username: 'jane' } }, since: T },
      busy: true,
      holds: [],
    };
    await act(async () => bridge.emit('activity', tab));
    expect(text('.sb-now__line')).toBe('Following @jane');
    await act(async () => bridge.emit('activity', { activity: null, busy: false, holds: [] }));
    expect(text('.sb-now__line')).not.toContain('Following @jane');
    expect(pulls('activityNow')).toBe(before);
  });

  it('known progress appears only while a measured operation is in flight', async () => {
    await mount();
    await act(async () => bridge.emit('status', idleStatus({ ...RUNNING, nextActionAt: T + 60_000 })));
    const pushProgress = async (total: number | null): Promise<void> => {
      await act(async () => bridge.emit('activity', {
        activity: { info: { kind: 'page', op: { op: 'read-list', list: 'followers', of: 'studio', done: 10, total } }, since: T },
        busy: true, holds: [],
      }));
    };
    await pushProgress(null);
    expect(document.querySelector('.sb-now__progress')).toBeNull();
    await pushProgress(20);
    expect(document.querySelector('.sb-now__progress i')).not.toBeNull();
    await act(async () => bridge.emit('activity', { activity: null, busy: false, holds: [] }));
    expect(document.querySelector('.sb-now__progress')).toBeNull();
  });

  it('the shared middle owns new-activity navigation and clearing, including reduced motion', async () => {
    const item = (id: string): FeedView['items'][number] => ({
      id, at: T, kind: 'followed-back', person: { pk: id, username: id }, afterMs: null, dated: false,
    });
    bridge.data.feed = feed([item('a')]);
    await mount();
    const middle = document.querySelector('.sb-middle') as HTMLElement;
    const list = document.querySelector('.sb-feed__list') as HTMLElement;
    const section = document.querySelector('.sb-feed') as HTMLElement;
    const rect = (top: number): DOMRect => ({ top, bottom: top + 100, left: 0, right: 400, width: 400, height: 100, x: 0, y: top, toJSON: () => ({}) });
    jest.spyOn(middle, 'getBoundingClientRect').mockImplementation(() => rect(100));
    const listRect = jest.spyOn(list, 'getBoundingClientRect').mockImplementation(() => rect(0));
    jest.spyOn(section, 'getBoundingClientRect').mockImplementation(() => rect(-40));
    middle.scrollTop = 300;
    middle.scrollTo = jest.fn();
    await act(async () => bridge.emit('feed', feed([item('b'), item('a')])));
    expect(text('.sb-pill--new')).toContain('1 new');
    listRect.mockImplementation(() => rect(150));
    fireEvent.scroll(middle);
    expect(document.querySelector('.sb-pill--new')).toBeNull();
    listRect.mockImplementation(() => rect(0));
    await act(async () => bridge.emit('feed', feed([item('c'), item('b'), item('a')])));
    const motion = reducedMotionSignal as Signal<boolean>;
    const previous = motion.peek();
    try {
      motion.value = true;
      fireEvent.click(document.querySelector('.sb-pill--new') as HTMLElement);
      expect(middle.scrollTo).toHaveBeenCalledWith({ top: 160, behavior: 'instant' });
    } finally {
      motion.value = previous;
    }
    expect(document.querySelector('.sb-pill--new')).toBeNull();
  });
});
