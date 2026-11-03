/**
 * Seven plan-days of net followers, today the bright bar (spec §12.2). Hidden until plan-day buckets exist:
 * the caller passes null and nothing is drawn, so no bar ever stands in for a number that is not known.
 */
import type { JSX } from 'preact';
import { count } from '@/renderer/sidebar/format';

const W = 160;
const H = 44;
const BASE = 32;
const BAR = 18;
const PITCH = 23;

export function Spark7({ values, label }: { values: readonly number[] | null; label: string }): JSX.Element | null {
  if (values === null || values.length === 0) return null;
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const week = values.reduce((a, b) => a + b, 0);
  return (
    <div class="sb-spark">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${week >= 0 ? '+' : '−'}${count(Math.abs(week))} over ${label}`}>
        <line class="sb-spark__base" x1="0" x2={W} y1={BASE + 0.5} y2={BASE + 0.5} />
        {values.map((v, i) => {
          const h = Math.max(2, (Math.abs(v) / max) * (v >= 0 ? BASE - 2 : H - BASE - 2));
          const today = i === values.length - 1;
          return (
            <rect key={`${i}:${v}`} class={today ? 'is-today' : v < 0 ? 'is-down' : undefined}
              x={i * PITCH + 2} y={v >= 0 ? BASE - h : BASE + 1} width={BAR} height={h} rx="3" />
          );
        })}
      </svg>
      <span>{label}</span>
    </div>
  );
}
