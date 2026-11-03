import { useCallback, useState } from 'preact/hooks';
import type { ToastAction, ToastKind } from '@/renderer/hooks/useToasts';
import { clearReason, noteFailure, noteRefusal } from '@/renderer/sidebar/reason-line';

/** The shell's toast pusher (an action, such as Stop's Undo, is optional). */
export type ToastPush = (kind: ToastKind, message: string, action?: ToastAction) => void;

export interface ControlRunner {
  /** Name of the in-flight control ('start' | 'pauseResume' | 'stop' | …), else null. */
  pending: string | null;
  /** Run one bridge control, showing pending; resolves true when main carried it out (no refusal, no failure). */
  run(name: string, label: string, fn: () => Promise<unknown>): Promise<boolean>;
  /** The shell's toasts, for the one control that confirms with an action (Stop's Undo). */
  toast: ToastPush;
}

/**
 * The shell's policy for engine and prune controls (spec §12.2): a control REFUSAL is not an IPC rejection —
 * it comes back as a normal status carrying `refusal` (e.g. a prune holds the tab). Its typed key becomes
 * the Now zone's reason line in plain words (never a raw-key toast); a rejected call says it did not work.
 * Pressing a control clears the previous line.
 */
export function useControl(toast: ToastPush): ControlRunner {
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(async (name: string, _label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setPending(name);
    clearReason();
    try {
      const res = await fn();
      const refusal =
        typeof res === 'object' && res !== null && 'refusal' in res ? (res as { refusal?: string }).refusal : undefined;
      if (refusal === undefined) return true;
      noteRefusal(refusal);
      return false;
    } catch {
      noteFailure();
      return false;
    } finally {
      setPending(null);
    }
  }, []);

  return { pending, run, toast };
}
