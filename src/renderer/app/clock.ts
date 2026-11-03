import { type Signal, signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

/**
 * The renderer's one clock (spec §12.7): a second tick and a minute tick, each
 * running only while some mounted component asks for it, each aligned to its
 * boundary so every visible "m:ss" and "5m ago" turns over together. A shared
 * timer per granularity replaces one interval per component.
 */
export type Granularity = 'second' | 'minute';

/** Unit lengths (a grid, not a timing): one second, one minute. */
const SECOND_MS = 1000;
const STEP_MS: Readonly<Record<Granularity, number>> = { second: SECOND_MS, minute: 60 * SECOND_MS };

interface Tick {
  readonly now: Signal<number>;
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const TICKS: Readonly<Record<Granularity, Tick>> = {
  second: { now: signal(Date.now()), users: 0, timer: null },
  minute: { now: signal(Date.now()), users: 0, timer: null },
};

/** Fire at the next boundary of the granularity, then re-arm. */
function arm(g: Granularity): void {
  const tick = TICKS[g];
  const step = STEP_MS[g];
  tick.timer = setTimeout(() => {
    tick.now.value = Date.now();
    arm(g);
  }, step - (Date.now() % step));
}

function acquire(g: Granularity): void {
  const tick = TICKS[g];
  tick.users += 1;
  if (tick.users === 1) {
    tick.now.value = Date.now();
    arm(g);
  }
}

function release(g: Granularity): void {
  const tick = TICKS[g];
  tick.users -= 1;
  if (tick.users === 0 && tick.timer !== null) {
    clearTimeout(tick.timer);
    tick.timer = null;
  }
}

/**
 * The current time, re-rendering the caller at each `granularity` boundary while
 * `enabled` (a countdown that is not on screen passes false and costs nothing).
 */
export function useNow(granularity: Granularity, enabled = true): number {
  useEffect(() => {
    if (!enabled) return;
    acquire(granularity);
    return () => release(granularity);
  }, [granularity, enabled]);
  const tick = TICKS[granularity];
  if (!enabled) return Date.now();
  const at = tick.now.value;
  return tick.users > 0 ? at : Date.now();
}

/** How many components hold each tick (tests read it to prove the timers stop). */
export function clockUsers(): Readonly<Record<Granularity, number>> {
  return { second: TICKS.second.users, minute: TICKS.minute.users };
}
