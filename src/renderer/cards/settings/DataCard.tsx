/** @jsx h */
import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import { Button } from '@/renderer/ui/Button';
import { CollapsibleCard } from '@/renderer/ui/CollapsibleCard';

export interface DataCardProps {
  confirm(options: ConfirmOptions): Promise<boolean>;
  onResetSettings(): Promise<void>;
  onClearData(): Promise<void>;
  /** Re-open the intro tour (the walkthrough the shell shows on first launch). */
  onReplayTour(): void;
  index?: number;
}

/** Which destructive action is currently awaiting the backend. */
type PendingAction = 'reset' | 'clear' | null;

/**
 * Data & Session — the intro-tour replay plus the two confirm-gated reset
 * actions. "Reset settings" restores defaults (data + session untouched);
 * "Clear data & log out" wipes the knowledge DB and signs out of Instagram
 * (settings kept). Each destructive button spins while its action is in
 * flight, and both lock while either is pending.
 */
export function DataCard({
  confirm,
  onResetSettings,
  onClearData,
  onReplayTour,
  index,
}: DataCardProps): h.JSX.Element {
  const [pending, setPending] = useState<PendingAction>(null);

  const resetSettings = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Reset all settings?',
      body: 'This restores every setting to its default. Your data and Instagram session are untouched.',
      confirm: 'Reset settings',
      dismiss: 'Keep mine',
      danger: true,
    });
    if (!ok) return;
    setPending('reset');
    try {
      await onResetSettings();
    } finally {
      setPending(null);
    }
  };

  const clearData = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Clear all data and log out?',
      body:
        'This permanently wipes the local knowledge database (targets, progress, stats) and signs you out of Instagram. ' +
        'Your settings are kept. This cannot be undone.',
      confirm: 'Clear & log out',
      dismiss: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    setPending('clear');
    try {
      await onClearData();
    } finally {
      setPending(null);
    }
  };

  return (
    <CollapsibleCard icon="database" title="Data & session" index={index} defaultCollapsed>
      <div class="field">
        <div class="ftop">
          <label>Intro tour</label>
        </div>
        <div class="hint">
          Walk through the console again — the stage, transport, consoles, graph, prune, and
          settings.
        </div>
        <Button wide icon="circle-play" onClick={onReplayTour}>
          Replay the intro tour
        </Button>
      </div>
      <div class="field">
        <div class="ftop">
          <label>Reset settings</label>
        </div>
        <div class="hint">Restore every setting to its default. Your data and session are untouched.</div>
        <Button
          wide
          danger
          icon="arrows-rotate"
          iconSpin={pending === 'reset'}
          disabled={pending !== null}
          onClick={() => {
            void resetSettings();
          }}
        >
          Reset settings to defaults
        </Button>
      </div>
      <div class="field">
        <div class="ftop">
          <label>Clear data &amp; log out</label>
        </div>
        <div class="hint">
          Wipe the local database — targets, progress, stats — and sign out of Instagram. Your settings are
          kept. This can&rsquo;t be undone.
        </div>
        <Button
          wide
          danger
          icon="trash"
          iconSpin={pending === 'clear'}
          disabled={pending !== null}
          onClick={() => {
            void clearData();
          }}
        >
          Clear data &amp; log out
        </Button>
      </div>
    </CollapsibleCard>
  );
}
