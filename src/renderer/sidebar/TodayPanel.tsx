/**
 * Today (spec §12.2): "Today's plan" with the one Boost control, the session strip, the day's progress per
 * kind and what comes next. No plan yet → one sentence, never a strip of zeros. The summary names every kind
 * the plan counts (approvals too, so the parts add up to the plan's total); where the approvals do not fit
 * on the line they move to its tooltip.
 */
import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useNow } from '@/renderer/app/clock';
import { statusSignal } from '@/renderer/app/shell-context';
import { BoostControl } from '@/renderer/sidebar/BoostControl';
import { approvalsNote, NO_PLAN, todayNext, todaySummary } from '@/renderer/sidebar/copy/zone-copy';
import { PlanStrip } from '@/renderer/sidebar/PlanStrip';

export function TodayPanel(): JSX.Element {
  const status = statusSignal.value;
  const plan = status?.plan ?? null;
  const boost = status?.boost ?? null;
  const now = useNow('minute');
  const sum = useRef<HTMLParagraphElement>(null);
  const [fits, setFits] = useState(true);
  const full = plan === null ? '' : todaySummary(plan, true);

  // Measure the full line; when it would be cut, the approvals go to its tooltip instead.
  useLayoutEffect(() => setFits(true), [full]);
  useLayoutEffect(() => {
    const el = sum.current;
    if (fits && el !== null && el.scrollWidth > el.clientWidth) setFits(false);
  }, [full, fits]);

  const band = boost !== null && boost.state !== 'off' && boost.startedAt !== null && boost.endsAt !== null
    ? { from: boost.startedAt, to: boost.endsAt } : null;
  return (
    <section class="sb-zone sb-today" data-zone="today" data-tour="today">
      <BoostControl />
      {plan === null ? (
        <p class="sb-today__none">{NO_PLAN}</p>
      ) : (
        <>
          <PlanStrip plan={plan} band={band} />
          <p class="sb-today__sum num" ref={sum} data-tip={fits ? undefined : (approvalsNote(plan) ?? undefined)}>
            {fits ? full : todaySummary(plan, false)}
          </p>
          <p class="sb-today__next">{todayNext(plan, now)}</p>
        </>
      )}
    </section>
  );
}
