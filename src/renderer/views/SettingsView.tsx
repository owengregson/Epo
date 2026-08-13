/** @jsx h */
import { h, Fragment } from 'preact';
import type { Settings } from '@/types';
import type { ConfirmOptions } from '../hooks/useConfirm';
import type { ViewKey } from '../hooks/useView';
import { useSettingsDraft } from '../hooks/useSettingsDraft';
import { Card, CardBody } from '../ui/Card';
import { SeedSessionCard } from '../cards/settings/SeedSessionCard';
import { StrategyCard } from '../cards/settings/StrategyCard';
import { ProjectionCard } from '../cards/settings/ProjectionCard';
import { TargetingCard } from '../cards/settings/TargetingCard';
import { LifecycleCard } from '../cards/settings/LifecycleCard';
import { SafetyCard } from '../cards/settings/SafetyCard';
import { CadenceCard } from '../cards/settings/CadenceCard';
import { DryRunCard } from '../cards/settings/DryRunCard';
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
 * Settings view — Seed·Session, Strategy, Projected Growth, Targeting, Lifecycle,
 * Safety, Cadence, Dry-run, Data & Session. Every knob binds to the real Settings object through
 * the draft hook, which autosaves (debounced) via `settings:update`.
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
      <StrategyCard preset={s.preset} setPreset={s.setPreset} />
      <ProjectionCard draft={s.draft} />
      <TargetingCard draft={s.draft} patch={s.patch} set={s.set} />
      <LifecycleCard draft={s.draft} set={s.set} />
      <SafetyCard draft={s.draft} locked={s.locked} setRate={s.setRate} patch={s.patch} set={s.set} />
      <CadenceCard draft={s.draft} set={s.set} />
      <DryRunCard draft={s.draft} set={s.set} />
      <DataCard confirm={confirm} onResetSettings={onResetSettings} onClearData={onClearData} />
    </Fragment>
  );
}
