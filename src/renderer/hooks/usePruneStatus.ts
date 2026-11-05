import { pruneSignal } from '@/renderer/app/shell-context';
import { useKeepAlivePoll } from '@/renderer/hooks/useKeepAlivePoll';
import type { PruneStatus } from '@/types';

/**
 * The single source of prune status for the shell (push-first).
 * A thin binding of {@link useKeepAlivePoll} to the `pruneStatus` channel; the
 * projection is published on {@link pruneSignal}.
 */
export function usePruneStatus(): void {
  useKeepAlivePoll<PruneStatus>({
    subscribe: (apply) => {
      const on = (s: PruneStatus): void => apply(s);
      window.epo.on('pruneStatus', on);
      return () => window.epo.off('pruneStatus', on);
    },
    pull: () => window.epo.pruneStatus(),
    sink: pruneSignal,
  });
}
