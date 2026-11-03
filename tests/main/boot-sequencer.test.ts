/**
 * The boot sequence (spec §12.8, Appendix C.3): R2 → R3 (lease) → the landing and confirm-account behind the
 * splash → ready; the reveal (or the settle deadline) → the remaining steps under the same lease → release.
 * Law L-BOOT: phases only advance, and before the reveal only the identity steps touch the tab.
 */

import { BOOT } from '@/kernel/boot-policy';
import { type BootPorts, BootSequencer, type OpenResult } from '@/main/modules/boot-sequencer';
import type { BootView, StartupStep, StartupStepName } from '@/shared/boot';

/** Manual time: `after` queues, `advance` fires what came due. */
function manualTime() {
  let now = 1_000;
  let timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    clock: { now: () => now },
    after(ms: number, fn: () => void): () => void {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
    advance(ms: number): void {
      now += ms;
      const due = timers.filter((t) => t.live && t.at <= now);
      timers = timers.filter((t) => !due.includes(t));
      for (const t of due) t.fn();
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Harness {
  boot: BootSequencer;
  log: string[];
  views: BootView[];
  time: ReturnType<typeof manualTime>;
  released: () => number;
  tour: { held: boolean; release(): void };
}

function step(name: StartupStepName, log: string[], run: (signal: AbortSignal) => Promise<void> = async () => {}, when = () => true): StartupStep {
  return { name, when, run: async (signal) => { log.push(`run:${name}`); await run(signal); log.push(`end:${name}`); } };
}

function harness(over: Partial<BootPorts> & { open?: OpenResult; firstLoad?: Promise<'ready' | 'failed'> } = {}): Harness {
  const time = manualTime();
  const log: string[] = [];
  const views: BootView[] = [];
  let released = 0;
  const listeners: Array<() => void> = [];
  const tour = {
    held: false,
    release(): void {
      tour.held = false;
      for (const l of listeners) l();
    },
  };
  let boot!: BootSequencer;
  boot = new BootSequencer({
    clock: time.clock,
    after: (ms, fn) => time.after(ms, fn),
    openData: async () => { log.push('open'); return over.open ?? { kind: 'open' }; },
    tabFirstLoad: over.firstLoad ?? Promise.resolve('ready'),
    retryTabLoad: async () => { log.push('retry-load'); return 'ready'; },
    claimStartup: () => { log.push('lease'); return () => { released++; log.push('release'); }; },
    tourHeld: () => tour.held,
    onTourReleased: (cb) => { listeners.push(cb); return () => {}; },
    pushStatus: () => views.push(boot.view()),
    identitySteps: [step('open-own-profile', log), step('confirm-account', log)],
    laterSteps: () => [step('catch-up', log), step('resume-run', log)],
    afterStartup: () => log.push('after-startup'),
    ...over,
  });
  return { boot, log, views, time, released: () => released, tour };
}

const PHASES = ['starting', 'ready', 'live'];
const phasesAdvance = (views: BootView[]): boolean =>
  views.every((v, i) => i === 0 || PHASES.indexOf(v.phase) >= PHASES.indexOf(views[i - 1].phase));

test('R2 → R3 with the lease → the identity steps behind the splash → ready; the rest only after the reveal', async () => {
  const h = harness();
  const started = h.boot.start();
  await flush();
  expect(h.log).toEqual(['open', 'lease', 'run:open-own-profile', 'end:open-own-profile',
    'run:confirm-account', 'end:confirm-account']);
  expect(h.boot.view()).toMatchObject({ phase: 'ready', identity: 'signed-in', data: 'open', tab: 'settled', ig: 'ready' });
  h.boot.revealed();
  await started;
  expect(h.log.slice(6)).toEqual(['run:catch-up', 'end:catch-up', 'run:resume-run', 'end:resume-run',
    'release', 'after-startup']);
  expect(h.boot.view()).toMatchObject({ phase: 'live', startup: { step: null, done: true } });
  expect(phasesAdvance(h.views)).toBe(true);
});

test('revealBy is the start plus the later of the data and Instagram deadlines', () => {
  const h = harness();
  void h.boot.start();
  const v = h.boot.view();
  expect(v.revealBy - v.startedAt).toBe(Math.max(BOOT.DATA_DEADLINE_MS, BOOT.IG_READY_DEADLINE_MS));
});

test('a slow landing falls back to the placeholder at the Instagram deadline and finishes under the lease', async () => {
  let finish!: () => void;
  const slow = new Promise<void>((resolve) => { finish = resolve; });
  const s = harness({ identitySteps: [step('open-own-profile', [], () => slow)] });
  const run = s.boot.start();
  await flush();
  expect(s.boot.view().ig).toBe('pending');
  s.time.advance(BOOT.IG_READY_DEADLINE_MS);
  expect(s.boot.view().ig).toBe('placeholder');
  s.boot.revealed();
  await flush();
  expect(s.log).not.toContain('run:catch-up');
  finish();
  await run;
  expect(s.log).toContain('run:catch-up');
  expect(s.boot.view()).toMatchObject({ ig: 'placeholder', startup: { done: true } });
});

test('signed out: no landing, no wait — the placeholder at once, the later steps after the reveal', async () => {
  const h = harness({ open: { kind: 'signed-out' } });
  const started = h.boot.start();
  await flush();
  expect(h.boot.view()).toMatchObject({ identity: 'signed-out', data: 'not-applicable', ig: 'placeholder' });
  expect(h.log).not.toContain('run:open-own-profile');
  h.boot.revealed();
  await started;
  expect(h.log).toContain('run:resume-run');
});

test('data unavailable carries the typed problem', async () => {
  const h = harness({ open: { kind: 'failed', problem: 'future-version', detail: 'newer' } });
  void h.boot.start();
  await flush();
  expect(h.boot.view()).toMatchObject({ phase: 'ready', data: 'unavailable', dataProblem: 'future-version' });
});

test('offline: a failed first load is the placeholder; the next online transition retries once and lands', async () => {
  const h = harness({ firstLoad: Promise.resolve('failed') });
  const started = h.boot.start();
  await flush();
  expect(h.boot.view()).toMatchObject({ tab: 'failed', ig: 'placeholder' });
  expect(h.log).not.toContain('run:open-own-profile');
  h.boot.revealed();
  await started;
  h.boot.onOnline(false);
  h.boot.onOnline(true);
  h.boot.onOnline(true);
  await flush();
  expect(h.log.filter((l) => l === 'retry-load')).toHaveLength(1);
  expect(h.boot.view().tab).toBe('settled');
  expect(h.log.slice(-5)).toEqual(['end:open-own-profile', 'run:confirm-account', 'end:confirm-account', 'release',
    'after-startup']);
});

test('steps run in order and never overlap', async () => {
  const log: string[] = [];
  let active = 0;
  let overlapped = false;
  const timed = (name: StartupStepName): StartupStep => step(name, log, async () => {
    active++;
    if (active > 1) overlapped = true;
    await flush();
    active--;
  });
  const h = harness({ identitySteps: [timed('open-own-profile'), timed('confirm-account')],
    laterSteps: () => [timed('catch-up'), timed('resume-run')] });
  const started = h.boot.start();
  h.boot.revealed();
  await started;
  expect(overlapped).toBe(false);
  expect(log.filter((l) => l.startsWith('run:'))).toEqual(['run:open-own-profile', 'run:confirm-account',
    'run:catch-up', 'run:resume-run']);
});

test('a Start during the sequence is queued and goes after the release; Stop cancels it and the rest', async () => {
  const h = harness();
  const started = h.boot.start();
  const queued = h.boot.queueStart();
  await flush();
  expect(h.boot.view().startup.startQueued).toBe(true);
  h.boot.revealed();
  expect(await queued).toBe(true);
  await started;
  expect(h.boot.view().startup.startQueued).toBe(false);

  let aborted = false;
  const s = harness({ laterSteps: () => [step('catch-up', [], (signal) => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { aborted = true; resolve(); });
  })), step('resume-run', [])] });
  const run = s.boot.start();
  s.boot.revealed();
  await flush();
  const late = s.boot.queueStart();
  s.boot.cancelStartup();
  await run;
  expect(aborted).toBe(true);
  expect(await late).toBe(false);
  expect(s.log).not.toContain('run:resume-run');
  expect(s.released()).toBe(1);
});

