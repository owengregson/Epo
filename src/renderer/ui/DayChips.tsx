import type { JSX } from 'preact';
import type { DayOfWeek } from '@/shared/settings-intent';

/** Monday first, as a week reads; the values stay the document's Sun..Sat indexes. */
const MON_FIRST: readonly DayOfWeek[] = [1, 2, 3, 4, 5, 6, 0];
/** A known Sunday, so each index gets its local short name. */
const A_SUNDAY = new Date(2026, 0, 4);

export function dayName(d: DayOfWeek, style: 'short' | 'long' = 'short'): string {
  const at = new Date(A_SUNDAY);
  at.setDate(A_SUNDAY.getDate() + d);
  return at.toLocaleDateString(undefined, { weekday: style });
}

export interface DayChipsProps {
  label: string;
  selected: readonly DayOfWeek[];
  /** The most days that may be chosen; pressing one more calls `onRefuse` instead. */
  max: number;
  onChange(next: DayOfWeek[]): void;
  onRefuse?(): void;
}

/** Day-of-week toggles (`aria-pressed`), Monday first; never more than `max` on. */
export function DayChips({ label, selected, max, onChange, onRefuse }: DayChipsProps): JSX.Element {
  const on = new Set(selected);
  const toggle = (d: DayOfWeek): void => {
    if (on.has(d)) {
      onChange(selected.filter((x) => x !== d));
      return;
    }
    if (on.size >= max) {
      onRefuse?.();
      return;
    }
    onChange([...selected, d].sort((a, b) => a - b));
  };
  return (
    <div class="day-chips" role="group" aria-label={label}>
      {MON_FIRST.map((d) => (
        <button
          key={d}
          type="button"
          class={on.has(d) ? 'set-chip is-on' : 'set-chip'}
          aria-pressed={on.has(d)}
          aria-label={dayName(d, 'long')}
          onClick={() => toggle(d)}
        >
          {dayName(d)}
        </button>
      ))}
    </div>
  );
}
