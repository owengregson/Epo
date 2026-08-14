import type { EpoStatus } from '@/types';
import { useKeepAlivePoll } from './useKeepAlivePoll';

/**
 * The single source of engine status for the whole shell (§4 — push-first).
 * A thin binding of {@link useKeepAlivePoll} to the `status` channel.
 */
export function useEngineStatus(): EpoStatus | null {
  return useKeepAlivePoll<EpoStatus>({
    subscribe: (apply) => {
      const on = (s: EpoStatus): void => apply(s);
      window.epo.on('status', on);
      return () => window.epo.off('status', on);
    },
    pull: () => window.epo.status(),
  });
}
