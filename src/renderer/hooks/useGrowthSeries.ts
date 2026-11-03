import { useEffect, useState } from 'preact/hooks';
import { growthSeriesSignal } from '@/renderer/app/live-signals';
import { DEFAULT_GROWTH_WINDOW, type GrowthWindowKey, windowDays } from '@/renderer/charts/growth-window';
import type { EpoStatus, GrowthSeriesRead } from '@/types';

/** A growth read plus the selection it answers — the chart's reveal identity. */
export interface GrowthSeriesView extends GrowthSeriesRead {
  /**
   * The window selection these points answer. Trails the live selection until
   * its fetch lands, so the chart never replays a reveal against stale points.
   */
  forWindow: GrowthWindowKey;
}

/**
 * The account's cumulative net follower growth (`growth:series`) for a history
 * window, refreshed when the window, login state, or today's net changes — and
 * only while `active` (the page is shown). The default window starts from the
 * read the shell fetched before the reveal, and each refresh of it is published
 * back there. The `all` window resolves its span from the measurement baseline:
 * when a response's `baselineAt` changes the resolved day count, the true span
 * is refetched BEFORE publishing — one visible update, not a fallback flash.
 */
export function useGrowthSeries(
  windowKey: GrowthWindowKey,
  status: EpoStatus | null,
  active = true,
): GrowthSeriesView {
  const [view, setView] = useState<GrowthSeriesView>(() => {
    const preloaded = windowKey === DEFAULT_GROWTH_WINDOW ? growthSeriesSignal.peek() : null;
    return { ...(preloaded ?? { points: [], baselineAt: null }), forWindow: windowKey };
  });
  const key = `${status?.loggedIn ? 1 : 0}|${status?.netToday ?? 0}`;
  const days = windowDays(windowKey, view.baselineAt, Date.now());

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const fetchSpan = (d: number, retried: boolean): void => {
      window.epo
        .growthSeries(d)
        .then((r) => {
          if (!alive) return;
          const resolved = windowDays(windowKey, r.baselineAt, Date.now());
          if (resolved !== d && !retried) {
            fetchSpan(resolved, true);
            return;
          }
          if (windowKey === DEFAULT_GROWTH_WINDOW) growthSeriesSignal.value = r;
          setView({ ...r, forWindow: windowKey });
        })
        .catch(() => {
          /* main logs a failing read and answers its fallback; keep the last good series */
        });
    };
    fetchSpan(days, false);
    return () => {
      alive = false;
    };
  }, [days, key, windowKey, active]);

  return view;
}
