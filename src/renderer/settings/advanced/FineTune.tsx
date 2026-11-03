/**
 * The Fine-tune block under an Easy section in Advanced (spec §6.5): the section's intent choices as chip
 * rows at the top, then every parameter row of the section, generically. Nothing above it moves.
 */
import type { ComponentChildren, JSX } from 'preact';
import { RadioChips } from '@/renderer/ui/RadioCards';
import { ACTIVITY_LEVELS, CAUTIONS, CONSISTENCIES, type Intent, type IntentKey, WEEKLY_SHAPES } from '@/shared/settings-intent';
import type { SettingsOp } from '@/shared/settings-ops';
import type { SectionId } from '@/shared/settings-params';
import { INTENT_ROWS_COPY, ROW_COPY } from '../copy/advanced';
import { ACTIVITY_COPY, CAUTION_COPY, CONSISTENCY_COPY, INTENT_ROW_COPY, WEEKLY_COPY } from '../copy/choices';
import { ControlError } from '../fields/controls';
import { fill } from '../format';
import type { StageApi } from '../stage-api';
import { ParamRow } from './ParamRow';

export interface ChoiceRowProps<T extends string> {
  s: StageApi;
  k: string;
  label: string;
  help?: string;
  items: readonly T[];
  selected: T;
  render(v: T): string;
  ops(v: T): SettingsOp[];
}

/** An intent choice as a row of chips (a radio group), sending its op on pick. */
export function ChoiceRow<T extends string>({ s, k, label, help, items, selected, render, ops }: ChoiceRowProps<T>): JSX.Element {
  return (
    <div class="set-param set-param--intent" data-row={k}>
      <div class="set-param__copy">
        <span class="set-param__label">{label}</span>
        {help ? <span class="set-param__help">{help}</span> : null}
      </div>
      <div class="set-param__control">
        <RadioChips
          class="set-choice-chips"
          label={label}
          items={items}
          selected={s.c.value<T>(k, selected)}
          onSelect={(v) => s.send(k, ops(v), v)}
          render={render}
        />
        <ControlError s={s} k={k} />
      </div>
    </div>
  );
}

function intentOp<K extends IntentKey>(key: K): (value: Intent[K]) => SettingsOp[] {
  return (value) => [{ op: 'intent', key, value } as SettingsOp];
}

function PaceChoices({ s }: { s: StageApi }): JSX.Element {
  const o = s.view.options;
  return (
    <>
      <ChoiceRow s={s} k="intent:activity" label={INTENT_ROW_COPY.activity} help={INTENT_ROWS_COPY.activityHelp} items={ACTIVITY_LEVELS}
        selected={s.view.intent.activity} ops={intentOp('activity')}
        render={(l) => fill(INTENT_ROWS_COPY.activityChip, { label: ACTIVITY_COPY[l], n: o.activity[l].perDay.typical })} />
      <ChoiceRow s={s} k="intent:caution" label={INTENT_ROW_COPY.caution} help={INTENT_ROWS_COPY.cautionHelp} items={CAUTIONS}
        selected={s.view.intent.caution} ops={intentOp('caution')}
        render={(c) => fill(INTENT_ROWS_COPY.cautionChip, { label: CAUTION_COPY[c], n: o.caution[c].hourlyCap })} />
      <ChoiceRow s={s} k="intent:consistency" label={INTENT_ROW_COPY.consistency} help={INTENT_ROWS_COPY.consistencyHelp}
        items={CONSISTENCIES} selected={s.view.intent.consistency} ops={intentOp('consistency')} render={(c) => CONSISTENCY_COPY[c]} />
    </>
  );
}

function ScheduleChoices({ s }: { s: StageApi }): JSX.Element {
  return (
    <ChoiceRow s={s} k="intent:weeklyShape" label={INTENT_ROW_COPY.weeklyShape} help={INTENT_ROWS_COPY.weeklyHelp} items={WEEKLY_SHAPES}
      selected={s.view.intent.weeklyShape} ops={intentOp('weeklyShape')} render={(w) => WEEKLY_COPY[w]} />
  );
}

/** The intent rows each section opens its Fine-tune block with. */
const CHOICES: Partial<Record<SectionId, (p: { s: StageApi }) => JSX.Element>> = { pace: PaceChoices, schedule: ScheduleChoices };

/** Sections whose Fine-tune block has parameter rows (the rest have Advanced extras instead). */
export function paramsOf(s: StageApi, section: SectionId) {
  return s.view.params.filter((p) => p.section === section);
}

export function FineTune({ s, section, extra }: { s: StageApi; section: SectionId; extra?: ComponentChildren }): JSX.Element | null {
  const rows = paramsOf(s, section);
  const Choices = CHOICES[section];
  if (rows.length === 0 && Choices === undefined && extra === undefined) return null;
  const overridden = rows.filter((p) => p.override !== null).map((p) => p.key);
  const reset = (): void => s.send(`reset:${section}`, overridden.map((key) => ({ op: 'clear-override', key })));
  return (
    <div class="set-fine" aria-label={ROW_COPY.fineTune} role="group">
      <div class="set-fine__head">
        <span>{ROW_COPY.fineTune}</span>
        {overridden.length > 0 ? (
          <button type="button" class="link-btn" onClick={reset}>
            {ROW_COPY.sectionRecommended}
          </button>
        ) : null}
      </div>
      {Choices ? <Choices s={s} /> : null}
      {rows.map((p) => <ParamRow key={p.key} p={p} s={s} />)}
      {extra ?? null}
    </div>
  );
}
