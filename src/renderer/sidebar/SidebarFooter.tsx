/**
 * The footer (spec §12.2): the running version, or the update that is waiting (restart to install, or the
 * release page where installing is manual), and the way into Diagnostics (Settings › Advanced).
 */
import type { JSX } from 'preact';
import type { Res } from '@/ipc/contract';
import { useShellControls } from '@/renderer/app/shell-context';
import { FOOTER } from '@/renderer/sidebar/copy/zone-copy';

export function SidebarFooter({ update }: { update: Res<'updateStatus'> | null }): JSX.Element {
  const controls = useShellControls();
  const ready = update?.state === 'ready';
  const available = update?.state === 'available';
  return (
    <footer class="sb-foot" data-zone="footer">
      {ready ? (
        <button type="button" class="sb-link sb-foot__update" onClick={() => void window.epo.installUpdate()}>
          {FOOTER.ready}
        </button>
      ) : available ? (
        <button type="button" class="sb-link sb-foot__update" onClick={() => void window.epo.openLatestRelease()}>
          {FOOTER.available}
        </button>
      ) : (
        <span class="num">{update === null ? '' : FOOTER.version(update.current)}</span>
      )}
      <button type="button" class="sb-link" onClick={() => controls.openSettings({ section: 'diagnostics' })}>
        {FOOTER.diagnostics}
      </button>
    </footer>
  );
}
