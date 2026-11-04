/**
 * The Now zone's ring (spec §12.2, §12.7): one meaning per posture and nothing that loops — full while a
 * step is in flight, depleting toward a known deadline (one animation per deadline, re-armed only when the
 * deadline changes), or a still track with the posture's glyph when idle. Under reduced motion the
 * depleting arc is a static fraction the minute clock refreshes.
 */
import type { JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { useNow } from '@/renderer/app/clock';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import { armDeadline, remainingFraction } from '@/renderer/lib/deadline-anim';
import { Icon } from '@/renderer/ui/Icon';
import type { Countdown } from '@/shared/posture';

/** The ring is drawn on this box and scaled by CSS (88 px, 72 px in the compact column). */
const BOX = 88;
const STROKE = 6;
const R = (BOX - STROKE) / 2;

export interface StatusRingProps {
  readonly busy: boolean;
  readonly countdown: Countdown | null;
  readonly glyph: string;
  readonly brand?: boolean;
}

export function StatusRing({ busy, countdown, glyph, brand }: StatusRingProps): JSX.Element {
  const arc = useRef<SVGCircleElement>(null);
  const reduced = reducedMotionSignal.value;
  const now = useNow('minute', countdown !== null);
  const mode = busy ? 'full' : countdown !== null ? 'deplete' : 'static';
  const left = mode === 'full' ? 1 : countdown === null ? 0 : remainingFraction(countdown, now);

  useLayoutEffect(() => {
    const el = arc.current;
    if (el === null || countdown === null || busy) return;
    const anim = armDeadline(el, countdown, Date.now(), 'dashoffset');
    return () => anim?.cancel();
  }, [countdown?.from, countdown?.to, busy, reduced]);

  return (
    <div class={`sb-ring sb-ring--${mode}`} aria-hidden="true">
      <svg viewBox={`0 0 ${BOX} ${BOX}`}>
        <circle class="sb-ring__track" cx={BOX / 2} cy={BOX / 2} r={R} stroke-width={STROKE} />
        {mode === 'static' ? null : (
          <circle
            ref={arc}
            class="sb-ring__arc"
            cx={BOX / 2}
            cy={BOX / 2}
            r={R}
            stroke-width={STROKE}
            pathLength={1}
            stroke-dasharray="1 1"
            stroke-dashoffset={String(1 - left)}
            transform={`rotate(-90 ${BOX / 2} ${BOX / 2})`}
          />
        )}
      </svg>
      <span class="sb-ring__glyph">
        <Icon name={glyph} brand={brand} />
      </span>
    </div>
  );
}
