/** @jsx h */
import { h } from 'preact';
import { useRef } from 'preact/hooks';

const CTR = 100;
const R = 74;

/** Polar → cartesian: hour 0 at 12-o'clock, clockwise. */
function pos(hour: number, radius: number): [number, number] {
  const a = (hour / 24) * Math.PI * 2 - Math.PI / 2;
  return [CTR + radius * Math.cos(a), CTR + radius * Math.sin(a)];
}

function hh(v: number): string {
  return `${String(v).padStart(2, '0')}:00`;
}

export interface Clock24Props {
  start: number;
  end: number;
  onChange(start: number, end: number): void;
}

/**
 * A 24-hour radial range picker (`.clock`). Two handles set the active window;
 * drag or arrow-key nudge (±1h). Controlled via `start`/`end` (whole hours).
 */
export function Clock24({ start, end, onChange }: Clock24Props): h.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);

  const span = (end - start + 24) % 24;
  const a = pos(start, R);
  const b = pos(end, R);
  const arcD = `M${a[0].toFixed(2)},${a[1].toFixed(2)} A${R},${R} 0 ${span > 12 ? 1 : 0} 1 ${b[0].toFixed(2)},${b[1].toFixed(2)}`;

  const hourFromPointer = (ev: PointerEvent): number => {
    const s = svgRef.current;
    if (!s) return start;
    const r = s.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2);
    const dy = ev.clientY - (r.top + r.height / 2);
    let ang = Math.atan2(dy, dx) + Math.PI / 2;
    if (ang < 0) ang += Math.PI * 2;
    return Math.round((ang / (Math.PI * 2)) * 24) % 24;
  };

  const setHour = (isStart: boolean, raw: number): void => {
    const hour = ((raw % 24) + 24) % 24;
    if (isStart) {
      if (hour === end) return;
      onChange(hour, end);
    } else {
      if (hour === start) return;
      onChange(start, hour);
    }
  };

  const onPointerDown = (e: PointerEvent, isStart: boolean): void => {
    e.preventDefault();
    const handle = e.currentTarget as SVGCircleElement;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent): void => setHour(isStart, hourFromPointer(ev));
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (e: KeyboardEvent, isStart: boolean): void => {
    let d = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -1;
    else return;
    e.preventDefault();
    let nx = (isStart ? start : end) + d;
    // skip over the other handle so they never collide
    if (((nx % 24) + 24) % 24 === (isStart ? end : start)) nx += d;
    setHour(isStart, nx);
  };

  const ticks = [];
  for (let i = 0; i < 24; i++) {
    const major = i % 6 === 0;
    const p1 = pos(i, major ? 81.5 : 83);
    const p2 = pos(i, major ? 89 : 87);
    ticks.push(
      <line
        key={i}
        class={major ? 'ck-tick major' : 'ck-tick'}
        x1={p1[0].toFixed(1)}
        y1={p1[1].toFixed(1)}
        x2={p2[0].toFixed(1)}
        y2={p2[1].toFixed(1)}
      />,
    );
  }
  const labels = [0, 6, 12, 18].map((hLab) => {
    const p = pos(hLab, 95.5);
    return (
      <text key={hLab} class="ck-lab" x={p[0].toFixed(1)} y={(p[1] + 3).toFixed(1)} text-anchor="middle">
        {hLab}
      </text>
    );
  });
  const win = `${hh(start)} – ${hh(end)}`;

  return (
    <div class="clock">
      <svg ref={svgRef} viewBox="0 0 200 200" width="184" height="184" role="group" aria-label="Active hours, 24-hour dial">
        <circle class="ck-track" cx={CTR} cy={CTR} r={R} />
        {ticks}
        {labels}
        <path class="ck-arc" d={arcD} />
        <text class="ck-win" x={CTR} y={97} text-anchor="middle">
          {win}
        </text>
        <text class="ck-cap" x={CTR} y={112} text-anchor="middle">
          ACTIVE WINDOW
        </text>
        <circle
          class="ck-h"
          r="7.5"
          tabIndex={0}
          role="slider"
          aria-label="Active hours start"
          aria-valuemin={0}
          aria-valuemax={23}
          aria-valuenow={start}
          aria-valuetext={hh(start)}
          cx={a[0].toFixed(2)}
          cy={a[1].toFixed(2)}
          onPointerDown={(e) => onPointerDown(e, true)}
          onKeyDown={(e) => onKeyDown(e, true)}
        />
        <circle
          class="ck-h"
          r="7.5"
          tabIndex={0}
          role="slider"
          aria-label="Active hours end"
          aria-valuemin={0}
          aria-valuemax={23}
          aria-valuenow={end}
          aria-valuetext={hh(end)}
          cx={b[0].toFixed(2)}
          cy={b[1].toFixed(2)}
          onPointerDown={(e) => onPointerDown(e, false)}
          onKeyDown={(e) => onKeyDown(e, false)}
        />
      </svg>
    </div>
  );
}
