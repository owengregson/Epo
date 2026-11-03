/**
 * The boot sequence (spec §12.8, ADR 1010): R2 identity and R3 the store-first open, the `'startup'` tab lease
 * claimed at R3, the landing and confirm-account behind the splash (R5), then — after the reveal or the
 * settle deadline — the remaining startup steps under the same lease. Readiness rides `EpoStatus.boot`.
 */

import { BOOT } from '@/kernel/boot-policy';
import type { BootDataProblem, BootView, StartupStep, StartupStepName } from '@/shared/boot';
import * as logger from '@/utils/logger';

export type OpenResult =
  | { kind: 'open' }
  | { kind: 'signed-out' }
  | { kind: 'failed'; problem: BootDataProblem; detail: string };

export interface BootPorts {
  clock: { now(): number };
  /** Injected timers (tests use manual time); returns the cancel. */
  after(ms: number, fn: () => void): () => void;
  /** R2 + R3: the cookie, then the store-first open. Never navigates the tab; never throws. */
  openData(): Promise<OpenResult>;
  /** The shell's first home navigation. */
  tabFirstLoad: Promise<'ready' | 'failed'>;
  /** One home load after a failed first load, on an online transition. */
  retryTabLoad(): Promise<'ready' | 'failed'>;
  /** The `'startup'` tab lease; null when another driver holds the tab. Returns the release. */
  claimStartup(): (() => void) | null;
  tourHeld(): boolean;
  onTourReleased(cb: () => void): () => void;
  /** Boot rides EpoStatus: re-push on every transition. */
  pushStatus(): void;
  /** Steps 1–2 (open-own-profile, confirm-account): behind the splash; login reuses them. */
  identitySteps: readonly StartupStep[];
  /** Steps 3–4, read after the reveal: the current graph's own steps (catch-up), then resume-run. */
  laterSteps(): readonly StartupStep[];
  /** Runs whenever the startup lease is released. */
  afterStartup(): void;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
type Gate = { open(): boolean; resolve(): void };
const PHASES: readonly BootView['phase'][] = ['starting', 'ready', 'live'];

export class BootSequencer {
  private readonly p: BootPorts;
  private readonly s: Writable<Omit<BootView, 'startup'>>;
  private step: StartupStepName | null = null;
  private startQueued = false;
  private started = false;
  private sequenceDone = false;
  private revealedFlag = false;
  /** Startup work under the lease (the sequence, a login's identity steps, an online retry). */
  private holding = 0;
  private cancelled = false;
  /** Bumped by every Stop: a Start queued before it does not go. */
  private cancels = 0;
  private abort: AbortController | null = null;
  /** The identity steps did not run (the first load failed); the next successful load runs them. */
  private identityOwed = false;
  private online = true;
  private retrying = false;
  private gates: Gate[] = [];
  private idle: Array<() => void> = [];
  private readonly disposers: Array<() => void> = [];

  constructor(ports: BootPorts) {
    this.p = ports;
    const now = ports.clock.now();
    this.s = {
      phase: 'starting', identity: 'pending', data: 'pending', dataProblem: null, tab: 'loading', ig: 'pending',
      startedAt: now, revealBy: now + Math.max(BOOT.DATA_DEADLINE_MS, BOOT.IG_READY_DEADLINE_MS),
    };
    this.disposers.push(ports.onTourReleased(() => this.kick()));
  }

  /** A pure snapshot (rides `EpoStatus.boot`). */
  view(): BootView {
    return { ...this.s, startup: { step: this.step, startQueued: this.startQueued, done: this.sequenceDone } };
  }

  /** True while startup work holds the tab: Start queues, manual work is refused with `'starting'`. */
  busy(): boolean {
    return this.holding > 0;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.holding++;
    const now = this.p.clock.now();
    this.s.startedAt = now;
    this.s.revealBy = now + Math.max(BOOT.DATA_DEADLINE_MS, BOOT.IG_READY_DEADLINE_MS);
    this.disposers.push(this.p.after(BOOT.SETTLE_DEADLINE_MS, () => this.revealed()));
    this.disposers.push(this.p.after(BOOT.IG_READY_DEADLINE_MS, () => this.setIg('placeholder')));
    void this.p.tabFirstLoad.then((result) => this.settleTab(result));
    this.push();
    let release: (() => void) | null = null;
    try {
      const open = await this.p.openData();
      this.s.identity = open.kind === 'signed-out' ? 'signed-out' : 'signed-in';
      this.s.data = open.kind === 'open' ? 'open' : open.kind === 'signed-out' ? 'not-applicable' : 'unavailable';
      this.s.dataProblem = open.kind === 'failed' ? open.problem : null;
      if (open.kind === 'failed') logger.error('boot: the store did not open', { problem: open.problem, detail: open.detail });
      release = this.p.claimStartup();
      this.advance('ready');
      if (this.revealedFlag) this.advance('live');
      await this.identityPhase(release !== null);
      await this.until(() => this.revealedFlag || this.cancelled);
      await this.runSteps(this.p.laterSteps());
    } finally {
      release?.();
      this.sequenceDone = true;
      this.endHold();
    }
  }

