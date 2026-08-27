/** @jsx h */
import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import { Button } from '@/renderer/ui/Button';
import { CollapsibleCard } from '@/renderer/ui/CollapsibleCard';
import type { UpdateStatus } from '@/types';

export interface UpdatesCardProps {
  status: UpdateStatus | null;
  confirm(options: ConfirmOptions): Promise<boolean>;
  index?: number;
}

/** The status line for each updater state (docs/RELEASE.md §5). */
function describe(s: UpdateStatus): string {
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return s.mode === 'full'
        ? `Epo v${s.version} found — downloading.`
        : `Epo v${s.version} is available.`;
    case 'downloading':
      return `Downloading Epo v${s.version} — ${s.percent ?? 0}%.`;
    case 'ready':
      return `Epo v${s.version} is downloaded. It installs when you quit, or restart now.`;
    case 'error':
      return 'The last update check failed.';
    default:
      return s.mode === 'off' ? 'Updates apply to installed builds only.' : 'You are up to date.';
  }
}

/**
 * Updates — the self-updater's face: current version, live status, and the
 * one action the platform supports (restart-and-install on Windows installs;
 * open-the-download-page on macOS and portable builds, which cannot replace
 * themselves). The restart is always confirm-gated: it quits the whole app.
 */
export function UpdatesCard({ status, confirm, index }: UpdatesCardProps): h.JSX.Element {
  const [busy, setBusy] = useState(false);

  const check = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.epo.checkForUpdate();
    } finally {
      setBusy(false);
    }
  };

  const restart = async (): Promise<void> => {
    const ok = await confirm({
      title: `Restart into Epo v${status?.version}?`,
      body:
        'Epo quits, installs the update, and reopens. A running session stops cleanly — press Start again after the update.',
      confirm: 'Restart & update',
      dismiss: 'Not now',
      danger: false,
    });
    if (!ok) return;
    await window.epo.installUpdate();
  };

  const s = status;
  return (
    <CollapsibleCard icon="circle-up" title="Updates" index={index} defaultCollapsed>
      <div class="field">
        <div class="ftop">
          <label>Epo {s !== null ? `v${s.current}` : ''}</label>
        </div>
        <div class="hint">{s !== null ? describe(s) : 'Waiting for the updater…'}</div>
        {s !== null && s.state === 'error' && s.error !== null ? (
          <div class="hint">{s.error}</div>
        ) : null}
        {s === null || s.mode === 'off' ? null : s.state === 'ready' && s.mode === 'full' ? (
          <Button
            wide
            icon="circle-up"
            onClick={() => {
              void restart();
            }}
          >
            Restart &amp; update
          </Button>
        ) : s.state === 'available' && s.mode === 'notify' ? (
          <Button
            wide
            icon="arrow-up-right-from-square"
            onClick={() => {
              void window.epo.openLatestRelease();
            }}
          >
            Open the download page
          </Button>
        ) : (
          <Button
            wide
            icon="arrows-rotate"
            iconSpin={busy || s.state === 'checking' || s.state === 'downloading'}
            disabled={busy || s.state === 'checking' || s.state === 'downloading'}
            onClick={() => {
              void check();
            }}
          >
            Check for updates
          </Button>
        )}
      </div>
    </CollapsibleCard>
  );
}
