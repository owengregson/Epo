import { useEffect, useState } from 'preact/hooks';
import { type GrowthWindowKey, windowDays } from '@/renderer/charts/growth-window';
import type { EpoStatus, GrowthSeriesRead } from '@/types';

/**
 * The operator's cumulative net follower growth read (`growth:series`) for a
 * selected history window, refreshed when the window, login state, or today's
 * net changes. The `all` window resolves its span from the measurement
 * baseline the previous read reported: the first response carries
 * `baselineAt`, which changes the resolved day count, which re-fetches once —
 * after that the span is stable until the day rolls over.
 */
export function useGrowthSeries(
  windowKey: GrowthWindowKey,
  status: EpoStatus | null,
): GrowthSeriesRead {
  const [read, setRead] = useState<GrowthSeriesRead>({ points: [], baselineAt: null });
  const key = `${status?.loggedIn ? 1 : 0}|${status?.netToday ?? 0}`;
  const days = windowDays(windowKey, read.baselineAt, Date.now());

  useEffect(() => {
    let alive = true;
    window.epo
      .growthSeries(days)
      .then((r) => {
        if (alive) setRead(r);
      })
      .catch(() => {
        /* foundation logs; keep the last good series */
      });
    return () => {
      alive = false;
    };
  }, [days, key]);

  return read;
}
