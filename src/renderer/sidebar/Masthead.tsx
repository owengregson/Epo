/**
 * The masthead (spec §12.2): the mark (its ring breathes while Epo is live, brass while it holds), the
 * wordmark, the signed-in account and the connection dot. One band with the stage bar.
 */
import type { JSX } from 'preact';
import { statusSignal } from '@/renderer/app/shell-context';
import { EpoMark } from '@/renderer/ui/EpoMark';
import type { PostureTone } from '@/shared/posture';

export function Masthead({ tone }: { tone: PostureTone }): JSX.Element {
  const status = statusSignal.value;
  const username = status?.account?.username ?? null;
  const online = status?.online ?? true;
  return (
    <header class="sb-mast" data-zone="masthead" data-tone={tone}>
      <span class="sb-mast__mark" data-boot-mark="">
        <EpoMark size={24} label={null} />
      </span>
      <span class="sb-mast__word">Epo</span>
      {username === null ? null : <span class="sb-mast__acct">@{username}</span>}
      <span
        class={online ? 'sb-dot' : 'sb-dot is-off'}
        role="img"
        aria-label={online ? 'Online' : 'Offline'}
        data-tip={online ? 'Online' : 'Offline'}
      />
    </header>
  );
}
