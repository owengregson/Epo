import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * System sleep/resume + tab-health-event routing (sleep-resume-unobserved /
 * cdp-detach-undetected fixes). Main wires `powerMonitor` events straight to
 * `suspendForSleep` / `resumeFromSleep` and the tab's `onUnhealthy` callback
 * into the Foundation — the POLICY under test lives entirely here:
 *
 *  - repeated tab health events coalesce into ONE recovery attempt per
 *    `RECOVERY.TAB_EVENT_DEBOUNCE_MS` window;
 *  - suspend stops a RUNNING growth loop cleanly and remembers it was running;
 *  - resume runs the ordered wake sequence (settle → connectivity re-probe →
 *    tab canary → recovery if unhealthy → sentinel) and restarts the engine
 *    ONLY when it was running at suspend.
 *
 * Electron is mocked at module scope (temp userData + a fixed `ds_user_id`
 * cookie) per the foundation test harness pattern; the tab is a fake whose
 * evaluate answers the identity/sentinel probes.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-sleep-resume-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmp },
  session: {
    fromPartition: () => ({
      cookies: { get: async () => [{ name: 'ds_user_id', value: '4242' }] },
      clearStorageData: async () => {},
      clearCache: async () => {},
    }),
  },
}));

import { Foundation } from '@/main/foundation-wiring';
import type { InstagramTab } from '@/adapter/tab';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface FakeTabHarness {
  tab: InstagramTab;
  calls: string[];
  fireUnhealthy: (reason: string) => void;
  setHealthy: (healthy: boolean) => void;
}

/**
 * A fake tab that resolves identity ('/myself/'), answers the sentinel's
 * probes benignly, records the wake sequence's tab calls in order, and exposes
 * the registered onUnhealthy callback so tests fire health events like the
 * real tab would.
 */
function makeTab(): FakeTabHarness {
  const calls: string[] = [];
  let unhealthyCb: ((reason: string) => void) | null = null;
  let healthy = true;
  const tab = {
    show: () => {},
    hide: () => {},
    goto: async () => {},
    currentUrl: () => 'https://www.instagram.com/',
    evaluate: async () => '/myself/',
    onResponse: () => () => {},
    onUnhealthy: (cb: (reason: string) => void) => {
      unhealthyCb = cb;
    },
    checkHealth: async () => {
      calls.push('checkHealth');
      return { healthy, evaluateOk: true, rafTicks: healthy ? 5 : 0 };
    },
    recoverTab: async () => {
      calls.push('recoverTab');
      healthy = true;
    },
  } as unknown as InstagramTab;
  return {
    tab,
    calls,
    fireUnhealthy: (reason: string): void => {
      if (unhealthyCb === null) throw new Error('onUnhealthy was never wired');
      unhealthyCb(reason);
    },
    setHealthy: (h: boolean): void => {
      healthy = h;
    },
  };
}

describe('tab health events route into ONE debounced recovery', () => {
  test('two events inside the window -> a single recoverTab', async () => {
    const { tab, calls, fireUnhealthy } = makeTab();
    const f = new Foundation({ tab });

    fireUnhealthy('debugger-detach:target closed');
    fireUnhealthy('render-process-gone:oom'); // burst: same crash, second event
    await flush();
    await flush();
    fireUnhealthy('unresponsive'); // still inside the debounce window
    await flush();

    expect(calls.filter((c) => c === 'recoverTab')).toHaveLength(1);
    await f.dispose();
  });
});

describe('suspend freezes cleanly; resume runs the ordered wake sequence', () => {
  /** Build a foundation whose engine parks (running) at the active-hours gate. */
  async function runningFoundation(harness: FakeTabHarness, connectivity: string[]): Promise<Foundation> {
    const f = new Foundation({
      tab: harness.tab,
      requestConnectivityCheck: () => {
        harness.calls.push('connectivity');
        connectivity.push('probe');
      },
    });
    // A zero-width active-hours window parks the legacy loop immediately —
    // state stays 'running' on a long `engine:` wait, with no tab traffic.
    await f.updateSettings({ activeHoursStart: 8, activeHoursEnd: 8, pacingModel: 'legacy' });
    return f;
  }

  test('suspend stops a running loop and resume restarts it after the checks', async () => {
    const harness = makeTab();
    const connectivity: string[] = [];
    const f = await runningFoundation(harness, connectivity);

    const started = await f.startEngine();
    expect(started.state).toBe('running');

    f.suspendForSleep();
    expect((await f.status()).state).toBe('idle'); // stopped, not paused/halted
    await flush(); // let the stopped loop settle out

    harness.calls.length = 0;
    await f.resumeFromSleep({ settleMsOverride: 0 });

    // Ordered: connectivity re-probe, then the tab canary (healthy — no
    // recovery needed), and only THEN the engine restart.
    expect(harness.calls).toEqual(['connectivity', 'checkHealth']);
    expect(connectivity).toHaveLength(1);
    expect((await f.status()).state).toBe('running');

    await f.dispose();
  });

  test('an unhealthy post-wake tab is recovered before anything restarts', async () => {
    const harness = makeTab();
    const connectivity: string[] = [];
    const f = await runningFoundation(harness, connectivity);

    const started = await f.startEngine();
    expect(started.state).toBe('running');
    f.suspendForSleep();
    await flush();

    harness.setHealthy(false); // the sleep teardown killed the CDP layer
    harness.calls.length = 0;
    await f.resumeFromSleep({ settleMsOverride: 0 });

    expect(harness.calls).toEqual(['connectivity', 'checkHealth', 'recoverTab']);
    expect((await f.status()).state).toBe('running');

    await f.dispose();
  });

  test('resume restarts ONLY a previously-running engine — idle stays idle', async () => {
    const harness = makeTab();
    const connectivity: string[] = [];
    const f = await runningFoundation(harness, connectivity);

    // Build the graph, but never start the engine (the user's own idle state).
    await f.ensureBuilt();
    expect((await f.status()).state).toBe('idle');

    f.suspendForSleep();
    harness.calls.length = 0;
    await f.resumeFromSleep({ settleMsOverride: 0 });

    // The wake checks still ran, but no restart was performed.
    expect(harness.calls).toEqual(['connectivity', 'checkHealth']);
    expect((await f.status()).state).toBe('idle');

    await f.dispose();
  });

  test('tab health events during the sleep window are left to the wake sequence', async () => {
    const harness = makeTab();
    const connectivity: string[] = [];
    const f = await runningFoundation(harness, connectivity);
    await f.ensureBuilt();

    f.suspendForSleep();
    // The sleep transition itself tears the renderer down — these must NOT
    // each trigger a recovery while the machine is going to sleep.
    harness.fireUnhealthy('debugger-detach:target closed');
    harness.fireUnhealthy('render-process-gone:killed');
    await flush();
    expect(harness.calls.filter((c) => c === 'recoverTab')).toHaveLength(0);

    // The wake sequence's canary sees the damage and repairs it instead.
    harness.setHealthy(false);
    await f.resumeFromSleep({ settleMsOverride: 0 });
    expect(harness.calls.filter((c) => c === 'recoverTab')).toHaveLength(1);

    await f.dispose();
  });
});
