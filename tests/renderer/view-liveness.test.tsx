/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * docs/PRINCIPLES.md §2 as a test: the UI mirrors the graph, LIVE.
 *
 * Every surface here is fed only by a PUSH through the fake bridge — no pull, no
 * operation "finishing" — and each case asserts the rendered number actually
 * MOVES. That is the property signals could quietly break: a projection lands
 * in a module-scope signal instead of shell state, so a consumer that captured a
 * stale value (or stopped subscribing when its props went away) would still
 * render, still typecheck, and silently stop ticking. Here it fails.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { GALLERY_SETTINGS_FACTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { Settings } from '@/types';
import { chainTarget, type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const SEEDED: Settings = { ...DEFAULT_SETTINGS, seed: 'someone', tourCompletedAt: 1 };

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge(SEEDED);
});

/** Mount the shell and let the mount-time pulls land. */
async function mountApp(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(bridge.calls.some((c) => c[0] === 'getSettings')).toBe(true));
  await act(async () => {});
}

/** Open a stage the way the menu does (its page mounts on first activation). */
async function open(mode: string): Promise<void> {
  await act(async () => bridge.emit('stageRequest', mode as 'people'));
}

const text = (selector: string): string =>
  document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** NumberTicker renders one reel per digit; the whole value lives in aria-label. */
const ticker = (selector: string): string | null =>
  document.querySelector(`${selector} .nt`)?.getAttribute('aria-label') ?? null;

describe('The live column mirrors the status stream', () => {
  it("today's net followers follow every push, and don't wait for a pull", async () => {
    await mountApp();
    const pulls = () => bridge.calls.filter((c) => c[0] === 'status').length;
    const before = pulls();

    await act(async () => bridge.emit('status', idleStatus({ state: 'running', netToday: 4 })));
    expect(ticker('[data-zone="results"]')).toBe('+4');

    await act(async () => bridge.emit('status', idleStatus({ state: 'running', netToday: 11 })));
    expect(ticker('[data-zone="results"]')).toBe('+11');
    expect(pulls()).toBe(before); // pushed, never polled
  });
});

describe('People mirrors the lifecycle counters', () => {
  it('the lane counts move on a push', async () => {
    await mountApp();
    await open('people');
    await act(async () => bridge.emit('status', idleStatus({ queued: 3 })));
    expect(text('[data-lane="next"] .n')).toBe('3');

    await act(async () => bridge.emit('status', idleStatus({ queued: 9, pendingFollowback: 2 })));
    expect(text('[data-lane="next"] .n')).toBe('9');
    expect(text('[data-lane="waiting"] .n')).toBe('2');
  });
});

describe('People mirrors the chain projection', () => {
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
    bridge.data.chainList = trail(120);
    await mountApp();
    await open('people');
    await act(async () => bridge.emit('chainList', trail(120)));
    await act(async () => {
      fireEvent.click(screen.getByText('Show every step'));
    });
    expect(text('[data-stage="people"]')).toContain('120 people found');

    // The SECOND value exists only in the push: a pull would still say 120.
    await act(async () => bridge.emit('chainList', trail(4_800)));
    expect(text('[data-stage="people"]')).toContain('4,800 people found');
  });
});

describe('Prune mirrors its own projection', () => {
  it("the run's daily tally moves while the prune holds the tab", async () => {
    await mountApp();
    await open('prune');
    const running = { ...bridge.data.pruneStatus, state: 'running' as const, dailyLimit: 50 };

    await act(async () => bridge.emit('pruneStatus', { ...running, dailyDone: 2 }));
    expect(text('.prune-page')).toContain('2');

    await act(async () => bridge.emit('pruneStatus', { ...running, dailyDone: 37 }));
    expect(text('.prune-page')).toContain('37');
    // The unified posture followed the prune too — one push, both surfaces.
    expect(document.querySelector('.console')?.getAttribute('data-state')).toBe('running');
  });
});

describe('Settings mirrors its own pushes', () => {
  it('a settings push and a settingsFacts push each move a rendered value with no pull', async () => {
    bridge.data.settingsView = GALLERY_SETTINGS_VIEW;
    bridge.data.settingsFacts = GALLERY_SETTINGS_FACTS;
    await mountApp();
    await open('settings');
    await screen.findByRole('heading', { name: 'Growth pace' });
    const pulls = () => bridge.calls.filter((c) => c[0] === 'settingsView' || c[0] === 'settingsFacts').length;
    const before = pulls();

    const balanced = (n: number) => ({
      ...GALLERY_SETTINGS_VIEW,
      rev: GALLERY_SETTINGS_VIEW.rev + n,
      options: {
        ...GALLERY_SETTINGS_VIEW.options,
        paceCards: GALLERY_SETTINGS_VIEW.options.paceCards.map((p) => (p.id === 'balanced' ? { ...p, perDay: { ...p.perDay, typical: n } } : p)),
      },
    });
    await act(async () => bridge.emit('settings', balanced(46)));
    expect(ticker('.radio-card.is-on .radio-card__metric')).toBe('46');
    await act(async () => bridge.emit('settings', balanced(47)));
    expect(ticker('.radio-card.is-on .radio-card__metric')).toBe('47');

    const p = GALLERY_SETTINGS_FACTS.protection;
    if (p === null) throw new Error('fixture facts carry protection');
    await act(async () => bridge.emit('settingsFacts', { ...GALLERY_SETTINGS_FACTS, protection: { ...p, protectedFollowing: 300 } }));
    expect(ticker('#settings-protection .set-summary-box')).toBe('300');
    await act(async () => bridge.emit('settingsFacts', { ...GALLERY_SETTINGS_FACTS, protection: { ...p, protectedFollowing: 301 } }));
    expect(ticker('#settings-protection .set-summary-box')).toBe('301');
    expect(pulls()).toBe(before);
  });
});
