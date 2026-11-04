/**
 * The Now zone's reason line (spec §12.2): the typed refusal of the person's own last command, in plain
 * words, until they press another control or the posture moves on. It replaces the raw-key toasts.
 */
import { signal } from '@preact/signals';
import { COMMAND_FAILED, refusalText } from '@/renderer/sidebar/copy/refusal-copy';

/** The line and the posture it was written under (a new posture retires it). */
export const reasonSignal = signal<{ readonly text: string; readonly kind: string | null } | null>(null);

/** A refusal the bridge answered with (a typed key); a key that needs no words clears the line. */
export function noteRefusal(reason: string, kind: string | null = null): void {
  const text = refusalText(reason);
  reasonSignal.value = text === null ? null : { text, kind };
}

/** The bridge rejected the command outright. */
export function noteFailure(kind: string | null = null): void {
  reasonSignal.value = { text: COMMAND_FAILED, kind };
}

export function clearReason(): void {
  reasonSignal.value = null;
}
