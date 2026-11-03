/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The shell (spec §12.4, §13): five stages behind one stage bar, the menu's
 * stage requests, the stage request to main, the shell services (Start without a
 * starting account opens Settings at the field; Sign in shows Live first), one
 * subscription per push channel, Graph laid out at boot, and Settings mounted
 * only when opened — so nothing on it checks the starting account at launch.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { liveRevealedSignal, liveSlotSignal, pendingControlSignal } from '@/renderer/app/live-signals';
import {
  type ShellControls,
  type ShellServices,
  settingsTargetSignal,
  stageSignal,
  useShell,
  useShellControls,
} from '@/renderer/app/shell-context';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { Settings } from '@/types';
import { type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const SEEDED: Settings = { ...DEFAULT_SETTINGS, seed: 'someone', tourCompletedAt: 1 };

let bridge: FakeBridge;
let services: ShellServices | null;
let controls: ShellControls | null;

/** Rendered in the Live stage's slot: a consumer inside the App's own providers. */
function ServicesProbe(): null {
  services = useShell();
  controls = useShellControls();
  return null;
}

beforeEach(() => {
  bridge = installFakeBridge(SEEDED);
  services = null;
  controls = null;
  liveSlotSignal.value = <ServicesProbe />;
  // jsdom has no IntersectionObserver; the interim settings projection chart observes its own visibility.
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

async function mountApp(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(bridge.calls.some((c) => c[0] === 'getSettings')).toBe(true));
  await act(async () => {});
}

const stageCalls = (): unknown[][] => bridge.calls.filter((c) => c[0] === 'setStage');
const page = (mode: string): HTMLElement => document.querySelector(`[data-stage="${mode}"]`) as HTMLElement;
const tab = (mode: string): HTMLButtonElement => document.querySelector(`[data-stage-tab="${mode}"]`) as HTMLButtonElement;

describe('App — five stages behind one bar', () => {
  it('labels the tabs Live · People · Graph · Prune · Settings, in the menu order', async () => {
    await mountApp();
    const labels = [...document.querySelectorAll('.stageseg button')].map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Live', 'People', 'Graph', 'Prune', 'Settings']);
    expect(tab('settings').getAttribute('data-tip')).toMatch(/Settings · (⌘|Ctrl\+)5 or (⌘|Ctrl\+),/);
  });

  it('opens on Live and tells main, uncovered once revealed', async () => {
    await mountApp();
    expect(page('tab').hidden).toBe(false);
    expect(stageCalls()).toContainEqual(['setStage', 'tab', false]);
  });

  it('keeps Live covered until the boot reveal', async () => {
    liveRevealedSignal.value = false;
    await mountApp();
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', true]);
    await act(async () => {
      liveRevealedSignal.value = true;
    });
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', false]);
  });

  it('a tab press switches the stage and asks main for it', async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(tab('people'));
    });
    expect(page('people').hidden).toBe(false);
    expect(page('tab').hidden).toBe(true);
    expect(stageCalls().at(-1)).toEqual(['setStage', 'people', false]);
  });

  it('the menu’s stage requests switch stages, ⌘, included', async () => {
    await mountApp();
    await act(async () => bridge.emit('stageRequest', 'graph'));
    expect(stageSignal.value).toBe('graph');
    await act(async () => bridge.emit('stageRequest', 'settings'));
    expect(page('settings').hidden).toBe(false);
    expect(stageCalls().at(-1)).toEqual(['setStage', 'settings', false]);
  });

  it('lays out Graph at boot but mounts Settings only when it is opened — no seed check at launch', async () => {
    await mountApp();
    expect(page('graph').querySelector('.graph-stage')).not.toBeNull();
    expect(page('settings').childElementCount).toBe(0);
    expect(page('people').childElementCount).toBe(0);
    expect(bridge.calls.some((c) => c[0] === 'checkSeed')).toBe(false);
    await act(async () => bridge.emit('stageRequest', 'settings'));
    expect(page('settings').childElementCount).toBeGreaterThan(0);
  });

  it('a mounted stage stays mounted when another opens', async () => {
    await mountApp();
    await act(async () => bridge.emit('stageRequest', 'people'));
    await act(async () => bridge.emit('stageRequest', 'graph'));
    expect(page('people').childElementCount).toBeGreaterThan(0);
    expect(page('people').hidden).toBe(true);
  });
});

