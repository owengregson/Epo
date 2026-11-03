/**
 * The Phase F default of the ONE plan-day boundary (spec §4.4): local midnight, DST-safe (23-25 h).
 * Day-keyed consumers take a `PlanDayClock` from their wiring module; the plan core's quiet-minute
 * clock replaces this one at a single swap site.
 */

import type { PlanDayClock, PlanDayWindow } from '../kernel/plan';
import { sleep } from '../timing/primitives';

export interface CalendarClockDeps {
  now?: () => number;
  /** Runs `fn` after `ms` and returns its cancel (default: an abortable sleep). */
  after?: (ms: number, fn: () => void) => () => void;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local calendar day containing `t`, from its midnight to the next one. */
function localDay(t: number): PlanDayWindow {
  const d = new Date(t);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  return { key, startsAt: start.getTime(), endsAt: end.getTime(), quietMinute: 0 };
}

const sleepThen = (ms: number, fn: () => void): (() => void) => {
  const stop = new AbortController();
  void sleep(ms, stop.signal).then(() => { if (!stop.signal.aborted) fn(); });
  return () => stop.abort();
};

/** Local-midnight plan-days; `onRoll` listeners share one timer, armed only while any listens. */
export function calendarPlanDayClock(deps: CalendarClockDeps = {}): PlanDayClock {
  const now = deps.now ?? Date.now;
  const after = deps.after ?? sleepThen;
  const listeners = new Set<(w: PlanDayWindow) => void>();
  let cancel: (() => void) | null = null;
  let current: PlanDayWindow = localDay(now());

  const arm = (): void => {
    const t = now();
    cancel = after(Math.max(1, localDay(t).endsAt - t), tick);
  };
  // A late timer (a sleeping machine) rolls once to the day it wakes in; an early one re-arms.
  const tick = (): void => {
    const w = localDay(now());
    if (w.key !== current.key) {
      current = w;
      for (const fn of [...listeners]) fn(w);
    }
    if (listeners.size > 0) arm();
    else cancel = null;
  };

  return {
    window: localDay,
    dayKey: (t) => localDay(t).key,
    onRoll(fn) {
      listeners.add(fn);
      if (cancel === null) {
        current = localDay(now());
        arm();
      }
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && cancel !== null) {
          cancel();
          cancel = null;
        }
      };
    },
  };
}
