/**
 * The Instagram activity clock (spec §5.13 S2b, §5.16): every Instagram operation — a profile visit,
 * a list walk, the notifications drawer — enters no sooner than one `dwell.visit` draw after the
 * previous operation ended, whichever caller issued either. The graph holds ONE clock, so the
 * operations of every caller share one rhythm, and the per-caller pacers stacked on top of each
 * other (the enrich pace, the engine's beat after a task) retire with it.
 */

import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { type Rng, type SleepFn, sample, sleep } from '@/timing/primitives';

export interface IgActivityClock {
  /** When the last Instagram operation ended, or null before the first. */
  lastEndAt(): number | null;
  /** An operation ended at `at`; an earlier `at` never moves the clock back. */
  noteEnd(at: number): void;
  /** Wait until `lastEnd + draw(dwell.visit)`: the first operation, and one long after the last, wait nothing. */
  spaceEntry(signal?: AbortSignal): Promise<void>;
}

export interface IgActivityClockDeps {
  /** The tempo the spacing draws from (default: the reference tempo). */
  tempo?: TempoSource;
  /** A caller's own stream; without one the draw takes the tempo's own `dwell.visit` stream. */
  rng?: Rng;
  now?: () => number;
  sleep?: SleepFn;
}

export function createIgActivityClock(deps: IgActivityClockDeps = {}): IgActivityClock {
  const tempo = tempoOrReference(deps.tempo);
  const now = deps.now ?? Date.now;
  const pause = deps.sleep ?? sleep;
  const draw = (): number =>
    deps.rng === undefined ? tempo.draw('dwell.visit') : sample(tempo.policy('dwell.visit'), deps.rng);
  let lastEnd: number | null = null;
  return {
    lastEndAt: () => lastEnd,
    noteEnd: (at) => {
      lastEnd = lastEnd === null ? at : Math.max(lastEnd, at);
    },
    spaceEntry: async (signal) => {
      if (lastEnd === null) return;
      const left = lastEnd + draw() - now();
      if (left > 0) await pause(left, signal);
    },
  };
}

/** One Instagram operation on the clock: its entry spaced, its end noted whether it resolved or threw. */
export async function underClock<T>(clock: IgActivityClock, now: () => number, signal: AbortSignal | undefined,
  op: () => Promise<T>): Promise<T> {
  await clock.spaceEntry(signal);
  try {
    return await op();
  } finally {
    clock.noteEnd(now());
  }
}
