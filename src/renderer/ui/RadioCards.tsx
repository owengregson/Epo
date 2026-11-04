import type { ComponentChildren, JSX } from 'preact';
import { Icon } from '@/renderer/ui/Icon';

/**
 * Arrow keys move the choice inside a radio group; only the checked item is a tab stop (roving tabindex).
 * Moving selects, as native radios do; Home and End jump to the ends.
 */
function onRovingKey<T>(e: KeyboardEvent, items: readonly T[], selected: T | null, onSelect: (v: T) => void): void {
  const i = Math.max(0, selected === null ? 0 : items.indexOf(selected));
  const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
  if (next === null || items.length === 0) return;
  e.preventDefault();
  const to = (next + items.length) % items.length;
  onSelect(items[to] as T);
  const group = (e.currentTarget as HTMLElement | null)?.querySelectorAll<HTMLElement>('[role="radio"]');
  group?.[to]?.focus();
}

export interface CardChoice<T> {
  readonly value: T;
  readonly title: string;
  /** A live number from the view ("About 44 a day"); it may roll when it changes. */
  readonly metric?: ComponentChildren;
  readonly line?: string;
  readonly recommended?: boolean;
  /** A preview between the title and detail (the day-shape bars). */
  readonly art?: ComponentChildren;
  readonly disabled?: boolean;
}

export interface RadioCardsProps<T> {
  label: string;
  choices: readonly CardChoice<T>[];
  /** null: none of the choices is in force (a "custom" mix). */
  selected: T | null;
  onSelect(value: T): void;
  /** Focus or hover on a card (the stage previews its numbers without asking main). */
  onPreview?(value: T | null): void;
  pending?: boolean;
  class?: string;
  /** The page anchor search and deep links scroll to. */
  dataRow?: string;
}

/** Intent cards share row tracks; selection stays in the heading, never adding a content row. */
export function RadioCards<T>({ label, choices, selected, onSelect, onPreview, pending, class: cls, dataRow }: RadioCardsProps<T>): JSX.Element {
  const values = choices.filter((c) => !c.disabled).map((c) => c.value);
  const art = choices.some((c) => c.art);
  const metric = choices.some((c) => c.metric);
  const detail = choices.some((c) => c.line);
  const recommendation = choices.some((c) => c.recommended);
  const rows = 1 + Number(art) + Number(metric) + Number(detail) + Number(recommendation);
  return (
    <div
      class={cls ? `radio-cards ${cls}` : 'radio-cards'}
      role="radiogroup"
      aria-label={label}
      aria-busy={pending ? 'true' : undefined}
      data-row={dataRow}
      style={`--cols:${Math.min(3, choices.length)};--card-rows:${rows}`}
      onKeyDown={(e) => onRovingKey(e, values, selected, onSelect)}
    >
      {choices.map((c) => {
        const on = c.value === selected;
        return (
          <button
            key={String(c.value)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (selected === null && c.value === values[0]) ? 0 : -1}
            disabled={c.disabled}
            class={on ? 'radio-card is-on' : 'radio-card'}
            onClick={() => onSelect(c.value)}
            onMouseEnter={() => onPreview?.(c.value)}
            onMouseLeave={() => onPreview?.(null)}
            onFocus={() => onPreview?.(c.value)}
            onBlur={() => onPreview?.(null)}
          >
            <span class="radio-card__top">
              <span class="radio-card__title">{c.title}</span>
              <span class="radio-card__sel" aria-hidden="true">{on ? <Icon name="check" /> : null}</span>
            </span>
            {art ? <span class="radio-card__art">{c.art ?? null}</span> : null}
            {metric ? <span class="radio-card__metric num">{c.metric ?? null}</span> : null}
            {detail ? <span class="radio-card__line">{c.line ?? null}</span> : null}
            {recommendation ? <span class="radio-card__rec">{c.recommended ? 'Recommended' : null}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface RadioChipsProps<T> {
  label: string;
  items: readonly T[];
  selected: T | null;
  onSelect(value: T): void;
  render(value: T): ComponentChildren;
  class?: string;
  title?: string;
}

/** A compact radio group (segments or chips) with the same keyboard model as the cards. */
export function RadioChips<T>({ label, items, selected, onSelect, render, class: cls, title }: RadioChipsProps<T>): JSX.Element {
  return (
    <div
      class={cls ?? 'radio-chips'}
      role="radiogroup"
      aria-label={label}
      title={title}
      onKeyDown={(e) => onRovingKey(e, items, selected, onSelect)}
    >
      {items.map((v, i) => {
        const on = v === selected;
        return (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (selected === null && i === 0) ? 0 : -1}
            class={on ? 'is-on' : undefined}
            onClick={() => onSelect(v)}
          >
            {render(v)}
          </button>
        );
      })}
    </div>
  );
}
