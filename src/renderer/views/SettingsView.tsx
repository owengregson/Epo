/** @jsx h */
import { h, Fragment } from 'preact';
import type { Settings } from '@/types';
import type { ConfirmOptions } from '../hooks/useConfirm';
import type { ViewKey } from '../hooks/useView';
import { useSettingsDraft } from '../hooks/useSettingsDraft';
import { Card, CardBody } from '../ui/Card';
import { SeedSessionCard } from '../cards/settings/SeedSessionCard';
import { BehaviorCard } from '../cards/settings/BehaviorCard';
import { TargetingCard } from '../cards/settings/TargetingCard';
import { AdvancedCard } from '../cards/settings/AdvancedCard';
import { ProjectionCard } from '../cards/settings/ProjectionCard';
import { DataCard } from '../cards/settings/DataCard';

export interface SettingsViewProps {
  settings: Settings | null;
  onSaved(next: Settings): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  goTo(view: ViewKey): void;
  /** Bumped by the shell when Start was pressed without a seed. */
  seedPrompt: number;
}

/**
 * Settings view — Seed·session (always open), then collapsible Behavior, Targeting,
 * Advanced, Projected growth, and Data·session sections (all minimized by default). Every
 * knob binds to the real Settings object through the draft hook, which autosaves
 * (debounced) via `settings:update`; the qualitative Behavior knobs derive the numeric
 * pacing config in one edit.
 */
export function SettingsView({ settings, onSaved, confirm, goTo, seedPrompt }: SettingsViewProps): h.JSX.Element {
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
      <SeedSessionCard draft={s.draft} patch={s.patch} confirm={confirm} goTo={goTo} requiredPrompt={seedPrompt} />
      <BehaviorCard draft={s.draft} patch={s.patch} set={s.set} index={1} />
      <TargetingCard draft={s.draft} patch={s.patch} set={s.set} index={2} />
      <AdvancedCard draft={s.draft} set={s.set} index={3} />
      <ProjectionCard draft={s.draft} index={4} />
      <DataCard confirm={confirm} onResetSettings={onResetSettings} onClearData={onClearData} index={5} />
    </Fragment>
  );
}
