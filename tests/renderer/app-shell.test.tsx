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
import type { Signal } from '@preact/signals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { liveRevealedSignal, liveSlotSignal, pendingControlSignal } from '@/renderer/app/live-signals';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import {
  type ShellControls,
  type ShellServices,
  settingsTargetSignal,
  stageSignal,
  useShell,
  useShellControls,
} from '@/renderer/app/shell-context';
import { graphSnapshot } from '../kit/graph-snapshot';
import { type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const SEEDED = { seed: 'someone', app: { tourCompletedAt: 1 } };

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
  await waitFor(() => expect(bridge.calls.some((c) => c[0] === 'settingsView')).toBe(true));
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
    expect(stageCalls()).toContainEqual(['setStage', 'tab', false, false]);
  });

  it('keeps the top strip exclusively for navigation when Live ownership changes', async () => {
    await mountApp();
    const bar = document.querySelector('.stagebar') as HTMLElement;
    for (const busy of [true, false]) {
      await act(async () => {
        bridge.emit('activity', { activity: null, busy, holds: [] });
        bridge.emit('status', idleStatus({ state: 'running', nextActionAt: Date.now() + 60_000 }));
      });
      expect(within(bar).getAllByRole('radio')).toHaveLength(5);
      expect(bar.textContent).toBe('LivePeopleGraphPruneSettings');
    }
  });

  it('keeps Live covered until the boot reveal', async () => {
    liveRevealedSignal.value = false;
    await mountApp();
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', true, false]);
    await act(async () => {
      liveRevealedSignal.value = true;
    });
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', false, false]);
  });

  it('a tab press switches the stage and asks main for it', async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(tab('people'));
    });
    expect(page('people').hidden).toBe(false);
    expect(page('tab').hidden).toBe(true);
    expect(stageCalls().at(-1)).toEqual(['setStage', 'people', false, false]);
  });

  it('the menu’s stage requests switch stages, ⌘, included', async () => {
    await mountApp();
    await act(async () => bridge.emit('stageRequest', 'graph'));
    expect(stageSignal.value).toBe('graph');
    await act(async () => bridge.emit('stageRequest', 'settings'));
    expect(page('settings').hidden).toBe(false);
    expect(stageCalls().at(-1)).toEqual(['setStage', 'settings', false, false]);
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
    bridge.data.settingsView = { ...bridge.data.settingsView, seed: '' };
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

  it('a refusal reads in plain words on the Now reason line, never as a raw-key toast', async () => {
    await mountApp();
    bridge.stub('startEngine', () => idleStatus({ refusal: 'prune-running' }));
    await act(async () => controls?.start());
    const reason = (): string => document.querySelector('.sb-now__reason')?.textContent ?? '';
    await waitFor(() => expect(reason()).toBe('A prune is using Instagram. Epo starts when it finishes.'));

    bridge.stub('startEngine', () => idleStatus({ refusal: 'some-new-key' }));
    await act(async () => controls?.start());
    await waitFor(() => expect(reason()).toBe('That didn’t work. Diagnostics has details.'));
    expect(document.querySelector('.toast')).toBeNull();
    expect(document.body.textContent).not.toContain('some-new-key');
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
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', true, false]);
    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'));
    });
    await expect(answer).resolves.toBe(false);
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', false, false]);
  });
});

test('stage requests follow the shared reduced-motion preference', async () => {
  const motion = reducedMotionSignal as Signal<boolean>;
  motion.value = true;
  try {
    await mountApp();
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', false, true]);
    await act(async () => { motion.value = false; });
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', false, false]);
  } finally {
    motion.value = false;
  }
});

test('initial Live preloads the stored graph while Graph remains mounted behind it', async () => {
  bridge.stub('graphSnapshot', graphSnapshot());
  await mountApp();
  expect(stageSignal.value).toBe('tab');
  expect(bridge.calls.filter((c) => c[0] === 'graphSnapshot')).toHaveLength(1);
  expect(page('graph').hidden).toBe(true);
  expect(page('graph').querySelector('canvas')).not.toBeNull();
});

test('an unavailable graph has a visible retry and never renders as an empty graph', async () => {
  const read = jest.spyOn(window.epo, 'graphSnapshot').mockResolvedValue({ unavailable: true });
  await mountApp();
  expect(page('graph').textContent).toContain('Epo can’t read the graph right now.');
  expect(page('graph').textContent).not.toContain('The graph is empty');
  expect([...page('graph').querySelectorAll('.gleg-count')].every((count) => count.textContent === '—')).toBe(true);
  await act(async () => bridge.emit('stageRequest', 'graph'));
  expect(page('graph').hidden).toBe(false);
  const retry = await waitFor(() => within(page('graph')).getByText('Try again'));
  read.mockResolvedValue(null);
  await act(async () => { fireEvent.click(retry); });
  await waitFor(() => expect(page('graph').textContent).not.toContain('can’t read the graph'));
});


test('Start follows the pushed v2 seed before store facts are built', async () => {
  bridge.data.settingsView = { ...bridge.data.settingsView, seed: '' };
  await mountApp();
  await act(async () => bridge.emit('settings', { ...bridge.data.settingsView, seed: 'new.source', rev: 2 }));
  await act(async () => controls?.start());
  expect(bridge.calls.some((c) => c[0] === 'startEngine')).toBe(true);
  expect(bridge.calls.some((c) => c[0] === 'getSettings' || c[0] === 'updateSettings')).toBe(false);
});