test('the settle deadline proceeds when the renderer never reports the reveal', async () => {
  const h = harness();
  const started = h.boot.start();
  await flush();
  expect(h.log).not.toContain('run:catch-up');
  h.time.advance(BOOT.SETTLE_DEADLINE_MS);
  await started;
  expect(h.boot.view().phase).toBe('live');
  expect(h.log).toContain('run:resume-run');
});

test('the tour hold skips the landing until it is released, and the reveal does not wait for it', async () => {
  const h = harness();
  h.tour.held = true;
  const started = h.boot.start();
  await flush();
  expect(h.boot.view().ig).toBe('placeholder');
  expect(h.log).not.toContain('run:open-own-profile');
  h.boot.revealed();
  await flush();
  expect(h.log).not.toContain('run:catch-up');
  h.tour.release();
  await started;
  expect(h.log.filter((l) => l.startsWith('run:'))).toEqual(['run:open-own-profile', 'run:confirm-account',
    'run:catch-up', 'run:resume-run']);
});

test('L-BOOT: before the reveal only the identity steps run, whatever the timing', async () => {
  const h = harness();
  const started = h.boot.start();
  await flush();
  h.time.advance(BOOT.IG_READY_DEADLINE_MS);
  await flush();
  const beforeReveal = h.log.filter((l) => l.startsWith('run:'));
  expect(beforeReveal.every((l) => l === 'run:open-own-profile' || l === 'run:confirm-account')).toBe(true);
  h.boot.revealed();
  await started;
  expect(phasesAdvance(h.views)).toBe(true);
});

test('login reuses the identity steps under the lease, after the boot sequence', async () => {
  const h = harness();
  const started = h.boot.start();
  const login = h.boot.runIdentitySteps();
  h.boot.revealed();
  await started;
  await login;
  expect(h.log.slice(-7)).toEqual(['lease', 'run:open-own-profile', 'end:open-own-profile', 'run:confirm-account',
    'end:confirm-account', 'release', 'after-startup']);
});
