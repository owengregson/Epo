import { useEffect, useState } from 'preact/hooks';
import type { EpoStatus, NetGrowthPoint } from '@/types';

/**
 * The operator's cumulative net follower growth series (`growth:series`),
 * refreshed when login state or today's net changes.
 */
export function useGrowthSeries(days: number, status: EpoStatus | null): NetGrowthPoint[] {
  const [points, setPoints] = useState<NetGrowthPoint[]>([]);
  const key = `${status?.loggedIn ? 1 : 0}|${status?.netToday ?? 0}`;

  useEffect(() => {
    let alive = true;
    window.epo
      .growthSeries(days)
      .then((p) => {
        if (alive) setPoints(p);
      })
      .catch(() => {
        /* foundation logs; keep the last good series */
      });
    return () => {
      alive = false;
    };
  }, [days, key]);

  return points;
}
