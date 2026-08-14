/**
 * Timing primitives — the ONE home for sleep and delay-shape math.
 *
 * Pure and dependency-free (no Node, no Electron), so both the main process and
 * the renderer import from here. Every delay computation in the app is one of
 * these four policy shapes; composing them (see `scaled`) replaces the formula
 * forks that used to live in rate-governor / prune-engine / followers-page-reader.
 */

/** Injectable randomness — `Math.random`-shaped, deterministic in tests. */
export type Rng = () => number;

/**
 * An interruptible sleep signature: resolves after `ms` OR as soon as `signal`
 * aborts, whichever comes first — it NEVER rejects (E1: nothing may wait
 * un-interruptibly, and an abort is a normal outcome, not an error).
 */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** A pure delay sampler: `sample(rng)` yields the next wait in ms. */
export interface DelayPolicy {
  readonly kind: string;
  sample(rng: Rng): number;
}

/** A constant wait (parks, idle beats, retry spacing). */
export function fixed(ms: number): DelayPolicy {
  return { kind: 'fixed', sample: () => ms };
}

/**
 * A uniform draw in [minMs, maxMs], rounded (scan pacing, refill pacing).
 * Bounds are clamped defensively: `min ≥ 0`, `max ≥ min` — mirroring the old
 * followers-page-reader clamps so a bad settings pair can't yield negatives.
 */
export function uniform(minMs: number, maxMs: number): DelayPolicy {
  const min = Math.max(0, minMs);
  const max = Math.max(min, maxMs);
  return { kind: 'uniform', sample: (rng) => Math.round(min + rng() * (max - min)) };
}

/**
 * THE humanized delay: a base uniformly in [min,max], then a symmetric
 * ± `jitterPercent` of that base. Consumes the rng TWICE (base, then jitter) —
 * the exact formula and draw order the RateGovernor has always used, so
 * deterministic tests seeded against the old code still hold.
 */
export function jittered(minMs: number, maxMs: number, jitterPercent: number): DelayPolicy {
  return {
    kind: 'jittered',
    sample: (rng) => {
      const base = minMs + rng() * (maxMs - minMs);
      const jitter = base * (jitterPercent / 100) * (rng() * 2 - 1);
      return Math.round(base + jitter);
    },
  };
}

/** Scale another policy's draw by `factor` (prune runs growth's delay × 1/3). */
export function scaled(inner: DelayPolicy, factor: number): DelayPolicy {
  return {
    kind: `scaled(${inner.kind})`,
    sample: (rng) => Math.round(inner.sample(rng) * factor),
  };
}

/** Draw once from a policy — or pass a plain number through unchanged. */
export function sample(policyOrMs: DelayPolicy | number, rng: Rng = Math.random): number {
  return typeof policyOrMs === 'number' ? policyOrMs : policyOrMs.sample(rng);
}

/**
 * The one canonical sleep: real `setTimeout`, resolving early (not rejecting)
 * when `signal` aborts. Replaces the 8 per-file `new Promise(setTimeout)` copies.
 */
export const sleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });

/** Sentinel `withTimeout` resolves to when the deadline wins the race. */
export const TIMED_OUT: unique symbol = Symbol('timed-out');

/**
 * Race a promise against a deadline. Resolves the promise's value when it wins,
 * or {@link TIMED_OUT} when the deadline does; the timer is always cleared. The
 * raced promise's eventual settlement after a timeout is intentionally ignored —
 * callers that must observe a late rejection attach their own handler.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
