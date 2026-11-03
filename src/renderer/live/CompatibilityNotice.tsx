/**
 * The sidebar's compatibility line (spec Appendix D.2): calm while Epo adapts to a change, attention while
 * work is paused or unreadable, gone when every area is back to normal. Reads only the status push; the
 * sidebar mounts it and wires Details to the compatibility panel.
 */

import type { JSX } from 'preact';
import { useShell } from '@/renderer/app/shell-context';
import { noticeLine } from '@/shared/surface-health';

export function CompatibilityNotice({ onDetails }: { onDetails?: () => void }): JSX.Element | null {
  const { status } = useShell();
  const line = noticeLine(status?.surface);
  if (line === null) return null;
  return (
    <p class={`compat-notice compat-notice--${line.tone}`} role="status">
      <span>{line.text}</span>
      {line.tone === 'attention' && onDetails !== undefined ? (
        <button type="button" class="compat-link" onClick={onDetails}>Details</button>
      ) : null}
    </p>
  );
}
