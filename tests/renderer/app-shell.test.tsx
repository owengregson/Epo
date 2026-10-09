/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The shell's behaviour: view routing (including the ⌘1–4 shortcuts), the
 * refusal→toast policy, and the one-shot Start watch. These are the two
 * subtlest blocks in the layer and the ones a decomposition must not change.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { Settings } from '@/types';
import { type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const SEEDED: Settings = { ...DEFAULT_SETTINGS, seed: 'someone', tourCompletedAt: 1 };

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge(SEEDED);
});

/** Render the shell and wait for the mount-time settings/status pulls to land. */
async function mountApp(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(bridge.calls.some((c) => c[0] === 'getSettings')).toBe(true));
  await act(async () => {});
}

const start = (): HTMLButtonElement => document.getElementById('btnStart') as HTMLButtonElement;

describe('App — the shell subscribes once and mirrors pushes', () => {
  it('subscribes to each push channel exactly once', async () => {
    await mountApp();
    expect(bridge.listenerCount('status')).toBeGreaterThan(0);
    expect(bridge.listenerCount('pruneStatus')).toBe(1);
    expect(bridge.listenerCount('log')).toBe(1);
    expect(bridge.listenerCount('updateStatus')).toBe(1);
  });

  it('a pushed status drives .console[data-state] without any pull', async () => {
    await mountApp();
    await act(async () => bridge.emit('status', idleStatus({ state: 'running' })));
    expect(document.querySelector('.console')?.getAttribute('data-state')).toBe('running');
  });

  it('a prune holding the tab takes over the transport (unified state)', async () => {
    await mountApp();
    await act(async () => {
      bridge.emit('pruneStatus', { ...bridge.data.pruneStatus, state: 'scanning' });
    });
    expect(document.querySelector('.console')?.getAttribute('data-state')).toBe('running');
    // The trio now addresses the prune.
    expect((document.getElementById('btnStop') as HTMLButtonElement).title).toBe('Stop the prune');
  });
});

describe('App — refusal→toast policy', () => {
  it("a 'prune-running' refusal explains itself as info, not as a failure", async () => {
    await mountApp();
    bridge.stub('startEngine', () => idleStatus({ refusal: 'prune-running' }));
    await act(async () => {
      fireEvent.click(start());
    });
    const toast = await screen.findByText(/Start refused/);
    expect(toast.textContent).toMatch(/a prune holds the tab/);
    expect(toast.closest('.toast')?.getAttribute('data-kind')).toBe('info');
  });

  it('any other refusal surfaces the reason as an error toast', async () => {
    await mountApp();
    bridge.stub('startEngine', () => idleStatus({ refusal: 'seed-missing' }));
    await act(async () => {
      fireEvent.click(start());
    });
    const toast = await screen.findByText('Start refused: seed-missing');
    expect(toast.closest('.toast')?.getAttribute('data-kind')).toBe('error');
  });

  it('a rejected control reports the error message, not a silent revert', async () => {
    await mountApp();
    bridge.failNext('startEngine', 'ipc exploded');
    await act(async () => {
      fireEvent.click(start());
    });
    const toast = await screen.findByText('Start failed: ipc exploded');
    expect(toast.closest('.toast')?.getAttribute('data-kind')).toBe('error');
  });

  it('a clean control result raises no toast at all', async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(start());
    });
    await waitFor(() => expect(bridge.calls.some((c) => c[0] === 'startEngine')).toBe(true));
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('Start without a seed prompts the seed field instead of calling the engine', async () => {
    bridge.data.settings = { ...SEEDED, seed: '' };
    await mountApp();
    await act(async () => {
      fireEvent.click(start());
    });
    expect(bridge.calls.some((c) => c[0] === 'startEngine')).toBe(false);
    expect(document.querySelector('#view-settings')?.className).toContain('active');
  });
});

