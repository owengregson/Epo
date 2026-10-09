/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * docs/PRINCIPLES.md §2 as a test: the UI mirrors the graph, LIVE.
 *
 * Every view here is fed only by a PUSH through the fake bridge — no pull, no
 * operation "finishing" — and each case asserts the rendered number actually
 * MOVES. That is the property signals could quietly break: a projection now
 * lands in a module-scope signal instead of shell state, so a consumer that
 * captured a stale value (or stopped subscribing when its props went away)
 * would still render, still typecheck, and silently stop ticking. Here it fails.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { Settings } from '@/types';
import { chainTarget, type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const SEEDED: Settings = { ...DEFAULT_SETTINGS, seed: 'someone', tourCompletedAt: 1 };

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge(SEEDED);
});

/** Mount the shell and let the mount-time pulls land. Every view stays mounted. */
async function mountApp(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(bridge.calls.some((c) => c[0] === 'getSettings')).toBe(true));
  await act(async () => {});
}

const text = (selector: string): string =>
  document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** NumberTicker renders one reel per digit; the whole value lives in aria-label. */
const ticker = (selector: string): string | null =>
  document.querySelector(`${selector} .nt`)?.getAttribute('aria-label') ?? null;

describe('Overview mirrors the status stream', () => {
  it("the Actions-today readout follows every push, and doesn't wait for a pull", async () => {
    await mountApp();
    const pulls = () => bridge.calls.filter((c) => c[0] === 'status').length;
    const before = pulls();

    await act(async () => bridge.emit('status', idleStatus({ state: 'running', actionsToday: 4 })));
    expect(ticker('#view-overview .hero-today')).toBe('4');

    await act(async () => bridge.emit('status', idleStatus({ state: 'running', actionsToday: 11 })));
    expect(ticker('#view-overview .hero-today')).toBe('11');
    expect(pulls()).toBe(before); // pushed, never polled
  });

  it('the streamed log reaches the Activity card without a status push', async () => {
    await mountApp();
    await act(async () =>
      bridge.emit('log', { at: Date.now(), level: 'info', message: 'walked a page' }),
    );
    expect(text('#view-overview .log')).toContain('walked a page');
  });
});

describe('Queues mirrors the lifecycle counters', () => {
  it('the pipeline and its summary line both move on a push', async () => {
    await mountApp();
    await act(async () => bridge.emit('status', idleStatus({ queued: 3 })));
    expect(text('#view-queues .qsum')).toBe('3 ranked candidates');

    await act(async () => bridge.emit('status', idleStatus({ queued: 9, pendingFollowback: 2 })));
    expect(text('#view-queues .qsum')).toBe('9 ranked candidates');
    expect(text('#view-queues .qpipe')).toContain('9');
  });
});

describe('Targets mirrors the chain projection', () => {
  // The trail expands into per-node yield sublines once the chain has two hops,
  // which is where the scanned-pool number the walk moves is rendered.
  const trail = (poolSize: number): ReturnType<typeof chainTarget>[] => [
    chainTarget({ accountPk: '100', yield: { ...chainTarget().yield, poolSize, total: 5 } }),
    chainTarget({
      accountPk: '200',
      username: 'second',
      source: 'discovered',
      chainIndex: 1,
      yield: { ...chainTarget().yield, poolSize: 10, total: 1 },
    }),
  ];

  it("a chainList push moves the node's scanned pool with no chain read", async () => {
    // The keyed pull backstop agrees with the first push, so the trail survives
    // the re-render the expand toggle causes...
    bridge.data.chainList = trail(120);
    await mountApp();
    await act(async () => bridge.emit('chainList', trail(120)));
    await act(async () => {
      fireEvent.click(screen.getByText('expand trail'));
    });
    expect(text('#view-chain')).toContain('120 scanned');

    // ...and the SECOND value exists only in the push: a pull would still say
    // 120, so this can only pass if the pushed projection reached the node.
    await act(async () => bridge.emit('chainList', trail(4_800)));
    expect(text('#view-chain')).toContain('4,800 scanned');
  });
});

describe('Prune mirrors its own projection', () => {
  it("the run's daily tally moves while the prune holds the tab", async () => {
    await mountApp();
    const running = { ...bridge.data.pruneStatus, state: 'running' as const, dailyLimit: 50 };

    await act(async () => bridge.emit('pruneStatus', { ...running, dailyDone: 2 }));
    expect(text('.prune-page')).toContain('2');

    await act(async () => bridge.emit('pruneStatus', { ...running, dailyDone: 37 }));
    expect(text('.prune-page')).toContain('37');
    // The unified posture followed the prune too — one push, both surfaces.
    expect(document.querySelector('.console')?.getAttribute('data-state')).toBe('running');
  });
});
