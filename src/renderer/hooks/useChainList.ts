import { useEffect, useState } from 'preact/hooks';
import type { ChainTargetView, EpoStatus } from '@/types';

/**
 * The chain lineage (`chain:list`), refreshed whenever the current target or
 * chain position advances (so the trail stays in step with the engine).
 */
export function useChainList(status: EpoStatus | null): ChainTargetView[] {
  const [list, setList] = useState<ChainTargetView[]>([]);
  const key = `${status?.loggedIn ? 1 : 0}|${status?.currentTargetPk ?? ''}|${status?.chainIndex ?? ''}`;

  useEffect(() => {
    let alive = true;
    window.epo
      .chainList()
      .then((l) => {
        if (alive) setList(l);
      })
      .catch(() => {
        /* foundation logs; keep the last good list */
      });
    return () => {
      alive = false;
    };
  }, [key]);

  return list;
}