describe('App — the one-shot Start watch', () => {
  it('the first pushed window park after Start says when work begins', async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(start());
    });
    const until = new Date();
    until.setHours(8, 5, 0, 0);
    await act(async () => {
      bridge.emit(
        'status',
        idleStatus({
          state: 'running',
          parkReason: 'active-hours',
          parkedUntil: until.getTime(),
        }),
      );
    });
    expect((await screen.findByText(/^Started — first actions at/)).textContent).toContain('8:05');
  });

  it('fires at most once — a second park push does not re-toast', async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(start());
    });
    const parked = idleStatus({
      state: 'running',
      parkReason: 'session',
      parkedUntil: Date.now() + 3600_000,
    });
    await act(async () => bridge.emit('status', parked));
    await act(async () => bridge.emit('status', { ...parked, parkedUntil: Date.now() + 7200_000 }));
    expect(screen.getAllByText(/^Started — first actions at/)).toHaveLength(1);
  });

  it('an engine that simply goes to work disarms the watch silently', async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(start());
    });
    await act(async () => bridge.emit('status', idleStatus({ state: 'running', lastStep: 'acted' })));
    await act(async () =>
      bridge.emit(
        'status',
        idleStatus({ state: 'running', parkReason: 'session', parkedUntil: Date.now() + 60_000 }),
      ),
    );
    expect(screen.queryByText(/^Started — first actions at/)).toBeNull();
  });

  it('a halt right after Start disarms the watch (start refused or already over)', async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(start());
    });
    await act(async () =>
      bridge.emit('status', idleStatus({ state: 'halted', haltReason: 'seed-unresolved' })),
    );
    await act(async () =>
      bridge.emit(
        'status',
        idleStatus({ state: 'running', parkReason: 'session', parkedUntil: Date.now() + 60_000 }),
      ),
    );
    expect(screen.queryByText(/^Started — first actions at/)).toBeNull();
  });

  it('a park with no press behind it never toasts', async () => {
    await mountApp();
    await act(async () =>
      bridge.emit(
        'status',
        idleStatus({ state: 'running', parkReason: 'active-hours', parkedUntil: Date.now() + 1000 }),
      ),
    );
    expect(screen.queryByText(/^Started — first actions at/)).toBeNull();
  });
});

describe('App — view routing', () => {
  it('opens on Overview', async () => {
    await mountApp();
    expect(document.querySelector('#view-overview')?.className).toContain('active');
  });

  it('⌘2 jumps to Targets; a bare "2" does not', async () => {
    await mountApp();
    await act(async () => {
      fireEvent.keyDown(window, { key: '2' });
    });
    expect(document.querySelector('#view-chain')?.className).not.toContain('active');
    await act(async () => {
      fireEvent.keyDown(window, { key: '2', metaKey: true });
    });
    expect(document.querySelector('#view-chain')?.className).toContain('active');
  });

  it('every view stays mounted so transient state survives a tab switch', async () => {
    await mountApp();
    for (const key of ['overview', 'chain', 'queues', 'settings']) {
      expect(document.querySelector(`#view-${key}`)).not.toBeNull();
    }
  });

  it("tells main which stage the window's right pane shows", async () => {
    await mountApp();
    expect(bridge.calls.filter((c) => c[0] === 'setStage')).toContainEqual([
      'setStage',
      'tab',
      false,
    ]);
  });

  it('an open confirm covers the native tab (it floats above any scrim), then restores it', async () => {
    await mountApp();
    await act(async () => bridge.emit('status', idleStatus({ state: 'running' })));
    const stageCalls = (): unknown[][] => bridge.calls.filter((c) => c[0] === 'setStage');

    await act(async () => {
      fireEvent.click(document.getElementById('btnStop') as HTMLButtonElement);
    });
    expect(document.querySelector('.scrim')?.className).toContain('open');
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', true]);

    await act(async () => {
      fireEvent.click(screen.getByText('Keep running'));
    });
    expect(stageCalls().at(-1)).toEqual(['setStage', 'tab', false]);
  });
});
