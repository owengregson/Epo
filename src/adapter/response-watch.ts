/**
 * ResponseWatch — arm an expected response BEFORE the interaction that fires it.
 *
 * The generalisation of `MutationWatch`. The pattern it encodes is the one that
 * made follow/unfollow arbitration correct (ADR 0304): subscribe first, act
 * second, and let the SERVER's answer decide — because Instagram's web client
 * flips the header button optimistically and snaps it back when refused, so the
 * DOM alone reports either a phantom success or an anonymous failure.
 *
 * Generalising it matters beyond mutations: the notifications drawer and the
 * follow-requests panel currently click and hope, then poll for a body that may
 * already have arrived. With a watch armed on the endpoint they expect, they
 * observe instead of guessing.
 *
 * A tab without the response seam (a plain test fake) makes the watch inert —
 * `available` is false and `next` resolves `null` at once, which is exactly the
 * DOM-only path that existed before.
 */

import { ActionAbortedError } from '@/adapter/errors';
import type { MaybeObservable } from '@/adapter/tab-ports';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';
import type { ResponseHandler, TabResponse, Unsubscribe } from '@/types';

/** What a watch is armed on: a predicate over the request, and how to read it. */
export interface WatchSpec<T> {
  /** A label for the logs (`actor.follow`, `drawer.open`). */
  op: string;
  /** Does this response belong to what we armed for? */
  matches(response: TabResponse): boolean;
  /**
   * Turn a matched response into the observation. May read the body; a throw is
   * NOT swallowed into a fabricated result — it is passed to {@link onError}
   * so the caller decides, exactly as ADR 0303 requires.
   */
  read(response: TabResponse): Promise<T>;
  /** Called when `read` throws; return the observation to use, or `null` to skip. */
  onError(response: TabResponse, error: unknown): T | null;
  /**
   * Optional: every response seen while armed that did NOT match. Lets a watch
   * that times out say what it saw instead — the evidence a drifted match
   * table needs. Must be cheap and must not read the body.
   */
  onUnmatched?(response: TabResponse): void;
}

export class ResponseWatch<T> {
  /** False when the tab exposes no response seam — the watch never observes. */
  readonly available: boolean;
  /** When the watch was armed (epoch ms) — the meter's press→arrival baseline. */
  readonly armedAt: number;
  private readonly spec: WatchSpec<T>;
  private readonly now: () => number;
  private unsubscribe: Unsubscribe | null = null;
  private observed: T | null = null;
  private observedAt = 0;
  private pressedAt: number;
  private matched = false;
  private waiter: ((value: T) => void) | null = null;

  constructor(spec: WatchSpec<T>, tab: MaybeObservable, now: () => number = Date.now) {
    this.spec = spec;
    this.now = now;
    this.armedAt = now();
    this.pressedAt = this.armedAt;
    this.available = typeof tab.onResponse === 'function';
    if (!this.available) return;
    this.unsubscribe = (tab.onResponse as (h: ResponseHandler) => Unsubscribe)((response) =>
      this.onResponse(response),
    );
  }

  /** How long the observation took to arrive after the last press (or the arming), in ms; `null` if none has. */
  latencyMs(): number | null {
    return this.observed === null ? null : this.observedAt - this.pressedAt;
  }

  /** The observation if one has arrived, without waiting: a confirm-layer loop's evidence check. */
  peek(): T | null {
    return this.observed;
  }

  /** Re-base the latency on the press that may fire the response; a no-op once a match arrived. */
  markPress(): void {
    if (!this.matched) this.pressedAt = this.now();
  }

  /**
   * The first matching observation, or `null` when none arrives within
   * `timeoutMs`. Throws {@link ActionAbortedError} when the driver's abort
   * signal fires mid-wait — a user Stop must not sit out the window, and it is
   * neither drift nor a failure.
   */
  async next(timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
    if (!this.available) return null;
    if (this.observed !== null) return this.observed;
    if (signal?.aborted) throw new ActionAbortedError(this.spec.op);

    let onAbort: (() => void) | null = null;
    const arrival = new Promise<T | 'aborted'>((resolve) => {
      this.waiter = resolve as (value: T) => void;
      if (signal) {
        onAbort = (): void => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      const winner = await withTimeout(arrival, timeoutMs);
      if (winner === 'aborted') throw new ActionAbortedError(this.spec.op);
      if (winner === TIMED_OUT) return null;
      return winner;
    } finally {
      this.waiter = null;
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Release the tab subscription. Idempotent; safe before and after `next`. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.waiter = null;
  }

  private onResponse(response: TabResponse): void {
    if (this.observed !== null) return;
    if (!this.spec.matches(response)) {
      this.spec.onUnmatched?.(response);
      return;
    }
    this.matched = true;
    void this.settle(response);
  }

  private async settle(response: TabResponse): Promise<void> {
    let value: T | null;
    try {
      value = await this.spec.read(response);
    } catch (e) {
      value = this.spec.onError(response, e);
    }
    if (value === null || this.observed !== null) return;
    this.observed = value;
    this.observedAt = this.now();
    this.waiter?.(value);
  }
}
