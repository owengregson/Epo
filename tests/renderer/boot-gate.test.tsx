/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The launch gate (spec §12.8): the splash stays while main starts and until Instagram is decided (R5) or
 * main's deadline passes; the native page stays covered until the reveal and uncovers only once its first
 * load settled; main hears `bootRevealed()` exactly once; a reload while main is live skips the intro; a
 * deadline reveal shows final-size skeletons and the Live placeholder; the tour waits for the reveal.
 */
import { act, render, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { BootGate } from '@/renderer/boot/BootGate';
import { SPLASH, splashCaption } from '@/renderer/boot/boot-copy';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { BootView } from '@/shared/boot';
import type { EpoStatus, Settings } from '@/types';
import { type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const SEEDED: Settings = { ...DEFAULT_SETTINGS, seed: 'someone', tourCompletedAt: 1 };
const T = Date.now();

function boot(over: Partial<BootView> = {}): BootView {
  return {
    phase: 'starting', identity: 'pending', data: 'pending', dataProblem: null, tab: 'loading', ig: 'pending',
    startedAt: T, revealBy: T + 60_000, startup: { step: null, startQueued: false, done: false }, ...over,
  };
}
const ready = (over: Partial<BootView> = {}): BootView =>
  boot({ phase: 'ready', identity: 'signed-in', data: 'open', ...over });

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge(SEEDED);
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div id="boot"><div class="boot-backdrop"></div><div class="boot-under"><p id="boot-caption"></p></div></div>',
  );
});

afterEach(() => {
  document.getElementById('boot')?.remove();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const splash = (): HTMLElement | null => document.getElementById('boot');
const stages = (): unknown[][] => bridge.calls.filter((c) => c[0] === 'setStage');
const revealed = (): number => bridge.calls.filter((c) => c[0] === 'bootRevealed').length;

async function mount(status: EpoStatus, settings?: Settings): Promise<void> {
  if (settings !== undefined) bridge = installFakeBridge(settings);
  bridge.data.status = status;
  render(
    <BootGate>
      <App />
    </BootGate>,
  );
  await act(async () => {});
}

const push = async (status: EpoStatus): Promise<void> => {
  await act(async () => bridge.emit('status', status));
};

describe('the launch gate', () => {
  it('keeps the splash while main is starting, with the page covered', async () => {
    await mount(idleStatus({ boot: boot() }));
    await act(() => sleep(700));
    expect(splash()).not.toBeNull();
    expect(stages().length).toBeGreaterThan(0);
    expect(stages().every((c) => c[2] === true)).toBe(true);
    expect(revealed()).toBe(0);
  });

  it('waits for Instagram to be decided, then reveals once; Live uncovers only after the tab settled', async () => {
    await mount(idleStatus({ boot: ready() }));
    await act(() => sleep(700));
    expect(splash()).not.toBeNull();

    await push(idleStatus({ boot: ready({ ig: 'placeholder' }) }));
    await waitFor(() => expect(splash()).toBeNull());
    await waitFor(() => expect(revealed()).toBe(1));
    expect(stages().every((c) => c[2] === true)).toBe(true);
    expect(document.querySelector('.live-placeholder')?.textContent).toContain('Opening Instagram');

    await push(idleStatus({ boot: ready({ phase: 'live', ig: 'placeholder', tab: 'settled' }) }));
    await waitFor(() => expect(stages().at(-1)).toEqual(['setStage', 'tab', false, false]));
    expect(document.querySelector('.live-placeholder')).toBeNull();
    await push(idleStatus({ boot: ready({ phase: 'live', ig: 'ready', tab: 'settled' }) }));
    expect(revealed()).toBe(1);
  });

  it('a reload while main is already live skips the intro and tells main nothing', async () => {
    await mount(idleStatus({ boot: ready({ phase: 'live', tab: 'settled', ig: 'ready' }) }));
    await waitFor(() => expect(splash()).toBeNull());
    await waitFor(() => expect(stages().at(-1)).toEqual(['setStage', 'tab', false, false]));
    expect(revealed()).toBe(0);
  });

  it('past revealBy the app shows anyway: skeletons for the numbers, the placeholder for Instagram', async () => {
    await mount(idleStatus({ basis: 'not-built', lastActionAt: T - 60_000, boot: ready({ data: 'pending', revealBy: Date.now() + 50 }) }));
    await waitFor(() => expect(splash()).toBeNull(), { timeout: 2_000 });
    expect(document.querySelector('[data-zone="today"] .skeleton')).not.toBeNull();
    expect(document.querySelector('[data-zone="results"]')?.textContent ?? '').not.toMatch(/\d/);
    expect(document.querySelector('.live-placeholder')).not.toBeNull();
    expect(stages().every((c) => c[2] === true)).toBe(true);
    expect(revealed()).toBe(1);
  });

  it('a first load that failed offers to try again on the Live stage', async () => {
    await mount(idleStatus({ boot: ready({ ig: 'placeholder', tab: 'failed' }) }));
    await waitFor(() => expect(splash()).toBeNull(), { timeout: 2_000 });
    const placeholder = document.querySelector('.live-placeholder');
    expect(placeholder?.textContent).toContain('Instagram can’t load while you’re offline.');
    expect(placeholder?.querySelector('button')?.textContent).toBe('Try again');
  });

  it('the first-launch tour opens only after the reveal', async () => {
    await mount(idleStatus({ boot: ready() }), { ...SEEDED, tourCompletedAt: null });
    await act(() => sleep(700));
    expect(document.querySelector('.tour-card, [data-tour-step]')).toBeNull();
    await push(idleStatus({ boot: ready({ ig: 'ready', tab: 'settled' }) }));
    await waitFor(() => expect(splash()).toBeNull());
    await waitFor(() => expect(document.querySelector('.tour-card, [data-tour-step]')).not.toBeNull());
  });
});

describe('the splash caption', () => {
  const delays = { caption: 1_200, slow: 2_500 };
  it('says nothing at first, then what the launch waits for, then that it is slow', () => {
    expect(splashCaption(null, 100, delays)).toBe('');
    expect(splashCaption(boot(), 1_300, delays)).toBe(SPLASH.data);
    expect(splashCaption(ready(), 1_300, delays)).toBe(SPLASH.instagram);
    expect(splashCaption(ready({ ig: 'ready' }), 1_300, delays)).toBe(SPLASH.almost);
    expect(splashCaption(ready(), 2_600, delays)).toBe(SPLASH.slow);
  });
});


test('the splash waits for the store-only graph preload before revealing Live', async () => {
  let finish!: () => void;
  bridge.stub('graphSnapshot', () => new Promise<null>((resolve) => { finish = () => resolve(null); }));
  await mount(idleStatus({ boot: ready({ ig: 'ready', tab: 'settled' }) }));
  await act(() => sleep(700));
  expect(splash()).not.toBeNull();
  expect(revealed()).toBe(0);
  await act(async () => finish());
  await waitFor(() => expect(splash()).toBeNull());
  await waitFor(() => expect(revealed()).toBe(1));
});
