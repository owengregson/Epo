/**
 * The column's instruments, drawn static for the boards: the posture ring, the
 * plan strip, the seven-day spark, a meter, and sentences with handle buttons.
 */
import { type JSX } from 'preact';
import { hourLabel, type Session } from '@/renderer/gallery/direction/fixtures';
import type { RingMode } from '@/renderer/gallery/direction/postures';
import { Icon } from '@/renderer/ui/Icon';

export interface RingProps {
  size: number;
  mode: RingMode;
  /** Remaining share of the deadline (deplete); ignored when full or static. */
  fraction: number;
  glyph: string;
}

/**
 * One ring, one meaning, and nothing that loops: full while a step runs, a
 * draining arc toward a known deadline, or a still track when idle.
 */
export function Ring({ size, mode, fraction, glyph }: RingProps): JSX.Element {
  const stroke = size >= 80 ? 6 : 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const arc = mode === 'static' ? 0 : mode === 'full' ? 1 : Math.max(0, Math.min(1, fraction));
  return (
    <div class={`dx-ring dx-ring--${mode}`} style={`width:${size}px;height:${size}px`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle class="dx-ring__track" cx={size / 2} cy={size / 2} r={r} stroke-width={stroke} />
        {arc > 0 ? (
          <circle
            class="dx-ring__arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke-width={stroke}
            stroke-dasharray={`${c} ${c}`}
            stroke-dashoffset={c * (1 - arc)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </svg>
      <span class="dx-ring__glyph">
        <Icon name={glyph} />
      </span>
    </div>
  );
}

export interface StripProps {
  sessions: readonly Session[];
  now: number;
  band?: { from: number; to: number };
}

const pct = (h: number, s: number, e: number): number => Math.max(0, Math.min(100, ((h - s) / (e - s)) * 100));

/** Spec §12.2: the strip spans whole hours from the first session (or now) to the last (or now). */
function stripSpan(sessions: readonly Session[], now: number): { start: number; end: number; ticks: number[] } {
  const start = Math.floor(Math.min(sessions[0]?.from ?? now, now));
  const end = Math.ceil(Math.max(sessions[sessions.length - 1]?.to ?? now, now));
  const ticks: number[] = [];
  for (let h = Math.ceil(start / 3) * 3; h <= end; h += 3) ticks.push(h);
  return { start, end, ticks };
}

/** Today's sessions as blocks on an hour axis, the now marker, and the Boost band beneath. */
export function PlanStrip({ sessions, now, band }: StripProps): JSX.Element {
  const { start, end, ticks } = stripSpan(sessions, now);
  return (
    <div class="dx-strip">
      <div class="dx-strip__track">
        {sessions.map((s) => (
          <span
            key={s.from}
            class={`dx-strip__block is-${s.state}`}
            style={`left:${pct(s.from, start, end)}%;width:${pct(s.to, start, end) - pct(s.from, start, end)}%`}
          >
            {s.done > 0 && s.state !== 'done' ? <i style={`width:${s.done * 100}%`} /> : null}
          </span>
        ))}
        <span class="dx-strip__now" style={`left:${pct(now, start, end)}%`} />
        {band ? (
          <span
            class="dx-strip__band"
            style={`left:${pct(band.from, start, end)}%;width:${pct(band.to, start, end) - pct(band.from, start, end)}%`}
          />
        ) : null}
      </div>
      <div class="dx-strip__axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} class={t === start ? 'is-first' : t === end ? 'is-last' : undefined} style={`left:${pct(t, start, end)}%`}>
            {hourLabel(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Seven plan-days of net followers; today is the bright bar. */
export function Spark({ values }: { values: readonly number[] }): JSX.Element {
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const base = 32;
  return (
    <svg class="dx-spark" width="160" height="44" viewBox="0 0 160 44" role="img" aria-label="Up 47 this week">
      <line class="dx-spark__base" x1="0" x2="160" y1={base + 0.5} y2={base + 0.5} />
      {values.map((v, i) => {
        const h = Math.max(2, (Math.abs(v) / max) * (v >= 0 ? base - 2 : 10));
        const today = i === values.length - 1;
        return (
          <rect
            key={`${i}-${v}`}
            class={today ? 'is-today' : v < 0 ? 'is-down' : undefined}
            x={i * 23 + 2}
            y={v >= 0 ? base - h : base + 1}
            width="18"
            height={h}
            rx="3"
          />
        );
      })}
    </svg>
  );
}

/** A labelled share with an end tick (the safety meter, budgets). */
export function Meter({ share, tick }: { share: number; tick?: number }): JSX.Element {
  return (
    <div class="dx-meter" aria-hidden="true">
      <i style={`width:${share * 100}%`} />
      {tick === undefined ? null : <b style={`left:${tick * 100}%`} />}
    </div>
  );
}

/** A sentence whose "@" parts are buttons that open the person on the People page. */
export function Said({ parts }: { parts: readonly string[] }): JSX.Element {
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('@') ? (
          <button key={`${i}-${p}`} type="button" class="dx-handle">
            {p}
          </button>
        ) : (
          <span key={`${i}-${p}`}>{p}</span>
        ),
      )}
    </>
  );
}

/** The People tab's two-figure glyph (until SH adds the Font Awesome `users` path). */
export function PeopleGlyph(): JSX.Element {
  return (
    <svg class="icon" viewBox="0 0 20 20" width="1em" height="1em" fill="currentColor" aria-hidden="true">
      <circle cx="7.5" cy="6" r="3.3" />
      <path d="M1.5 17.5c0-3.9 2.7-6.3 6-6.3s6 2.4 6 6.3z" />
      <circle cx="14.2" cy="6.9" r="2.6" />
      <path d="M12.6 11.4c3.2-.4 5.9 1.9 5.9 6.1h-3.4c0-2.5-.9-4.6-2.5-6.1z" />
    </svg>
  );
}
