/**
 * Today (spec §12.2): "Today's plan" with the one Boost control, the session strip, the day's progress per
 * kind and what comes next. No plan yet → one sentence, never a strip of zeros. The summary names every kind
 * the plan counts; it wraps instead of hiding approvals. Boost lives below the schedule, never in its heading.
 */
import type { JSX } from 'preact';

import { useNow } from '@/renderer/app/clock';
import { statusSignal } from '@/renderer/app/shell-context';
import { BoostControl } from '@/renderer/sidebar/BoostControl';
import { NO_PLAN, TODAY_TITLE, todayLines } from '@/renderer/sidebar/copy/zone-copy';
import { plural } from '@/renderer/sidebar/format';
import { PlanStrip } from '@/renderer/sidebar/PlanStrip';

export function TodayPanel(): JSX.Element {
  const status = statusSignal.value;
  const plan = status?.plan ?? null;
  const boost = status?.boost ?? null;
  const now = useNow('minute');
  const lines = plan === null ? null : todayLines(plan, now, true);

  const band = boost !== null && boost.state !== 'off' && boost.startedAt !== null && boost.endsAt !== null
    ? { from: boost.startedAt, to: boost.endsAt } : null;
  return (
    <section class="sb-zone sb-today" data-zone="today" data-tour="today">
      <div class="sb-today__title">
        <h3>{TODAY_TITLE}</h3>
        {plan === null || plan.sessions.length === 0 ? null : (
          <span class="sb-today__sessions">{plural(plan.sessions.length, 'session', 'sessions')}</span>
        )}
      </div>
      {plan === null ? (
        <p class="sb-today__none">{NO_PLAN}</p>
      ) : (
        <>
          {plan.sessions.length === 0 ? null : <PlanStrip plan={plan} band={band} />}
          <div class="sb-today__summary">
            <p class="sb-today__sum num">{lines?.sum}</p>
            {lines?.next ? <p class="sb-today__next">{lines.next}</p> : null}
          </div>
        </>
      )}
      <BoostControl />
    </section>
  );
}
