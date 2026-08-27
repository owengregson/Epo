/** @jsx h */
import { Fragment, h } from 'preact';
import type { Settings, UpdateStatus } from '@/types';
import { AdvancedCard } from '../cards/settings/AdvancedCard';
import { BehaviorCard } from '../cards/settings/BehaviorCard';
import { DataCard } from '../cards/settings/DataCard';
import { ProjectionCard } from '../cards/settings/ProjectionCard';
import { SeedSessionCard } from '../cards/settings/SeedSessionCard';
import { TargetingCard } from '../cards/settings/TargetingCard';
import { UpdatesCard } from '../cards/settings/UpdatesCard';
import type { ConfirmOptions } from '../hooks/useConfirm';
import { useSettingsDraft } from '../hooks/useSettingsDraft';
import type { ViewKey } from '../hooks/useView';
import { Card, CardBody } from '../ui/Card';

export interface SettingsViewProps {
  settings: Settings | null;
  onSaved(next: Settings): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
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
 * pacing config in one edit.
 */
export function SettingsView({
  settings,
  onSaved,
  confirm,
  goTo,
  seedPrompt,
  onReplayTour,
  updateStatus,
}: SettingsViewProps): h.JSX.Element {
  const s = useSettingsDraft(settings, onSaved);

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
