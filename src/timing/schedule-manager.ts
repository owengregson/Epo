/**
 * ScheduleManager — the ONE owner of periodic work.
 *
 * `every()` runs tick loops (connectivity probe, the scheduled-prune watcher)
 * with a built-in overlap guard: a tick landing while the task is still in
 * flight is DROPPED, never stacked — generalizing ConnectivityMonitor's old
 * `checking` flag. Task exceptions are caught and logged; a bad tick never
 * kills the loop.
 *
 * `cadence()` models due-by-timestamp scheduling (follow-back sweep, pruneDue):
 * "due when never run, or when everyMs has elapsed since the recorded last run" —
 * with the timestamp read/written through the caller (so it can live in
 * persisted Settings and survive restarts). `everyMs` is an `isDue` parameter,
 * not creation-time state, because cadences read live settings values.
 */

import type { Clock } from '../governors/clock';
import * as log from '../utils/logger';

export interface EveryOpts {
  /** `unref` the timer so it can never hold the process open (main-process loops). */
  unref?: boolean;
  /** Run the task once immediately as well as on the interval. */
  immediate?: boolean;
}

export interface Cadence {
  isDue(now: number, everyMs: number): boolean;
  markRun(now: number): void;
  lastRunAt(): number | null;
}

interface ActiveLoop {
  timer: ReturnType<typeof setInterval>;
}

export class ScheduleManager {
  private readonly clock: Clock;
  private readonly loops = new Map<string, ActiveLoop>();

  constructor(deps: { clock: Clock }) {
    this.clock = deps.clock;
  }

  every(
    key: string,
    intervalMs: number,
    fn: () => void | Promise<void>,
    opts: EveryOpts = {},
  ): void {
    if (this.loops.has(key)) return;
    let busy = false;
    // A synchronous task must clear the guard SYNCHRONOUSLY (an `await fn()`
    // would defer it to a microtask, wrongly dropping back-to-back ticks under
    // fake timers); only a genuinely async task holds `busy` across its life.
    const tick = (): void => {
      if (busy) return; // overlap guard: drop, never stack
      busy = true;
      let result: void | Promise<void>;
      try {
        result = fn();
      } catch (e) {
        log.error('schedule: task failed', { key, error: String(e) });
        busy = false;
        return;
      }
      if (result instanceof Promise) {
        result
          .catch((e: unknown) => {
            log.error('schedule: task failed', { key, error: String(e) });
          })
          .finally(() => {
            busy = false;
          });
      } else {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      tick();
    }, intervalMs);
    if (opts.unref === true) timer.unref?.();
    this.loops.set(key, { timer });
    if (opts.immediate === true) tick();
  }

  stop(key: string): void {
    const loop = this.loops.get(key);
    if (loop === undefined) return;
    clearInterval(loop.timer);
    this.loops.delete(key);
  }

  cadence(
    key: string,
    cfg: { getLastRunAt: () => number | null; setLastRunAt: (at: number) => void },
  ): Cadence {
    return {
      isDue: (now, everyMs) => {
        const last = cfg.getLastRunAt();
        return last === null || now - last >= everyMs;
      },
      markRun: (now) => {
        cfg.setLastRunAt(now);
        log.debug('schedule: cadence run recorded', { key, at: now, recordedAt: this.clock.now() });
      },
      lastRunAt: cfg.getLastRunAt,
    };
  }

  /** Stop every loop. Idempotent. */
  dispose(): void {
    for (const key of [...this.loops.keys()]) this.stop(key);
  }
}
