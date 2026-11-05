/**
 * Schedules are DATA, not control flow.
 *
 * The recovery ladder is spelled out imperatively today — `RECOVERY.HOLD_MEDIANS_MS`
 * indexed by rung, a sigma, min/max factors, and a rung counter in
 * `recovery.ts`. Described as data it is one value:
 *
 *   truncate(jittered(exponential(1 h, 1.5, 4 h), 0.25, [0.6, 1.6]), 3)
 *
 * which can be printed on the Rate & Safety card, property-tested, derived from
 * the fundamentals, and — crucially — persisted, since a plain object survives
 * `app.quit()` where a fiber does not (ADR 0603).
 *
 * `draw()` is pure: same schedule, same attempt, same rng ⇒ same `Ms`. It never
 * waits; the caller decides whether that duration becomes a `setTimeout` or a
 * durable `timers` row.
 */

import { clampMs, type Ms, ms } from './units';

/** A uniform source on `[0, 1)`. Injected so every draw is reproducible in tests. */
export type Rng = () => number;

export type Schedule =
  /** One draw, then exhausted. */
  | { readonly kind: 'once'; readonly delay: Ms }
  /** The same delay `times` times, then exhausted. */
  | { readonly kind: 'recurs'; readonly delay: Ms; readonly times: number }
  /** `base × factor^attempt`, ceilinged at `cap`. Never exhausts on its own. */
  | { readonly kind: 'exponential'; readonly base: Ms; readonly factor: number; readonly cap: Ms }
  /** Log-normal noise around the inner draw, confined to `[inner×lo, inner×hi]`. */
  | {
      readonly kind: 'jittered';
      readonly inner: Schedule;
      readonly sigma: number;
      readonly clamp: readonly [number, number];
    }
  /** The inner schedule, exhausted after `times` attempts whatever it says. */
  | { readonly kind: 'truncate'; readonly inner: Schedule; readonly times: number };

export const once = (delay: Ms): Schedule => ({ kind: 'once', delay });

export const recurs = (delay: Ms, times: number): Schedule => ({ kind: 'recurs', delay, times: whole(times) });

/** `factor` below 1 would make the ladder descend, so it is refused, not clamped. */
export function exponential(base: Ms, factor: number, cap: Ms): Schedule {
  if (!(factor >= 1) || !Number.isFinite(factor)) throw new RangeError(`exponential factor must be >= 1, got ${factor}`);
  return { kind: 'exponential', base, factor, cap };
}

/** `clamp` is a pair of MULTIPLIERS on the inner draw, e.g. `[0.6, 1.6]`. */
export function jittered(inner: Schedule, sigma: number, clamp: readonly [number, number]): Schedule {
  const [lo, hi] = clamp;
  if (!(sigma >= 0) || !Number.isFinite(sigma)) throw new RangeError(`sigma must be >= 0, got ${sigma}`);
  if (!(lo >= 0) || !(hi >= lo)) throw new RangeError(`clamp must be 0 <= lo <= hi, got [${lo}, ${hi}]`);
  return { kind: 'jittered', inner, sigma, clamp };
}

export const truncate = (inner: Schedule, times: number): Schedule => ({
  kind: 'truncate',
  inner,
  times: whole(times),
});

function whole(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`attempt count must be a non-negative integer, got ${n}`);
  return n;
}

/**
 * One standard-normal draw (Box–Muller), consuming the rng EXACTLY twice so a
 * seeded sequence stays deterministic. `1 - rng()` maps `[0,1)` → `(0,1]`, which
 * keeps `ln` finite. (The same math as `src/timing/distributions.ts`; the kernel
 * imports nothing from `src`, so it is restated rather than shared.)
 */
export function normal01(rng: Rng): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Log-normal by MEDIAN: `X = median × exp(sigma × Z)`. Config reasons in medians. */
export function logNormal(median: Ms, sigma: number, rng: Rng): Ms {
  const s = Math.max(0, sigma);
  return ms(Math.round(Math.max(0, median) * Math.exp(s * normal01(rng))));
}

/**
 * The delay for a zero-based `attempt`, or `null` when the schedule is spent.
 * A spent inner schedule propagates: jitter of nothing is nothing.
 */
export function draw(schedule: Schedule, attempt: number, rng: Rng): Ms | null {
  whole(attempt);
  switch (schedule.kind) {
    case 'once':
      return attempt === 0 ? schedule.delay : null;
    case 'recurs':
      return attempt < schedule.times ? schedule.delay : null;
    case 'exponential':
      return ms(Math.min(schedule.cap, schedule.base * schedule.factor ** attempt));
    case 'jittered': {
      const base = draw(schedule.inner, attempt, rng);
      if (base === null) return null;
      const [lo, hi] = schedule.clamp;
      return ms(Math.round(clampMs(logNormal(base, schedule.sigma, rng), ms(base * lo), ms(base * hi))));
    }
    case 'truncate':
      return attempt < schedule.times ? draw(schedule.inner, attempt, rng) : null;
  }
}

/** How many attempts this schedule serves, or `null` when it never exhausts. */
export function attempts(schedule: Schedule): number | null {
  switch (schedule.kind) {
    case 'once':
      return 1;
    case 'recurs':
      return schedule.times;
    case 'exponential':
      return null;
    case 'jittered':
      return attempts(schedule.inner);
    case 'truncate': {
      const inner = attempts(schedule.inner);
      return inner === null ? schedule.times : Math.min(inner, schedule.times);
    }
  }
}

/** A human duration, for `describe` and for the UI's "next attempt in …" copy. */
export function formatMs(value: Ms): string {
  const abs = Math.abs(value);
  if (abs >= 3_600_000) return `${round2(value / 3_600_000)}h`;
  if (abs >= 60_000) return `${round2(value / 60_000)}m`;
  if (abs >= 1_000) return `${round2(value / 1_000)}s`;
  return `${round2(value)}ms`;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The schedule as the expression that built it — printable in a span or a card. */
export function describe(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'once':
      return `once(${formatMs(schedule.delay)})`;
    case 'recurs':
      return `recurs(${formatMs(schedule.delay)}, ${schedule.times})`;
    case 'exponential':
      return `exponential(${formatMs(schedule.base)}, ×${schedule.factor}, cap ${formatMs(schedule.cap)})`;
    case 'jittered':
      return `jittered(${describe(schedule.inner)}, σ${schedule.sigma}, [${schedule.clamp[0]}, ${schedule.clamp[1]}])`;
    case 'truncate':
      return `truncate(${describe(schedule.inner)}, ${schedule.times})`;
  }
}
