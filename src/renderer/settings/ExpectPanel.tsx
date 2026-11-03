import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import type { Push } from '@/ipc/contract';
import { useNow } from '@/renderer/app/clock';
import type { PlanProjection } from '@/shared/plan-projection';
import type { SettingsView } from '@/shared/settings-view';
import { EXPECT_COPY, STAGE_COPY } from './copy/sections';
import { fill, timeLabel } from './format';
import type { SettingsMode } from './sections';

/** What a hovered or focused choice would make a typical day (from the view's options; no IPC). */
export const expectHint = signal<{ readonly choice: string; readonly perDay: number } | null>(null);

const pct = (t: number, a: number, b: number): number => Math.max(0, Math.min(100, ((t - a) / Math.max(1, b - a)) * 100));

/** Today's sessions as blocks on the plan-day's hours, with the now marker. */
export function PlanStrip({ plan, now }: { plan: PlanProjection; now: number }): JSX.Element {
  const first = plan.sessions[0]?.startAt ?? now;
  const last = plan.sessions[plan.sessions.length - 1]?.endAt ?? now;
  const start = Math.min(first, now);
  const end = Math.max(last, now);
  return (
    <div class="set-strip" aria-hidden="true">
      <div class="set-strip__track">
        {plan.sessions.map((s) => (
          <span
            key={s.idx}
            class={`set-strip__block is-${s.state}`}
            style={`left:${pct(s.startAt, start, end)}%;width:${Math.max(1, pct(s.endAt, start, end) - pct(s.startAt, start, end))}%`}
          />
        ))}
        <span class="set-strip__now" style={`left:${pct(now, start, end)}%`} />
      </div>
      <div class="set-strip__axis">
        <span>{timeLabel(start)}</span>
        <span>{timeLabel(end)}</span>
      </div>
    </div>
  );
}

/** The one-line summary above the content when "What to expect" has no room beside it. */
export function SummaryLine({ status }: { status: Push<'status'> | null }): JSX.Element {
  const plan = status?.basis === 'built' ? (status.plan ?? null) : null;
  if (plan === null) return <p class="set-summary">{STAGE_COPY.summaryNotBuilt}</p>;
  const next = plan.now.nextAt;
  const line = fill(STAGE_COPY.summary, { n: plan.totals.planned, s: plan.sessions.length });
  return (
    <p class="set-summary num">
      {next === null ? line : `${line} · ${fill(STAGE_COPY.summaryNext, { time: timeLabel(next) })}`}
    </p>
  );
}

/** "What to expect": today from the live plan, the week from the view, limits in Advanced. */
export function ExpectPanel({ view, status, mode }: { view: SettingsView; status: Push<'status'> | null; mode: SettingsMode }): JSX.Element {
  const now = useNow('minute');
  const plan = status?.basis === 'built' ? (status.plan ?? null) : null;
  const week = view.capabilities.plan ? view.typical.week : null;
  const top = Math.max(1, view.typical.automaticMax, ...(week ?? []).map((d) => d.total));
  const hint = expectHint.value;
  return (
    <aside class="set-expect" aria-label={EXPECT_COPY.title}>
      <h3>{EXPECT_COPY.title}</h3>
      <div class="set-expect__block">
        <span class="set-expect__k">{EXPECT_COPY.today}</span>
        {plan === null ? (
          <span class="set-expect__v">{EXPECT_COPY.todayNotBuilt}</span>
        ) : (
          <>
            <span class="set-expect__v num">{fill(EXPECT_COPY.todayLine, { n: plan.totals.planned, s: plan.sessions.length })}</span>
            <PlanStrip plan={plan} now={now} />
          </>
        )}
        {hint === null ? null : (
          <span class="set-expect__hint num" aria-live="polite">{fill(EXPECT_COPY.ifPicked, { choice: hint.choice, n: hint.perDay })}</span>
        )}
      </div>
      {view.capabilities.plan ? (
        <div class="set-expect__block">
          <span class="set-expect__k">{EXPECT_COPY.week}</span>
          {week === null ? (
            <span class="set-expect__v">{EXPECT_COPY.weekNotBuilt}</span>
          ) : (
            <div class="set-expect__week">
              {week.map((d, i) => {
                const day = i === 0 ? 'Today' : new Date(d.startAt).toLocaleDateString(undefined, { weekday: 'short' });
                const label = d.dayOff ? fill(EXPECT_COPY.dayOff, { day }) : fill(EXPECT_COPY.dayLine, { day, n: d.total });
                return (
                  <span key={d.dayKey} class={d.dayOff ? 'is-off' : undefined} title={label} aria-label={label}>
                    <i style={`height:${(d.total / top) * 100}%`} />
                    <small>{day}</small>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      {mode === 'advanced' ? (
        <div class="set-expect__block">
          <span class="set-expect__k">{EXPECT_COPY.limits}</span>
          <span class="set-expect__v num">
            {fill(EXPECT_COPY.limitsLine, { h: view.typical.perHourMax, m: view.typical.ceiling })}
          </span>
        </div>
      ) : null}
    </aside>
  );
}
