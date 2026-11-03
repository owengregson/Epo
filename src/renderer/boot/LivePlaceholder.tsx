/**
 * What the Live stage shows while Instagram is not on screen yet (spec §12.8): opening it, or — when the
 * first load failed (offline) — why, with a way to try again. Main also reloads the page by itself once the
 * connection is back. Nothing is drawn once the page has loaded: Instagram covers this stage.
 */
import type { JSX } from 'preact';
import { statusSignal, useShellControls } from '@/renderer/app/shell-context';
import { PLACEHOLDER } from '@/renderer/boot/boot-copy';
import { EpoMark } from '@/renderer/ui/EpoMark';

export function LivePlaceholder(): JSX.Element | null {
  const controls = useShellControls();
  const tab = statusSignal.value?.boot?.tab ?? 'loading';
  if (tab === 'settled') return null;
  const failed = tab === 'failed';
  return (
    <div class="live-placeholder" data-tab={tab} role="status">
      <EpoMark size={40} label={null} />
      <p>{failed ? PLACEHOLDER.offline : PLACEHOLDER.loading}</p>
      {failed ? (
        <button type="button" class="sb-btn sb-btn--ghost live-placeholder__retry" onClick={() => controls.signIn()}>
          {PLACEHOLDER.retry}
        </button>
      ) : null}
    </div>
  );
}
