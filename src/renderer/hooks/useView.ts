import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { prefersReducedMotion, VIEW_ENTER_HOLD_MS } from '../lib/motion';

export type ViewKey = 'overview' | 'chain' | 'queues' | 'settings';

export interface ViewController {
  /** The currently displayed view. */
  current: ViewKey;
  /** Animate to another view (no-op if already there or mid-transition). */
  goTo(next: ViewKey): void;
  /** Full class string for a view section (`view` + active/entering/exiting). */
  classFor(key: ViewKey): string;
}

/**
 * The console's cinematic view router (spec: scale+fade stage). All five views
 * stay mounted (so each keeps its scroll position and one-shot animations); only
 * classes toggle.
 *
 * Responsiveness (immediate crossfade): a tab press swaps the active view on the
 * SAME frame — the incoming view starts its enter animation at once while the
 * outgoing view fades out simultaneously (it stays painted via `.view.exiting`).
 * There is no exit phase to wait through and no mid-transition lockout, so rapid
 * tab presses always take effect instantly; a new press just cancels the previous
 * transition's cleanup and starts its own. Collapses to an instant swap under
 * reduced motion.
 */
export function useView(initial: ViewKey = 'overview'): ViewController {
  const [current, setCurrent] = useState<ViewKey>(initial);
  const [entering, setEntering] = useState<ViewKey | null>(initial);
  const [exiting, setExiting] = useState<ViewKey | null>(null);
  const timers = useRef<number[]>([]);

  // Clear the initial "entering" flag once the mount animation has played, so
  // returning to this view later re-triggers it.
  useEffect(() => {
    const t = window.setTimeout(
      () => setEntering((e) => (e === initial ? null : e)),
      VIEW_ENTER_HOLD_MS,
    );
    return () => {
      window.clearTimeout(t);
      timers.current.forEach(window.clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTo = useCallback(
    (next: ViewKey) => {
      setCurrent((cur) => {
        if (next === cur) return cur;

        // A press always takes effect now: cancel any pending cleanup from an
        // in-flight transition so it can't clobber this swap.
        timers.current.forEach(window.clearTimeout);
        timers.current = [];

        if (prefersReducedMotion()) {
          setExiting(null);
          setEntering(null);
          return next;
        }

        // Immediate crossfade: swap on this frame — the new view enters now, the
        // old view fades out beneath it. Both are cleared once the (longer) enter
        // animation completes.
        setExiting(cur);
        setEntering(next);
        timers.current.push(
          window.setTimeout(() => {
            setEntering((e) => (e === next ? null : e));
            setExiting((x) => (x === cur ? null : x));
          }, VIEW_ENTER_HOLD_MS),
        );
        return next;
      });
    },
    [],
  );

  const classFor = useCallback(
    (key: ViewKey): string => {
      let cls = 'view';
      if (key === current) cls += ' active';
      if (key === entering) cls += ' entering';
      if (key === exiting) cls += ' exiting';
      return cls;
    },
    [current, entering, exiting],
  );

  return { current, goTo, classFor };
}
