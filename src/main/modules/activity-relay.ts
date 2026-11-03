/**
 * The activity relay (spec §12.9, Appendix C.3): what the tab-driving layers report reaches the veil at once and
 * the sidebar as the `activity` push — a new op or a hold change at once, a count-only change on a trailing
 * throttle, and a clear only when no op follows within the null hold, so the now line never blinks between steps.
 */

import type { ActivityReporter } from '@/adapter/activity-reporter';
import type { ActivityInfo, LiveTab } from '@/shared/live-op';

export interface ActivityRelayDeps {
  /** The veil's chip; the veil converts the op to its own label (veil-view.ts). */
  veil: { setActivity(info: ActivityInfo | null): void };
  /** The `activity` push. */
  push(tab: LiveTab): void;
  clock: { now(): number };
  /** Runs `fn` after `ms`; returns its cancel. */
  after(ms: number, fn: () => void): () => void;
  /** The trailing window for count-only changes (the graph-push throttle). */
  throttleMs: number;
  /** How long a clear waits for the next op before it is pushed (`BOOT.ACTIVITY_NULL_HOLD_MS`). */
  nullHoldMs: number;
}

export interface ActivityRelay extends ActivityReporter {
  /** The tab-activity holds changed (the Foundation's TabActivity callback). */
  onHolds(active: boolean, holds: readonly string[]): void;
  /** The live tab now: the `activityNow` pull backstop. */
  current(): LiveTab;
}

/** `after` over the platform timer. */
export function timerAfter(ms: number, fn: () => void): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/** The op without its progress counters: two reports with one subject are one op. */
const subjectOf = (info: ActivityInfo): string =>
  JSON.stringify([info.kind, info.op], (key, value: unknown) => (key === 'done' || key === 'total' ? undefined : value));

export function createActivityRelay(d: ActivityRelayDeps): ActivityRelay {
  let op: { info: ActivityInfo; since: number; subject: string; json: string } | null = null;
  let busy = false;
  let holds: readonly string[] = [];
  let ending = false;
  let throttle: (() => void) | null = null;
  let hold: (() => void) | null = null;

  const current = (): LiveTab => ({ activity: op === null ? null : { info: op.info, since: op.since }, busy, holds });
  const flush = (): void => {
    throttle?.();
    throttle = null;
    d.push(current());
  };
  const stopHold = (): void => {
    hold?.();
    hold = null;
    ending = false;
  };

  return {
    report(info) {
      d.veil.setActivity(info);
      const subject = subjectOf(info);
      const json = JSON.stringify(info);
      if (op !== null && !ending && op.subject === subject) {
        if (op.json === json) return;
        op = { ...op, info, json };
        if (throttle === null) throttle = d.after(d.throttleMs, () => { throttle = null; flush(); });
        return;
      }
      stopHold();
      op = { info, since: d.clock.now(), subject, json };
      flush();
    },
    clear() {
      d.veil.setActivity(null);
      if (op === null || ending) return;
      ending = true;
      hold = d.after(d.nullHoldMs, () => {
        hold = null;
        ending = false;
        op = null;
        flush();
      });
    },
    onHolds(active, next) {
      if (active === busy && next.length === holds.length && next.every((h, i) => h === holds[i])) return;
      busy = active;
      holds = [...next];
      flush();
    },
    current,
  };
}
