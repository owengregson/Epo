/** @jsx h */
import { h, Fragment } from 'preact';

export interface SliderProps {
  id?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput(value: number): void;
  disabled?: boolean;
  ariaLabel?: string;
  /** Number of snap ticks to draw beneath the track. */
  ticks?: number;
  /** End (or evenly-spaced) tick labels beneath the track. */
  tickLabels?: string[];
}

/**
 * A single-thumb range slider with a filled track (the fill width comes from the
 * `--pct` custom property, computed from `value`). Controlled: the parent owns
 * `value`; the readout lives in the enclosing {@link Field}.
 */
export function Slider({
  id,
  min,
  max,
  step,
  value,
  onInput,
  disabled,
  ariaLabel,
  ticks,
  tickLabels,
}: SliderProps): h.JSX.Element {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <Fragment>
      <input
        type="range"
        id={id}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        style={`--pct:${pct}%`}
        onInput={(e) => onInput(Number((e.currentTarget as HTMLInputElement).value))}
      />
      {ticks ? (
        <div class="tickrow" aria-hidden="true">
          {Array.from({ length: ticks }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      ) : null}
      {tickLabels ? (
        <div class="ticklabels num" aria-hidden="true">
          {tickLabels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      ) : null}
    </Fragment>
  );
}
