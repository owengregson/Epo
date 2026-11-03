/**
 * When Epo works (spec §6.4): five day cards, each with its 24-hour activity preview from the view (quiet
 * hours shaded), the quiet-hours row, day-off chips (at most all but one day), and the session-style cards.
 * Quiet hours and days off are plan inputs, so they show only once the plan is wired.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { DayChips } from '@/renderer/ui/DayChips';
import { type CardChoice, RadioCards } from '@/renderer/ui/RadioCards';
import { type DayOfWeek, type DayShape, MAX_DAYS_OFF, RHYTHMS, type Rhythm } from '@/shared/settings-intent';
import type { ScheduleOption } from '@/shared/settings-view';
import { RECOMMENDED, SCHEDULE_COPY } from '../copy/choices';
import { ControlError, Sub } from '../fields/controls';
import { QuietHoursField } from '../fields/QuietHoursField';
import { fill, hourLabel } from '../format';
import type { SectionProps, StageApi } from '../stage-api';

const HOURS = 24;
const MINUTES_PER_HOUR = 60;
/** Bar heights in percent: a quiet hour sits low; an active hour scales with its intensity. */
const QUIET_BAR = 8;
const BAR_FLOOR = 12;

function inQuiet(hour: number, quiet: ScheduleOption['quiet']): boolean {
  if (quiet === null) return false;
  const m = hour * MINUTES_PER_HOUR + MINUTES_PER_HOUR / 2;
  const { startMinute: a, endMinute: b } = quiet;
  return a > b ? m >= a || m < b : m >= a && m < b;
}

/** A day shape's activity over 24 hours, from main's intensities (0..1), quiet hours shaded. */
export function DayBars({ option }: { option: ScheduleOption }): JSX.Element {
  return (
    <span class="set-daybars" aria-hidden="true">
      <span class="set-daybars__bars">
        {Array.from({ length: HOURS }, (_, h) => {
          const quiet = inQuiet(h, option.quiet);
          const level = option.intensity[h] ?? 0;
          const height = quiet ? QUIET_BAR : BAR_FLOOR + level * (100 - BAR_FLOOR);
          return <i key={h} class={quiet ? 'is-quiet' : undefined} style={`height:${height}%`} />;
        })}
      </span>
      <span class="set-daybars__axis">
        <small>{hourLabel(0)}</small>
        <small>{hourLabel(HOURS / 2)}</small>
      </span>
    </span>
  );
}

function DaysOff({ s }: { s: StageApi }): JSX.Element {
  const key = 'intent:daysOff';
  const [refused, setRefused] = useState(false);
  const days = s.c.value<readonly DayOfWeek[]>(key, s.view.intent.daysOff);
  return (
    <div class="set-row set-row--stack" data-row="daysOff">
      <div class="set-row__line">
        <span class="set-row__k">{SCHEDULE_COPY.daysOff}</span>
        <DayChips
          label={SCHEDULE_COPY.daysOff}
          selected={days}
          max={MAX_DAYS_OFF}
          onChange={(next) => {
            setRefused(false);
            s.send(key, [{ op: 'intent', key: 'daysOff', value: next }], next);
          }}
          onRefuse={() => setRefused(true)}
        />
      </div>
      <p class="set-sec__hint">{fill(SCHEDULE_COPY.daysOffHint, { max: MAX_DAYS_OFF })}</p>
      {refused ? (
        <p class="set-note" role="status">
          {SCHEDULE_COPY.allOff}
        </p>
      ) : null}
      <ControlError s={s} k={key} />
    </div>
  );
}

export function ScheduleSection({ s }: SectionProps): JSX.Element {
  const { view } = s;
  const shapeKey = 'intent:dayShape';
  const rhythmKey = 'intent:rhythm';
  const shapes: CardChoice<DayShape>[] = view.options.schedule.map((o) => ({
    value: o.dayShape,
    title: SCHEDULE_COPY.shapes[o.dayShape],
    art: <DayBars option={o} />,
    recommended: o.dayShape === RECOMMENDED.intent.dayShape,
  }));
  const rhythms: CardChoice<Rhythm>[] = RHYTHMS.map((r) => ({
    value: r,
    title: SCHEDULE_COPY.rhythm[r],
    line: fill(SCHEDULE_COPY.rhythmLine, { a: view.options.rhythm[r].sessions.min, b: view.options.rhythm[r].sessions.max }),
    recommended: r === RECOMMENDED.intent.rhythm,
  }));
  return (
    <>
      <RadioCards
        class="radio-cards--days"
        label={SCHEDULE_COPY.shapeLabel}
        dataRow="schedule.shape"
        choices={shapes}
        selected={s.c.value(shapeKey, view.intent.dayShape)}
        onSelect={(v) => s.send(shapeKey, [{ op: 'intent', key: 'dayShape', value: v }], v)}
        pending={s.c.pending(shapeKey)}
      />
      <ControlError s={s} k={shapeKey} />
      {view.capabilities.plan ? (
        <>
          <QuietHoursField s={s} />
          <DaysOff s={s} />
        </>
      ) : null}
      <Sub>{SCHEDULE_COPY.sessions}</Sub>
      <RadioCards
        label={SCHEDULE_COPY.sessions}
        dataRow="schedule.rhythm"
        choices={rhythms}
        selected={s.c.value(rhythmKey, view.intent.rhythm)}
        onSelect={(v) => s.send(rhythmKey, [{ op: 'intent', key: 'rhythm', value: v }], v)}
        pending={s.c.pending(rhythmKey)}
      />
      <ControlError s={s} k={rhythmKey} />
    </>
  );
}
