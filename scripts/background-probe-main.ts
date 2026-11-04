/** Bundled by background-probe.mjs against the actual production tab/driver. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { arch, release } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BaseWindow, powerMonitor, powerSaveBlocker, screen, session, WebContentsView } from 'electron';
import { IG_PARTITION, InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { applyBackgroundSurvivalSwitches } from '@/main/bootstrap';
import { RuntimePower } from '@/main/runtime-power';

const option = (key: string, fallback: string): string => {
  const at = process.argv.indexOf(key);
  return at < 0 ? fallback : process.argv[at + 1] ?? fallback;
};
const soakMs = Number(option('--soak-ms', '0'));
const only = option('--only', '');
const selected = new Set(only.split(',').filter(Boolean));
if (!Number.isFinite(soakMs) || soakMs < 0) throw new Error('Invalid --soak-ms');
const profile = process.env.EPO_PROBE_PROFILE;
if (!profile) throw new Error('Use node scripts/background-probe.mjs');
app.setName('Epo Local Background Probe');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
applyBackgroundSurvivalSwitches();

interface Snapshot {
  frames: number; timers: number; clicks: number; trustedClicks: number;
  wheels: number; trustedWheels: number; moves: number; trustedMoves: number;
  asyncAcks: number; maximumTimerGap: number; scrollTop: number;
  visibility: string; focused: boolean;
}

const html = readFileSync(path.resolve('scripts/background-probe.html'));
const server = createServer((request, response) => {
  if (request.url === '/headers') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.headers));
  } else if (request.url === '/cover') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><body style="margin:0;background:#fff">Opaque local dashboard fixture</body></html>');
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(html);
  }
});
const results: Record<string, unknown>[] = [];
const unhealthy: string[] = [];
const clickGuards: Record<string, boolean> = {};
let tab: InstagramTab | undefined;
let win: BaseWindow | undefined;
let occluder: BaseWindow | undefined;
let power: RuntimePower | undefined;
let finishing = false;
const finish = (code: number): void => {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  try { tab?.dispose(); } catch (error) { console.error('Probe tab teardown failed', error); }
  power?.dispose();
  server.close();
  app.exit(code);
};
const timeout = setTimeout(() => {
  console.error('Background probe exceeded its overall deadline');
  finish(1);
}, soakMs + 120_000);

app.whenReady().then(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback server');
  const origin = `http://127.0.0.1:${address.port}`;
  session.fromPartition(IG_PARTITION).webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${origin}/`) });
  });
  power = new RuntimePower({
    blocker: powerSaveBlocker, monitor: powerMonitor,
    suspend: () => unhealthy.push('Unexpected system sleep during probe'),
    resume: async () => {},
  });
  power.start();
  win = new BaseWindow({ width: 1000, height: 800, show: false, title: 'Epo local background probe' });
  const dashboard = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  dashboard.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
  win.contentView.addChildView(dashboard);
  await dashboard.webContents.loadURL(`${origin}/cover`);
  tab = new InstagramTab();
  tab.onUnhealthy((reason) => unhealthy.push(reason));
  tab.attach(win);
  tab.setBounds({ x: 110, y: 90, width: 760, height: 560 });
  // never-shown-boot (spec §12.8): like the production launch, the window is built hidden with the tab
  // re-stacked under the opaque dashboard, the page loads while the window was never shown, and the window
  // is revealed a second later; the scenario below then measures input on that tab.
  const neverShownBoot = selected.size === 0 || selected.has('never-shown-boot');
  if (neverShownBoot) tab.hide();
  else tab.show();
  let inputAcknowledgments = 0;
  let longestDispatchMs = 0;
  let gestureDeadline = Number.POSITIVE_INFINITY;
  let pendingInput: { type: string; since: number } | null = null;
  const dispatchInput = tab.sendInputEvent.bind(tab);
  tab.sendInputEvent = async (event) => {
    if (event.type === 'mouseMove' && performance.now() > gestureDeadline) {
      throw new Error('Probe gesture throughput deadline exceeded');
    }
    const started = performance.now();
    pendingInput = { type: event.type, since: started };
    try {
      await dispatchInput(event);
      inputAcknowledgments++;
      longestDispatchMs = Math.max(longestDispatchMs, performance.now() - started);
    } finally { pendingInput = null; }
  };
  const interactor = createTabInteractor(tab);
  await tab.goto(`${origin}/`);
  if (neverShownBoot) {
    await delay(1000);
    tab.show();
  }
  win.show();
  win.focus();
  const identity = await tab.evaluate(`(async () => ({
    userAgent: navigator.userAgent, platform: navigator.platform,
    languages: navigator.languages, webdriver: navigator.webdriver,
    userAgentData: navigator.userAgentData?.toJSON(),
    highEntropy: await navigator.userAgentData?.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'fullVersionList']),
    headers: await fetch('/headers').then(r => r.json()),
  }))()`);
  console.log(JSON.stringify({ identity }));
  const target = { x: 40, y: 60, width: 200, height: 64 };
  const point = { x: 130, y: 85 };
  const replacementGuard = await tab.prepareClick(target, point);
  clickGuards.originalTargetAccepted = await replacementGuard.validate();
  await tab.evaluate(`(() => {
    const original = document.querySelector('#target');
    const replacement = original.cloneNode(true);
    original.replaceWith(replacement);
    window.restoreProbeTarget = () => { replacement.replaceWith(original); delete window.restoreProbeTarget; };
  })()`);
  clickGuards.samePositionReplacementRejected = !(await replacementGuard.validate());
  await replacementGuard.dispose();
  await tab.evaluate('restoreProbeTarget()');
  const coveredGuard = await tab.prepareClick(target, point);
  await tab.evaluate(`(() => {
    const cover = document.createElement('div'); cover.id = 'probe-cover';
    cover.style.cssText = 'position:fixed;inset:0;z-index:999;background:white';
    document.body.append(cover);
  })()`);
  clickGuards.coveredTargetRejected = !(await coveredGuard.validate());
  await coveredGuard.dispose();
  await tab.evaluate("document.querySelector('#probe-cover').remove()");
  console.log(JSON.stringify({ clickGuards }));
  // Liveness alone missed the global frame-limit regression: input survived,
  // but the dashboard could render thousands of frames/s and starve the GPU.
  // Exercise a changing DOM surface as well as the background tab's rAF loop.
  const dashboardFrames = await dashboard.webContents.executeJavaScript(`new Promise(resolve => {
    let frames = 0;
    const start = performance.now();
    const tick = now => {
      frames++;
      document.body.style.opacity = String(0.9 + 0.1 * Math.sin(now / 1000));
      if (now - start < 1500) requestAnimationFrame(tick);
      else {
        document.body.style.opacity = '';
        resolve({ frames, elapsedMs: now - start, fps: frames * 1000 / (now - start) });
      }
    };
    requestAnimationFrame(tick);
  })`) as { frames: number; elapsedMs: number; fps: number };
  const refreshHz = screen.getDisplayMatching(win.getBounds()).displayFrequency;
  const maximumFps = (refreshHz > 0 ? Math.max(60, refreshHz) : 240) * 1.25;
  const dashboardPacing = {
    ...dashboardFrames, refreshHz, maximumFps,
    passed: dashboardFrames.fps >= 10 && dashboardFrames.fps <= maximumFps,
  };
  console.log(JSON.stringify({ dashboardPacing }));
  const scenario = async (name: string, change: () => void | Promise<void>, duration = 1800): Promise<void> => {
    if (selected.size > 0 && !selected.has(name)) return;
    await change();
    await delay(350);
    const dashboardFocusBefore = dashboard.webContents.isFocused();
    console.log(JSON.stringify({ starting: name }));
    const healthBefore = await tab!.checkHealth();
    const before = await tab!.evaluate<Snapshot>('probeSnapshot()');
    longestDispatchMs = 0;
    console.log(JSON.stringify({ measuring: name, before }));
    const mainGaps: number[] = [];
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      mainGaps.push(now - previous);
      previous = now;
    }, 25);
    const progress = setInterval(() => console.log(JSON.stringify({
      progress: name, inputAcknowledgments, longestDispatchMs,
      pendingInput: pendingInput ? { type: pendingInput.type, elapsedMs: performance.now() - pendingInput.since } : null,
    })), 15_000);
    const start = performance.now();
    gestureDeadline = start + duration + 30_000;
    try {
      const gestures = async (): Promise<void> => {
        for (let i = 0; i < 4; i++) {
          await interactor.click({ x: 40, y: 60, width: 200, height: 64 });
        }
        await interactor.scroll({ x: 320, y: 200, width: 300, height: 250 }, 200);
      };
      await gestures();
      await delay(Math.max(0, duration - (performance.now() - start)));
      // The long-soak scenario must prove input still arrives AFTER the
      // five-minute intensive-throttling threshold, not just before it.
      await gestures();
      await delay(150);
      const after = await tab!.evaluate<Snapshot>('probeSnapshot()');
      const delta = (key: keyof Snapshot): number => Number(after[key]) - Number(before[key]);
      const elapsed = performance.now() - start;
      const healthAfter = await tab!.checkHealth();
      const dashboardFocusAfter = dashboard.webContents.isFocused();
      const windowStateMatches = name === 'minimized' ? win!.isMinimized()
        : name.startsWith('hidden') || name === 'window-hidden' || name === 'app-hidden' ? !win!.isVisible()
        : name === 'occluded-unfocused' ? !win!.isFocused() : true;
      const focusMatches = name !== 'stage-hidden-dashboard-focused' || (dashboardFocusBefore && dashboardFocusAfter);
      const passed = windowStateMatches && focusMatches && healthBefore.healthy && healthAfter.healthy &&
        delta('clicks') === 8 && delta('trustedClicks') === 8 &&
        delta('asyncAcks') === 8 && delta('trustedWheels') >= 1 &&
        after.scrollTop > before.scrollTop && delta('frames') > elapsed / 100 &&
        delta('timers') > elapsed / 100;
      const row = {
        name, passed, elapsedMs: Math.round(elapsed),
        healthBefore, healthAfter,
        window: { visible: win!.isVisible(), minimized: win!.isMinimized(), focused: win!.isFocused(),
          appHidden: process.platform === 'darwin' ? app.isHidden() : undefined },
        page: { visibility: after.visibility, focused: after.focused },
        dashboardFocus: { before: dashboardFocusBefore, after: dashboardFocusAfter },
        frames: delta('frames'), timerTicks: delta('timers'),
        maximumRendererTimerGapMs: after.maximumTimerGap,
        maximumMainTimerGapMs: Math.max(...mainGaps),
        longestInputDispatchMs: longestDispatchMs,
        clicks: delta('clicks'), trustedClicks: delta('trustedClicks'),
        pointerMoves: delta('moves'), trustedPointerMoves: delta('trustedMoves'),
        asyncAcknowledgments: delta('asyncAcks'), trustedWheels: delta('trustedWheels'),
        scrollDelta: after.scrollTop - before.scrollTop,
      };
      results.push(row);
      console.log(JSON.stringify(row));
    } finally {
      clearInterval(timer);
      clearInterval(progress);
      gestureDeadline = Number.POSITIVE_INFINITY;
    }
  };
  // Input ACKs after a boot that loaded the page in a never-shown window (zero Instagram traffic: loopback only).
  await scenario('never-shown-boot', () => win!.focus());
  await scenario('foreground', () => win!.focus());
  occluder = new BaseWindow({ width: 1100, height: 850, title: 'Local probe occluder' });
  occluder.setBounds(win.getBounds());
  await scenario('occluded-unfocused', () => { occluder!.show(); occluder!.focus(); });
  await scenario('minimized', () => { occluder!.hide(); win!.minimize(); });
  await scenario('window-hidden', async () => { win!.restore(); await delay(500); win!.hide(); });
  if (process.platform === 'darwin' && (selected.size === 0 || selected.has('app-hidden'))) {
    await scenario('app-hidden', () => { win!.showInactive(); app.hide(); });
    app.show();
    await delay(350);
  }
  await scenario('stage-hidden', () => {
    win!.showInactive();
    tab!.hide();
  });
  // Settings and renderer modals own native keyboard focus while the working tab stays underneath.
  await scenario('stage-hidden-dashboard-focused', () => {
    win!.show();
    win!.focus();
    tab!.hide();
    dashboard.webContents.focus();
  });
  tab.show();
  win.hide();
  await tab.goto(`${origin}/after-navigation`);
  await scenario('hidden-after-navigation', () => {});
  await tab.recoverTab();
  await scenario('hidden-after-recovery', () => {});
  if (soakMs > 0) await scenario('hidden-long-soak', () => {}, soakMs);
  const passed = dashboardPacing.passed && results.length > 0 && results.every((row) => row.passed === true) &&
    Object.values(clickGuards).every(Boolean) && unhealthy.length === 0;
  const report = {
    measuredAt: new Date().toISOString(), passed,
    bundleSha256: process.env.EPO_PROBE_BUNDLE_SHA256,
    runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
      platform: process.platform, osRelease: release(), arch: arch() },
    isolation: { temporaryProfile: true, network: 'loopback only', productionTabAndDriver: true },
    configuration: { only, soakMs,
      frameRateLimitDisabled: app.commandLine.hasSwitch('disable-frame-rate-limit') },
    identity, clickGuards, dashboardPacing, results, unhealthy,
    limitations: ['No forced OS sleep, lid close, display-off, network outage, Windows or Linux measurement.',
      'Local fixture verifies page progress and input transport; it does not validate Instagram behavior or detection.'],
  };
  writeFileSync(path.resolve(option('--output', 'background-probe.json')), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Background probe ${passed ? 'PASS' : 'FAIL'} (${results.length} scenarios)`);
  finish(passed ? 0 : 1);
}).catch((error: unknown) => {
  if (finishing) return;
  console.error(error);
  finish(1);
});
