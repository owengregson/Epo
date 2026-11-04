/**
 * Today's plan strip (spec §12.2): the day's sessions on an hour axis cropped to whole hours around them and
 * now, the Boost window as a band beneath, and a 2 px now marker moved by ONE animation across the rest of
 * the strip (re-armed only when the strip's span changes; under reduced motion the minute clock moves it).
 */
import type { JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Res } from '@/ipc/contract';
import { useNow } from '@/renderer/app/clock';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import { play } from '@/renderer/lib/play';
import { sessionTip } from '@/renderer/sidebar/copy/zone-copy';
import { hourLabel } from '@/renderer/sidebar/format';

type Plan = NonNullable<Res<'status'>['plan']>;
type Session = Plan['sessions'][number];

const HOUR_MS = 60 * 60 * 1000;

function floorHour(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function ceilHour(t: number): number {
  const f = floorHour(t);
  return f === t ? t : f + HOUR_MS;
}

/** The strip's span: whole hours from the first session (or now) to the last (or now). */
function stripSpan(sessions: readonly Session[], now: number): { start: number; end: number } {
  const first = sessions.reduce((m, s) => Math.min(m, s.startAt), now);
  const last = sessions.reduce((m, s) => Math.max(m, s.endAt), now);
  const start = floorHour(first);
  return { start, end: Math.max(ceilHour(last), start + HOUR_MS) };
}

/** Both bounds and up to three interior hours: labels have room at the native sidebar width. */
function stripTicks(start: number, end: number): number[] {
  const hours = (end - start) / HOUR_MS;
  const step = Math.max(1, Math.ceil(hours / 4));
  const ticks: number[] = [start];
  for (let t = start + step * HOUR_MS; t < end; t += step * HOUR_MS) {
    if (end - t >= step * HOUR_MS / 2) ticks.push(t);
  }
  ticks.push(end);
  return ticks;
}

const share = (t: number, start: number, end: number): number => Math.max(0, Math.min(1, (t - start) / (end - start)));
const pct = (f: number): string => `${(f * 100).toFixed(3)}%`;

function Block({ s, start, end }: { s: Session; start: number; end: number }): JSX.Element {
  const left = share(s.startAt, start, end);
  const width = Math.max(0, share(s.endAt, start, end) - left);
  const filled = s.planned > 0 ? Math.min(1, s.done / s.planned) : 0;
  return (
    <span
      class={`sb-strip__block is-${s.state}${s.mix === 'boost' ? ' is-boost' : ''}`}
      style={{ left: pct(left), width: pct(width) }}
      data-tip={sessionTip(s)}
      role="img"
      aria-label={sessionTip(s)}
    >
      {s.state === 'now' || s.state === 'partial' ? <i style={{ transform: `scaleX(${filled})` }} /> : null}
    </span>
  );
}

export interface PlanStripProps {
  readonly plan: Plan;
  readonly band: { readonly from: number; readonly to: number } | null;
}

export function PlanStrip({ plan, band }: PlanStripProps): JSX.Element {
  const reduced = reducedMotionSignal.value;
  const now = useNow('minute');
  const { start, end } = stripSpan(plan.sessions, now);
  const marker = useRef<HTMLSpanElement>(null);
  const at = share(now, start, end);
  const ticks = stripTicks(start, end);

  // One linear move from now to the strip's end, landing as the span runs out.
  useLayoutEffect(() => {
    const el = marker.current;
    if (el === null) return;
    for (const a of el.getAnimations?.() ?? []) a.cancel();
    const t = Date.now();
    if (t >= end) return;
    void play(el, [{ transform: `translateX(${pct(share(t, start, end))})` }, { transform: 'translateX(100%)' }],
      { duration: end - t, easing: 'linear', fill: 'forwards' });
  }, [start, end, reduced]);

  return (
    <div class="sb-strip" role="group" aria-label="Today’s session schedule">
      <div class="sb-strip__track">
        {ticks.map((t) => <i key={t} class="sb-strip__grid" style={{ left: pct(share(t, start, end)) }} aria-hidden="true" />)}
        {plan.sessions.map((s) => (
          <Block key={s.idx} s={s} start={start} end={end} />
        ))}
        <span class="sb-strip__now" ref={marker} style={{ transform: `translateX(${pct(at)})` }} aria-hidden="true">
          <i />
        </span>
        {band === null ? null : (
          <span
            class="sb-strip__band"
            style={{ left: pct(share(band.from, start, end)), width: pct(share(band.to, start, end) - share(band.from, start, end)) }}
            aria-hidden="true"
          />
        )}
      </div>
      <div class="sb-strip__axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} class={t === start ? 'is-first' : t === end ? 'is-last' : undefined} style={{ left: pct(share(t, start, end)) }}>
            {hourLabel(t)}
          </span>
        ))}
      </div>
      <div class="sb-strip__legend" aria-hidden="true">
        <span class="is-done">Done</span>
        <span class="is-now">Current</span>
        <span class="is-later">Planned</span>
        {band === null ? null : <span class="is-boost">Boost</span>}
        <span class="is-marker">Now</span>
      </div>
    </div>
  );
}
