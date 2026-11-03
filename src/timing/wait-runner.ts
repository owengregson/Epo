/**
 * WaitRunner — the ONE gate every engine wait passes through.
 *
 * Owns the DelayManager for a keyspace: it applies the per-key noise class,
 * registers the wait, exposes the real (jittered) deadline synchronously so a
 * park can be published BEFORE it is awaited, and reports how the wait ended.
 * Both loops construct one, so "a classified key can never reach the delay
 * manager un-noised" is a structural property rather than a source-text rule.
 */

import type { Clock } from '../governors/clock';
import type { TempoSource } from '../kernel/tempo';
import type { DelayManager, WaitResult } from './delay-manager';
import { boundarySeedKey, jitterBoundary, noisify, type WaitClass } from './noise';
import type { DelayPolicy, Rng } from './primitives';

/** Hooks the owner uses to publish a wait's life to its status projection. */
export interface WaitRunnerHooks<K extends string, P extends string> {
  /**
   * Called SYNCHRONOUSLY after registration — before the first await — with the
   * real jittered deadline, so a multi-hour hold is visible the moment it starts.
   */
  onRegistered?(key: K, deadline: number, park: P | null): void;
  /** Called once the wait settles, however it ended (elapsed, paused, aborted). */
  onSettled?(key: K, park: P | null): void;
}

export interface WaitRunnerDeps<K extends string, P extends string> {
  delays: DelayManager;
  clock: Clock;
  /** The per-key noise classification — total over the key union. */
  classes: Readonly<Record<K, WaitClass>>;
  /**
   * The DEDICATED noise rng. Never the owner's seeded stream: noise draws must
   * not shift the draw order any seeded test depends on.
   */
  noiseRng: Rng;
  /** The session tempo a local beat's band follows (`pause.retry`); the reference when absent. */
  tempo?: TempoSource;
  /** Per-install entropy seeding restart-stable daily-boundary jitter. */
  installEntropy?: number;
  /** Which keys are LONG parks the status surfaces; null for step-scale waits. */
  parkReason?(key: K): P | null;
  /** The abort signal each wait links to, read fresh (the run generation token). */
  signal(): AbortSignal;
  hooks?: WaitRunnerHooks<K, P>;
}

export class WaitRunner<K extends string, P extends string = never> {
  private readonly deps: WaitRunnerDeps<K, P>;

  constructor(deps: WaitRunnerDeps<K, P>) {
    this.deps = deps;
  }

  /**
   * Wait `policyOrMs` under `key`, noised by its class and linked to the current
   * run generation. Resolves `{ completed: false }` when a control command
   * interrupted it — never rejects.
   */
  async wait(key: K, policyOrMs: DelayPolicy | number): Promise<WaitResult> {
    const { delays, clock, hooks } = this.deps;
    const wait = delays.wait(key, this.noised(key, policyOrMs), { signal: this.deps.signal() });
    // Registration is synchronous (before the wait's first internal await), so
    // the real deadline is readable — and publishable — before awaiting.
    const park = this.deps.parkReason?.(key) ?? null;
    hooks?.onRegistered?.(key, delays.nextDeadline(key) ?? clock.now(), park);
    try {
      return await wait;
    } finally {
      hooks?.onSettled?.(key, park);
    }
  }

  /**
   * The noise gate, by class:
   *
   *  - 'daily-boundary': a POSITIVE-ONLY offset seeded by the RESUME day's key
   *    ⊕ the wait key ⊕ the install entropy — stable within a day and across a
   *    mid-park restart, different per day, per key, per install. Applied
   *    BEFORE registration, so the published deadline is the real one.
   *  - every other non-exact class: a noisified policy drawing from the
   *    dedicated noise rng.
   *  - 'exact': untouched — the call site already drew its own jitter.
   */
  noised(key: K, policyOrMs: DelayPolicy | number): DelayPolicy | number {
    const cls = this.deps.classes[key];
    if (cls === 'exact') return policyOrMs;
    if (cls === 'daily-boundary') {
      const base =
        typeof policyOrMs === 'number' ? policyOrMs : policyOrMs.sample(this.deps.noiseRng);
      const resumeAt = this.deps.clock.now() + base;
      return jitterBoundary(base, boundarySeedKey(resumeAt, key), this.deps.installEntropy ?? 0);
    }
    return noisify(cls, policyOrMs, this.deps.noiseRng, this.deps.tempo);
  }

  /** The deadline of the in-flight wait under `key`, or null when none is pending. */
  nextDeadline(key: K): number | null {
    return this.deps.delays.nextDeadline(key);
  }

  /** Cancel every pending wait whose key starts with `prefix`. */
  cancelAll(prefix: string): number {
    return this.deps.delays.cancelAll(prefix);
  }
}
