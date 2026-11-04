/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The live column mirrors the graph live (PRINCIPLES §2, spec §12.1): a pushed status, feed or activity
 * moves the rendered value at once, with no pull behind it.
 */
import { act, render, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
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
});
