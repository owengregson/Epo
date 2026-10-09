import { useCallback, useState } from 'preact/hooks';
import type { ToastKind } from '@/renderer/hooks/useToasts';

export interface ControlRunner {
  /** Name of the in-flight control ('start' | 'pauseResume' | 'stop' | …), else null. */
  pending: string | null;
  /** Run one bridge control, showing pending and reporting how it ended. */
  run(name: string, label: string, fn: () => Promise<unknown>): Promise<void>;
}

/**
 * The shell's IPC error policy for engine/prune controls.
 *
 * A control REFUSAL is not an IPC rejection — it comes back as a normal status
 * carrying `refusal` (e.g. a prune holds the tab), so a refused control looks
 * exactly like a successful one on the wire. Reading it here is what keeps a
 * refused button from spinning and reverting with no feedback.
 */
export function useControl(toast: (kind: ToastKind, message: string) => void): ControlRunner {
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(
    async (name: string, label: string, fn: () => Promise<unknown>): Promise<void> => {
      setPending(name);
      try {
        const res = await fn();
        const refusal =
          typeof res === 'object' && res !== null && 'refusal' in res
            ? (res as { refusal?: string }).refusal
            : undefined;
        if (refusal === 'prune-running') {
          toast('info', `${label} refused — a prune holds the tab; it resumes growth when done.`);
        } else if (refusal !== undefined) {
          toast('error', `${label} refused: ${refusal}`);
        }
      } catch (e) {
        toast('error', `${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setPending(null);
      }
    },
    [toast],
  );

  return { pending, run };
}
