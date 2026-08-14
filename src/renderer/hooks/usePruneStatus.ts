import type { PruneStatus } from '@/types';
import { useKeepAlivePoll } from './useKeepAlivePoll';

/**
 * The single source of prune status for the Prune view (§4 — push-first).
 * A thin binding of {@link useKeepAlivePoll} to the `pruneStatus` channel.
 */
export function usePruneStatus(): PruneStatus | null {
  return useKeepAlivePoll<PruneStatus>({
    subscribe: (apply) => {
      const on = (s: PruneStatus): void => apply(s);
      window.epo.on('pruneStatus', on);
      return () => window.epo.off('pruneStatus', on);
    },
    pull: () => window.epo.pruneStatus(),
  });
}
