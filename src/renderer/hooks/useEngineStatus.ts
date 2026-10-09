import { statusSignal } from '@/renderer/app/shell-context';
import { useKeepAlivePoll } from '@/renderer/hooks/useKeepAlivePoll';
import type { EpoStatus } from '@/types';

/**
 * The single source of engine status for the whole shell (push-first).
 * A thin binding of {@link useKeepAlivePoll} to the `status` channel; the
 * projection is published on {@link statusSignal}, which every consumer reads.
 */
export function useEngineStatus(): void {
  useKeepAlivePoll<EpoStatus>({
    subscribe: (apply) => {
      const on = (s: EpoStatus): void => apply(s);
      window.epo.on('status', on);
      return () => window.epo.off('status', on);
    },
    pull: () => window.epo.status(),
    sink: statusSignal,
  });
}
