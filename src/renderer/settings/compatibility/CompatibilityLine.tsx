/**
 * The Easy-mode compatibility one-liner (spec Appendix D.2): "Instagram compatibility: {state}" from the
 * status push's summary, with Details opening the Advanced panel. The settings stage mounts it.
 */

import type { JSX } from 'preact';
import { useShell } from '@/renderer/app/shell-context';
import { compatibilityLine } from '@/shared/surface-health';

export function CompatibilityLine({ onDetails }: { onDetails: () => void }): JSX.Element {
  const { status } = useShell();
  const worst = status?.surface?.worst ?? 'unseen';
  return (
    <p class={`compat-line compat-line--${worst}`}>
      <span>{compatibilityLine(status?.surface)}</span>
      <button type="button" class="compat-link" onClick={onDetails}>Details</button>
    </p>
  );
}