describe('App — the shell subscribes once', () => {
  it('has exactly one listener per push channel, and none for the raw log', async () => {
    await mountApp();
    const channels = ['status', 'pruneStatus', 'updateStatus', 'chainList', 'settings', 'settingsFacts', 'feed',
      'activity', 'stageRequest'] as const;
    for (const channel of channels) {
      expect({ channel, n: bridge.listenerCount(channel) }).toEqual({ channel, n: 1 });
    }
    expect(bridge.listenerCount('log')).toBe(0);
  });

  it('a pushed status drives .console[data-state] without any pull', async () => {
    await mountApp();
    await act(async () => bridge.emit('status', idleStatus({ state: 'running' })));
    expect(document.querySelector('.console')?.getAttribute('data-state')).toBe('running');
  });

  it('renders the tooltip layer outside the console column', async () => {
    await mountApp();
    const tip = document.querySelector('.tip');
    expect(tip).not.toBeNull();
    expect(tip?.closest('.console')).toBeNull();
  });
});

describe('App — the shell services and controls', () => {
  it('Start without a starting account opens Settings at that field and never calls the engine', async () => {
    bridge.data.settings = { ...SEEDED, seed: '' };
    await mountApp();
    await act(async () => controls?.start());
    expect(bridge.calls.some((c) => c[0] === 'startEngine')).toBe(false);
    expect(stageSignal.value).toBe('settings');
    expect(settingsTargetSignal.value).toEqual({ section: 'audience', focus: 'seed' });
  });

  it('Start with a starting account calls the engine, showing the pending control meanwhile', async () => {
    await mountApp();
    let settle: (s: ReturnType<typeof idleStatus>) => void = () => {};
    bridge.stub('startEngine', () => new Promise((resolve) => (settle = resolve)));
    await act(async () => controls?.start());
    expect(bridge.calls.some((c) => c[0] === 'startEngine')).toBe(true);
    expect(pendingControlSignal.value).toBe('start');
    await act(async () => settle(idleStatus()));
    await waitFor(() => expect(pendingControlSignal.value).toBeNull());
    expect(document.querySelector('.toast')).toBeNull();
  });

  it("a 'prune-running' refusal explains itself as info, any other as an error", async () => {
    await mountApp();
    bridge.stub('startEngine', () => idleStatus({ refusal: 'prune-running' }));
    await act(async () => controls?.start());
    const info = await screen.findByText(/Start refused/);
    expect(info.closest('.toast')?.getAttribute('data-kind')).toBe('info');

    bridge.stub('startEngine', () => idleStatus({ refusal: 'seed-missing' }));
    await act(async () => controls?.start());
    const error = await screen.findByText('Start refused: seed-missing');
    expect(error.closest('.toast')?.getAttribute('data-kind')).toBe('error');
  });

  it('Sign in shows Live first, then signs in', async () => {
    bridge.data.status = idleStatus({ loggedIn: false });
    await mountApp();
    await act(async () => bridge.emit('stageRequest', 'graph'));
    await act(async () => controls?.signIn());
    const names = bridge.calls.map((c) => c[0]);
    const login = names.lastIndexOf('login');
    const live = bridge.calls.findIndex((c, i) => i < login && c[0] === 'setStage' && c[1] === 'tab');
    expect(login).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(-1);
    expect(stageSignal.value).toBe('tab');
  });

  it('an open confirm covers the native views, then restores them', async () => {
    await mountApp();
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = services?.confirm({ title: 'Sure?', body: 'Really.', confirm: 'Yes' });
    });
    expect(document.querySelector('.scrim')?.className).toContain('open');
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', true]);
    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'));
    });
    await expect(answer).resolves.toBe(false);
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', false]);
  });
});
