import { Fragment, type JSX } from 'preact';
import { useCallback, useRef } from 'preact/hooks';
import { useShell } from '@/renderer/app/shell-context';
import { AdvancedCard } from '@/renderer/cards/settings/AdvancedCard';
import { BehaviorCard } from '@/renderer/cards/settings/BehaviorCard';
import { DataCard } from '@/renderer/cards/settings/DataCard';
import { ProjectionCard } from '@/renderer/cards/settings/ProjectionCard';
import { SeedSessionCard } from '@/renderer/cards/settings/SeedSessionCard';
import { TargetingCard } from '@/renderer/cards/settings/TargetingCard';
import { UpdatesCard } from '@/renderer/cards/settings/UpdatesCard';
import { type SaveState, useSettingsDraft } from '@/renderer/hooks/useSettingsDraft';
import type { ViewKey } from '@/renderer/hooks/useView';
import { Card, CardBody } from '@/renderer/ui/Card';
import type { UpdateStatus } from '@/types';

/** Chip copy per autosave state (the badge uppercases it). */
const SAVE_CHIP: Record<Exclude<SaveState, 'idle'>, string> = {
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
};

export interface SettingsViewProps {
  goTo(view: ViewKey): void;
  /** Bumped by the shell when Start was pressed without a seed. */
  seedPrompt: number;
  /** Re-open the intro tour (the Data & session card offers a replay). */
  onReplayTour(): void;
  /** Live self-updater status (the Updates card mirrors it). */
  updateStatus: UpdateStatus | null;
}

/**
 * Settings view — Seed·session (always open), then collapsible Behavior, Targeting,
 * Advanced, Projected growth, and Data·session sections (all minimized by default). Every
 * knob binds to the real Settings object through the draft hook, which autosaves
 * (debounced) via `settings:update`; the qualitative Behavior knobs derive the numeric
 * pacing config in one edit. The surface header chip mirrors the autosave lifecycle
 * (Saving… / Saved / Not saved) and a failed save additionally raises a toast.
 */
export function SettingsView({
  goTo,
  seedPrompt,
  onReplayTour,
  updateStatus,
}: SettingsViewProps): JSX.Element {
  const { settings, onSaved, confirm, toast } = useShell();
  const onSaveError = useCallback(
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      toast('error', `Couldn't save settings: ${msg} — your edits are kept and retry on the next change.`);
    },
    [toast],
  );
  const s = useSettingsDraft(settings, onSaved, onSaveError);

  // The chip fades out on 'idle' — keep the last shown state so the label and
  // tone survive the fade instead of blanking mid-transition.
  const lastShown = useRef<Exclude<SaveState, 'idle'> | null>(null);
  if (s.saveState !== 'idle') lastShown.current = s.saveState;
  const chipState = s.saveState !== 'idle' ? s.saveState : lastShown.current;

  /** Restore defaults on the backend, then adopt them without re-saving. */
  const onResetSettings = async (): Promise<void> => {
    const defaults = await window.epo.resetSettings();
    s.replace(defaults);
    onSaved(defaults);
  };

  /** Wipe the knowledge DB + IG session; the shell reacts to the pushed logged-out status. */
  const onClearData = async (): Promise<void> => {
    await window.epo.clearData();
    goTo('overview');
  };

  if (!s.draft) {
    return (
      <Card raised>
        <CardBody>Loading settings…</CardBody>
      </Card>
    );
  }

  return (
    <Fragment>
      {/* Surface header: the autosave state chip, pinned top-right so persistence
          feedback stays visible while ANY card — including the safety caps — is
          being edited. Zero-height, so the card stack never shifts. */}
      <div class="save-h" role="status" aria-live="polite">
        {chipState !== null ? (
          <span class={`badge save-chip ${chipState}${s.saveState !== 'idle' ? ' show' : ''}`}>
            {SAVE_CHIP[chipState]}
          </span>
        ) : null}
      </div>
      {/* The wrapper is the intro tour's spotlight anchor for the seed step. */}
      <div class="tour-wrap" data-tour="seed">
        <SeedSessionCard draft={s.draft} patch={s.patch} confirm={confirm} goTo={goTo} requiredPrompt={seedPrompt} />
      </div>
      <BehaviorCard draft={s.draft} patch={s.patch} set={s.set} />
      <TargetingCard draft={s.draft} patch={s.patch} set={s.set} />
      <AdvancedCard draft={s.draft} set={s.set} />
      <ProjectionCard draft={s.draft} />
      <UpdatesCard status={updateStatus} confirm={confirm} />
      <DataCard
        confirm={confirm}
        onResetSettings={onResetSettings}
        onClearData={onClearData}
        onReplayTour={onReplayTour}
      />
    </Fragment>
  );
}
