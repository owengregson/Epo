import type { ComponentChildren, JSX } from 'preact';
import type { QueueState } from '@/renderer/settings/change-queue';
import { RadioChips } from '@/renderer/ui/RadioCards';
import { SaveStatus, type SaveStatusProps } from '@/renderer/ui/SaveStatus';
import { SAVE_COPY, STAGE_COPY } from './copy/sections';
import { fill } from './format';
import type { SettingsMode } from './sections';

const MODES: readonly SettingsMode[] = ['easy', 'advanced'];

/** The header's save sentence for the queue's state (Appendix B.10). */
export function saveStatusOf(state: QueueState, undo: () => void, retry: () => void): SaveStatusProps {
  const s = state.save;
  switch (s.kind) {
    case 'idle':
      return { tone: 'idle', text: SAVE_COPY.idle };
    case 'saving':
      return { tone: 'saving', text: SAVE_COPY.saving };
    case 'saved':
      return {
        tone: 'saved',
        text: s.adjusted > 0 ? fill(SAVE_COPY.adjusted, { n: s.adjusted === 1 ? '1 value' : `${s.adjusted} values` }) : SAVE_COPY.saved,
        action: s.inverse.length > 0 ? { label: SAVE_COPY.undo, run: undo } : null,
      };
    case 'failed':
      return { tone: 'failed', text: SAVE_COPY.failed, action: { label: SAVE_COPY.tryAgain, run: retry } };
  }
}

export interface SettingsHeaderProps {
  mode: SettingsMode;
  onMode(mode: SettingsMode): void;
  save: SaveStatusProps;
  /** The search box (step in from the stage so it can navigate). */
  search?: ComponentChildren;
}

/** Title, the Easy | Advanced switch (a radio group: arrows move, one tab stop), search and the save state. */
export function SettingsHeader({ mode, onMode, save, search }: SettingsHeaderProps): JSX.Element {
  return (
    <header class="set-head">
      <h1>{STAGE_COPY.title}</h1>
      <RadioChips
        class="set-seg"
        label="Settings mode"
        items={MODES}
        selected={mode}
        onSelect={onMode}
        render={(m) => (m === 'easy' ? STAGE_COPY.easy : STAGE_COPY.advanced)}
        title={STAGE_COPY.modeHelp}
      />
      {search ?? null}
      <SaveStatus {...save} />
    </header>
  );
}
