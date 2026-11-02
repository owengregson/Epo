import type { ActivityReporter } from './activity-reporter';
import type { LocatedRect } from './ig-surface';
import type { PageTab } from './tab-ports';

/**
 * The tab slice the Actor drives (see `tab-ports.ts`): navigate, evaluate,
 * read the URL — and, when the tab carries the seam, observe the mutation
 * response so the server's own verdict arbitrates a click rather than the
 * header button's optimistic flip.
 */
export type AdapterTab = PageTab;

/**
 * The input port the Actor drives (`src/interaction/Interactor` satisfies it
 * structurally). Element LOCATING happens in-page — the surface's locate
 * scripts return bounding rects — and every click/scroll is then performed
 * with native input events. Required: an in-page `.click()` is focus- and
 * trust-dependent and the SPA ignores it for several controls.
 */
export interface ActorInteractor {
  /** Rest the cursor on `target` without pressing (settle-then-press, `settle-press.ts`). */
  hover(target: LocatedRect): Promise<void>;
  click(target: LocatedRect): Promise<void>;
  /**
   * Scroll `container` by `deltaPx`. `restPoint` (optional) is a hover-safe spot
   * inside the container the cursor rests on while wheeling, so the burst never
   * lands on a username/avatar that would open a hover card and eat the wheel.
   */
  scroll(container: LocatedRect, deltaPx: number, restPoint?: { x: number; y: number }): Promise<void>;
}

/** Tuning for the (real-browser) wait loops. Tests override with tiny values. */
export interface ActorOptions {
  prepareProfile?: (username: string, expectedPk: string, action: 'follow' | 'unfollow') => Promise<void>;
  beforeMutation?: () => Promise<void>;
  /** Poll interval while waiting for the dialog / confirm control. */
  pollIntervalMs?: number;
  /** Total time to wait before declaring a control absent. */
  pollTimeoutMs?: number;
  /** How long after an action click to wait for its mutation response. */
  mutationTimeoutMs?: number;
  /** The input engine every click/scroll goes through (see {@link ActorInteractor}). */
  interactor: ActorInteractor;
  /**
   * Provider of the ACTIVE driver's abort signal (the engine/prune run token),
   * polled per wait iteration — a `stop()` interrupts an in-flight DOM poll
   * instead of sitting out its timeout. Absent → waits always run to term.
   */
  abortSignal?: () => AbortSignal | undefined;
  /** Live activity readout for the veil; defaults to a no-op. */
  reporter?: ActivityReporter;
}

