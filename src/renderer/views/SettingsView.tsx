/** @jsx h */
import { Fragment, h } from 'preact';
import { useCallback, useRef } from 'preact/hooks';
import type { Settings, UpdateStatus } from '@/types';
import { AdvancedCard } from '../cards/settings/AdvancedCard';
import { BehaviorCard } from '../cards/settings/BehaviorCard';
import { DataCard } from '../cards/settings/DataCard';
import { ProjectionCard } from '../cards/settings/ProjectionCard';
import { SeedSessionCard } from '../cards/settings/SeedSessionCard';
import { TargetingCard } from '../cards/settings/TargetingCard';
import { UpdatesCard } from '../cards/settings/UpdatesCard';
import type { ConfirmOptions } from '../hooks/useConfirm';
import { type SaveState, useSettingsDraft } from '../hooks/useSettingsDraft';
import type { ToastKind } from '../hooks/useToasts';
import type { ViewKey } from '../hooks/useView';
import { Card, CardBody } from '../ui/Card';

/** Chip copy per autosave state (the badge uppercases it). */
const SAVE_CHIP: Record<Exclude<SaveState, 'idle'>, string> = {
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
};

export interface SettingsViewProps {
  settings: Settings | null;
  onSaved(next: Settings): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  goTo(view: ViewKey): void;
  /** Shell toast — autosave failures surface here (never silently). */
  toast(kind: ToastKind, message: string): void;
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
  settings,
  onSaved,
  confirm,
  goTo,
  toast,
  seedPrompt,
  onReplayTour,
  updateStatus,
}: SettingsViewProps): h.JSX.Element {
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
      <Card raised index={0}>
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
      <BehaviorCard draft={s.draft} patch={s.patch} set={s.set} index={1} />
      <TargetingCard draft={s.draft} patch={s.patch} set={s.set} index={2} />
      <AdvancedCard draft={s.draft} set={s.set} index={3} />
      <ProjectionCard draft={s.draft} index={4} />
      <UpdatesCard status={updateStatus} confirm={confirm} index={5} />
      <DataCard
        confirm={confirm}
        onResetSettings={onResetSettings}
        onClearData={onClearData}
        onReplayTour={onReplayTour}
        index={6}
      />
    </Fragment>
  );
}
