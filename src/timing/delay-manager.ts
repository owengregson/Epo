/**
 * DelayManager — the ONE owner of in-flight operational waits.
 *
 * Every engine wait goes through `wait(key, policy, { signal })`: the wait is
 * REGISTERED (key, startedAt, deadline) while pending, LINKED to the caller's
 * abort signal (replacing the per-engine `interruptibleSleep` copies), and
 * OBSERVABLE — `pending()` / `nextDeadline()` / `onChange` give the main process
 * real deadlines to push to the renderer, so the countdown shows the actual
 * next-action time instead of estimating.
 *
 * Waits resolve `{ completed: false }` on abort/cancel — they NEVER reject (E1).
 * Registration happens synchronously (before the first internal await), so a
 * caller may start a wait, then read its deadline, then await it.
 */

import type { Clock } from '../governors/clock';
import {
  type DelayPolicy,
  type Rng,
  type SleepFn,
  sample,
  sleep as realSleep,
} from './primitives';

/** One registered in-flight wait — why we're waiting and until when. */
export interface PendingDelay {
  key: string;
  label: string | undefined;
  startedAt: number;
  deadline: number;
  ms: number;
}

export interface WaitResult {
  completed: boolean;
}

export interface WaitOpts {
  /** External abort (an engine's run-generation token): aborting resolves the wait. */
  signal?: AbortSignal;
  /** Optional human-readable annotation surfaced through `pending()`. */
  label?: string;
}

export interface DelayManagerDeps {
  clock: Clock;
  /** Randomness for policy sampling; injectable for deterministic tests. */
  rng?: Rng;
  /** Injected sleep; defaults to a real interruptible setTimeout. */
  sleep?: SleepFn;
}

interface ActiveWait {
  controller: AbortController;
  entry: PendingDelay;
}

export class DelayManager {
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly sleepFn: SleepFn;
  private readonly waits = new Map<string, ActiveWait>();
  private readonly listeners = new Set<(pending: PendingDelay[]) => void>();

  constructor(deps: DelayManagerDeps) {
    this.clock = deps.clock;
    this.rng = deps.rng ?? Math.random;
    this.sleepFn = deps.sleep ?? realSleep;
  }

  /**
   * Wait `policyOrMs` under `key`. A key is a SINGLETON wait: starting a new
   * wait under a live key cancels the previous one first (a stale wait must
   * never shadow the current deadline). Resolves `{ completed: false }` when
   * cancelled or when `opts.signal` aborts.
   */
  async wait(
    key: string,
    policyOrMs: DelayPolicy | number,
    opts: WaitOpts = {},
  ): Promise<WaitResult> {
    const ms = sample(policyOrMs, this.rng);
    this.cancel(key);

    const controller = new AbortController();
    const external = opts.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external !== undefined) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    const startedAt = this.clock.now();
    const entry: PendingDelay = { key, label: opts.label, startedAt, deadline: startedAt + ms, ms };
    this.waits.set(key, { controller, entry });
    this.emitChange();

    try {
      await this.sleepFn(ms, controller.signal);
      return { completed: !controller.signal.aborted };
    } finally {
      // Only clear our own registration — a replaced wait resolving late must
      // not delete its successor's entry (mirrors the engines' R2 guard).
      if (this.waits.get(key)?.controller === controller) {
        this.waits.delete(key);
        this.emitChange();
      }
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Cancel the wait under `key`; returns whether one was pending. */
  cancel(key: string): boolean {
    const active = this.waits.get(key);
    if (active === undefined) return false;
    active.controller.abort();
    return true;
  }

  /** Cancel every pending wait whose key starts with `prefix` (all when omitted). */
  cancelAll(prefix = ''): number {
    let n = 0;
    for (const [key, active] of this.waits) {
      if (!key.startsWith(prefix)) continue;
      active.controller.abort();
      n += 1;
    }
    return n;
  }

  /** Snapshot of every in-flight wait. */
  pending(): PendingDelay[] {
    return [...this.waits.values()].map((w) => ({ ...w.entry }));
  }

  /** The deadline of the wait under `key`, or null when none is pending. */
  nextDeadline(key: string): number | null {
    return this.waits.get(key)?.entry.deadline ?? null;
  }

  /** Subscribe to pending-set changes; returns the unsubscriber. */
  onChange(listener: (pending: PendingDelay[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cancel everything and drop all listeners. Idempotent. */
  dispose(): void {
    this.cancelAll();
    this.listeners.clear();
  }

  private emitChange(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.pending();
    for (const listener of this.listeners) listener(snapshot);
  }
}
