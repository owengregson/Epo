/**
 * ScheduleManager — the ONE owner of periodic work.
 *
 * `every()` runs tick loops (connectivity probe, the scheduled-prune watcher)
 * with a built-in overlap guard: a tick landing while the task is still in
 * flight is DROPPED, never stacked — generalizing ConnectivityMonitor's old
 * `checking` flag. Task exceptions are caught and logged; a bad tick never
 * kills the loop. `after()` arms one replaceable one-shot (the plan's edge).
 *
 * `cadence()` models due-by-timestamp scheduling:
 * "due when never run, or when everyMs has elapsed since the recorded last run" —
 * with the timestamp read/written through the caller (so it can live in
 * persisted Settings and survive restarts). `everyMs` is an `isDue` parameter,
 * not creation-time state, because cadences read live settings values.
 */

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
  cancel(): void;
}

export class ScheduleManager {
  private readonly loops = new Map<string, ActiveLoop>();

  constructor(deps: { clock?: unknown } = {}) {
    // Deps are accepted for wiring compatibility; the manager owns no clock —
    // every cadence is evaluated against the caller's `now`.
    void deps;
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
    this.loops.set(key, { cancel: () => clearInterval(timer) });
    if (opts.immediate === true) tick();
  }

  /**
   * Run `fn` once after `delayMs`, replacing any one-shot or loop under `key`.
   * A failure is logged, never thrown; `stop(key)` cancels a pending run.
   */
  after(key: string, delayMs: number, fn: () => void | Promise<void>, opts: Pick<EveryOpts, 'unref'> = {}): void {
    this.stop(key);
    const loop: ActiveLoop = { cancel: () => clearTimeout(timer) };
    const timer = setTimeout(() => {
      if (this.loops.get(key) !== loop) return;
      this.loops.delete(key);
      Promise.resolve().then(fn).catch((e: unknown) => {
        log.error('schedule: task failed', { key, error: String(e) });
      });
    }, Math.max(0, delayMs));
    if (opts.unref === true) timer.unref?.();
    this.loops.set(key, loop);
  }

  stop(key: string): void {
    const loop = this.loops.get(key);
    if (loop === undefined) return;
    loop.cancel();
    this.loops.delete(key);
  }

  /** A due-by-timestamp cadence over the caller's persisted last-run stamp. */
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
        log.debug('schedule: cadence run recorded', { key, at: now });
      },
      lastRunAt: cfg.getLastRunAt,
    };
  }

  /** Stop every loop. Idempotent. */
  dispose(): void {
    for (const key of [...this.loops.keys()]) this.stop(key);
  }
}
