import { useEffect, useState } from 'preact/hooks';
import { type GrowthWindowKey, windowDays } from '@/renderer/charts/growth-window';
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
 * The operator's cumulative net follower growth read (`growth:series`) for a
 * selected history window, refreshed when the window, login state, or today's
 * net changes. The `all` window resolves its span from the measurement
 * baseline: when a response's `baselineAt` changes the resolved day count
 * (first `all` read before any baseline was known), the true span is refetched
 * BEFORE publishing — one visible update, not a fallback flash followed by the
 * real span.
 */
export function useGrowthSeries(
  windowKey: GrowthWindowKey,
  status: EpoStatus | null,
): GrowthSeriesView {
  const [view, setView] = useState<GrowthSeriesView>({
    points: [],
    baselineAt: null,
    forWindow: windowKey,
  });
  const key = `${status?.loggedIn ? 1 : 0}|${status?.netToday ?? 0}`;
  const days = windowDays(windowKey, view.baselineAt, Date.now());

  useEffect(() => {
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
          setView({ ...r, forWindow: windowKey });
        })
        .catch(() => {
          /* foundation logs; keep the last good series */
        });
    };
    fetchSpan(days, false);
    return () => {
      alive = false;
    };
  }, [days, key, windowKey]);

  return view;
}
