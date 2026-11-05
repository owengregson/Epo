/**
 * Quiet hours (spec §6.2, §6.4): the window in force as one line ("11:30 PM – 6:00 AM · from your
 * schedule"), and an editor behind [Change]: follow the schedule, set my own (two native time pickers on the
 * document's half-hour grid) or none. Every pick saves at once; the window itself is computed by main.
 */
import type { JSX } from 'preact';
import { useId, useState } from 'preact/hooks';
import { TimeSelect } from '@/renderer/ui/TimeSelect';
import type { QuietHours } from '@/shared/settings-intent';
import { SCHEDULE_COPY } from '../copy/choices';
import { fill, minuteLabel } from '../format';
import type { StageApi } from '../stage-api';
import { ControlError } from './controls';

const KEY = 'intent:quietHours';
/** The document's grid for a custom window (main snaps to it). */
const GRID_MINUTES = 30;
const DAY_MINUTES = 24 * 60;
const GRID = Array.from({ length: DAY_MINUTES / GRID_MINUTES }, (_, i) => i * GRID_MINUTES);

type Kind = QuietHours['kind'];
type Window = { readonly startMinute: number; readonly endMinute: number };

/** The window to start a custom choice from: the one in force, else the schedule's own. */
function seedWindow(s: StageApi): Window | null {
  return s.view.easy.quietHours ?? s.view.options.schedule.find((o) => o.dayShape === s.view.intent.dayShape)?.quiet ?? null;
}

function line(q: QuietHours, shown: Window | null): string {
  if (q.kind === 'none' || shown === null) return SCHEDULE_COPY.quietNone;
  const span = { start: minuteLabel(shown.startMinute), end: minuteLabel(shown.endMinute) };
  return fill(q.kind === 'custom' ? SCHEDULE_COPY.quietCustomLine : SCHEDULE_COPY.quietLine, span);
}

export function QuietHoursField({ s }: { s: StageApi }): JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);
  const q = s.c.value<QuietHours>(KEY, s.view.intent.quietHours);
  const shown: Window | null = q.kind === 'custom' ? q : q.kind === 'none' ? null : s.view.easy.quietHours;
  const send = (next: QuietHours): void => s.send(KEY, [{ op: 'intent', key: 'quietHours', value: next }], next);

  const pick = (kind: Kind): void => {
    if (kind === q.kind) return;
    if (kind !== 'custom') {
      send({ kind });
      return;
    }
    const from = seedWindow(s);
    if (from !== null) send({ kind: 'custom', startMinute: from.startMinute, endMinute: from.endMinute });
  };
  const custom = q.kind === 'custom' ? q : null;
  const options: ReadonlyArray<[Kind, string]> = [['derived', SCHEDULE_COPY.follow], ['custom', SCHEDULE_COPY.own], ['none', SCHEDULE_COPY.none]];

  return (
    <div class="set-row set-row--stack" data-row="quietHours">
      <div class="set-row__line">
        <span class="set-row__k">{SCHEDULE_COPY.quiet}</span>
        <span class="set-row__v num">
          {line(q, shown)}
          <button type="button" class="link-btn" aria-expanded={open} aria-controls={`${id}-ed`} onClick={() => setOpen(!open)}>
            {SCHEDULE_COPY.change}
          </button>
        </span>
      </div>
      {open ? (
        <fieldset class="set-quiet" id={`${id}-ed`}>
          <legend class="sr-only">{SCHEDULE_COPY.quiet}</legend>
          {options.map(([kind, label]) => (
            <label key={kind} class="set-radio">
              <input type="radio" name={`${id}-kind`} checked={q.kind === kind} onChange={() => pick(kind)} />
              <span>{label}</span>
            </label>
          ))}
          {custom !== null ? (
            <div class="set-quiet__times">
              <TimeSelect
                label={SCHEDULE_COPY.from}
                value={custom.startMinute}
                options={GRID}
                format={minuteLabel}
                disabledValue={custom.endMinute}
                onChange={(m) => send({ ...custom, startMinute: m })}
              />
              <TimeSelect
                label={SCHEDULE_COPY.to}
                value={custom.endMinute}
                options={GRID}
                format={minuteLabel}
                disabledValue={custom.startMinute}
                onChange={(m) => send({ ...custom, endMinute: m })}
              />
            </div>
          ) : null}
        </fieldset>
      ) : null}
      <p class="set-sec__hint">{SCHEDULE_COPY.quietHint}</p>
      <ControlError s={s} k={KEY} />
    </div>
  );
}