  /** The renderer's intro ended (or the settle deadline passed): `'live'`, and steps 3–4 may run. Idempotent. */
  revealed(): void {
    if (this.revealedFlag) return;
    this.revealedFlag = true;
    if (this.s.phase === 'ready') this.advance('live');
    this.kick();
  }

  whenStartupDone(): Promise<void> {
    if (this.holding === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  noteStartQueued(queued: boolean): void {
    if (this.startQueued === queued) return;
    this.startQueued = queued;
    this.push();
  }

  /** A user Start waits for startup work (never refused); false when a Stop came while it waited. */
  async queueStart(): Promise<boolean> {
    if (this.holding === 0) return true;
    const cancels = this.cancels;
    this.noteStartQueued(true);
    await this.whenStartupDone();
    this.noteStartQueued(false);
    return cancels === this.cancels;
  }

  /** login(): open-own-profile and confirm-account under the lease, after any startup work. */
  async runIdentitySteps(): Promise<void> {
    await this.whenStartupDone();
    await this.leased(() => this.runSteps(this.p.identitySteps));
  }

  /** Stop: the running step's signal aborts and the rest are skipped. */
  cancelStartup(): void {
    if (this.holding === 0) return;
    this.cancelled = true;
    this.cancels++;
    this.abort?.abort();
    this.setIg('placeholder');
    this.kick();
  }

  /** Retries a failed first load once per online transition (then owed identity steps run). */
  onOnline(online: boolean): void {
    const back = online && !this.online;
    this.online = online;
    if (!back || this.s.tab !== 'failed' || this.retrying) return;
    this.retrying = true;
    void this.retryLoad()
      .catch((error: unknown) => logger.error('boot: home reload failed', { error: String(error) }))
      .finally(() => { this.retrying = false; });
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.cancelStartup();
  }

  private async retryLoad(): Promise<void> {
    await this.whenStartupDone();
    await this.leased(async () => {
      this.settleTab(await this.p.retryTabLoad());
      if (this.s.tab !== 'settled' || !this.identityOwed || this.s.identity !== 'signed-in') return;
      this.identityOwed = false;
      await this.runSteps(this.p.identitySteps);
    });
  }

  /** Run `work` under a fresh startup lease; skipped (logged) when another driver holds the tab. */
  private async leased(work: () => Promise<void>): Promise<void> {
    const release = this.p.claimStartup();
    if (release === null) {
      logger.info('boot: startup work skipped, another driver holds the tab');
      return;
    }
    this.holding++;
    try {
      await work();
    } finally {
      release();
      this.endHold();
    }
  }

  private async identityPhase(leased: boolean): Promise<void> {
    if (this.s.identity !== 'signed-in' || !leased) return this.setIg('placeholder');
    if ((await this.p.tabFirstLoad) === 'failed') {
      this.identityOwed = true;
      return this.setIg('placeholder');
    }
    if (this.p.tourHeld()) {
      this.setIg('placeholder');
      await this.until(() => !this.p.tourHeld() || this.cancelled);
    }
    await this.runSteps(this.p.identitySteps);
    this.setIg('ready');
  }

  private async runSteps(steps: readonly StartupStep[]): Promise<void> {
    for (const step of steps) {
      if (this.cancelled) return;
      if (!step.when()) continue;
      const abort = new AbortController();
      this.abort = abort;
      this.step = step.name;
      this.push();
      try {
        await step.run(abort.signal);
      } catch (error) {
        logger.error('boot: startup step failed', { step: step.name, error: String(error) });
      } finally {
        this.abort = null;
        this.step = null;
        this.push();
      }
    }
  }

  private endHold(): void {
    this.holding--;
    if (this.holding > 0) return;
    this.cancelled = false;
    this.push();
    for (const resolve of this.idle.splice(0)) resolve();
    this.p.afterStartup();
  }

  private settleTab(result: 'ready' | 'failed'): void {
    this.s.tab = result === 'ready' ? 'settled' : 'failed';
    this.push();
  }

  /** R5 decides once: `'ready'` or `'placeholder'`. */
  private setIg(ig: 'ready' | 'placeholder'): void {
    if (this.s.ig !== 'pending') return;
    this.s.ig = ig;
    this.push();
  }

  /** Phases only advance (law L-BOOT). */
  private advance(phase: BootView['phase']): void {
    if (PHASES.indexOf(phase) <= PHASES.indexOf(this.s.phase)) return;
    this.s.phase = phase;
    this.push();
  }

  private until(open: () => boolean): Promise<void> {
    if (open()) return Promise.resolve();
    return new Promise((resolve) => this.gates.push({ open, resolve }));
  }

  private kick(): void {
    const opened = this.gates.filter((g) => g.open());
    this.gates = this.gates.filter((g) => !opened.includes(g));
    for (const gate of opened) gate.resolve();
  }

  private push(): void {
    this.p.pushStatus();
  }
}
