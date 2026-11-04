import type { JSX } from 'preact';
import { Icon } from '@/renderer/ui/Icon';

export type SaveTone = 'idle' | 'saving' | 'saved' | 'failed';

export interface SaveStatusProps {
  tone: SaveTone;
  /** The sentence for the state ("All changes saved", "Saved", "Couldn’t save — nothing was changed."). */
  text: string;
  /** A trailing action: Undo after a save, Try again after a failure. */
  action?: { label: string; run(): void } | null;
}

const GLYPH: Readonly<Record<SaveTone, string | null>> = { idle: 'check', saving: null, saved: 'check', failed: 'circle-exclamation' };

/**
 * The save state in one polite live region: every state replaces the last in place (a crossfade), so a
 * screen reader hears each outcome once and nothing moves around it.
 */
export function SaveStatus({ tone, text, action }: SaveStatusProps): JSX.Element {
  const glyph = GLYPH[tone];
  return (
    <span class="save-status" data-tone={tone} role="status" aria-live="polite">
      <span class="save-status__line" key={`${tone}:${text}`}>
        {glyph === null ? null : <Icon name={glyph} />}
        <span>{text}</span>
      </span>
      {action ? (
        <button type="button" class="link-btn" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </span>
  );
}
