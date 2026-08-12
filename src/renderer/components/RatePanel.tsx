/** @jsx h */
import { h, Fragment } from 'preact';
import type { PeanutStatus, Settings } from '@/types';
import { relativeTime } from '../format';

export interface RatePanelProps {
  status: PeanutStatus | null;
  settings: Settings | null;
}

/** A slim horizontal meter. `tone` colors the fill; value is clamped to [0,1]. */
function Meter({
  value,
  tone,
}: {
  value: number;
  tone: 'steel' | 'danger';
}): h.JSX.Element {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div class="meter">
      <div class="meter__fill" data-tone={tone} style={{ width: `${pct}%` }} />
    </div>
  );
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The ban-safety vitals (spec §3): daily operating-rate meter (danger at the hard
 * ceiling), remaining today, request-budget meter, active-hours state, and the next
 * action ETA. Everything binds to real status/settings; nothing alarms unless real.
 */
export function RatePanel({ status, settings }: RatePanelProps): h.JSX.Element {
  const actionsToday = status?.actionsToday ?? 0;
  const remainingToday = status?.remainingToday ?? 0;
  const atCeiling = status?.atHardCeiling ?? false;
  // Operating rate is a settings knob; fall back to the derivable budget when unknown.
  const operatingRate = settings?.dailyOperatingRate ?? actionsToday + remainingToday;
  const rateValue = operatingRate > 0 ? actionsToday / operatingRate : 0;

  const budgetMax = settings?.requestBudgetMaxPerWindow ?? null;
  const budgetRemaining = status?.requestBudgetRemaining ?? 0;
  const budgetValue =
    budgetMax && budgetMax > 0 ? (budgetMax - budgetRemaining) / budgetMax : 0;

  // Active-hours state is derived from the local clock against the configured window.
  let activeHours: { within: boolean; window: string } | null = null;
  if (settings) {
    const hour = new Date().getHours();
    const within =
      hour >= settings.activeHoursStart && hour < settings.activeHoursEnd;
    activeHours = {
      within,
      window: `${pad2(settings.activeHoursStart)}:00–${pad2(settings.activeHoursEnd)}:00`,
    };
  }

  // Next-action ETA: a floor estimate from the last action + the minimum delay.
  let nextAction = 'waiting';
  if (status?.state === 'running' && status.lastActionAt && settings) {
    const eta = status.lastActionAt + settings.minDelayMinutes * 60_000;
    nextAction = eta > Date.now() ? relativeTime(eta) : 'due now';
  }

  return (
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">Rate &amp; safety</span>
        {atCeiling ? <span class="tag tag--danger">Ceiling reached</span> : null}
      </div>

      <div class="vital">
        <div class="vital__row">
          <span class="vital__label">Actions today</span>
          <span class="vital__value num">
            {actionsToday}
            <span class="vital__of"> / {operatingRate}</span>
          </span>
        </div>
        <Meter value={rateValue} tone={atCeiling ? 'danger' : 'steel'} />
        <div class="vital__foot">
          <span class="num">{remainingToday}</span> left at operating rate
          {settings ? (
            <Fragment>
              {' '}
              · hard ceiling <span class="num">{settings.dailyHardCeiling}</span>
            </Fragment>
          ) : null}
        </div>
      </div>

      <div class="vital">
        <div class="vital__row">
          <span class="vital__label">Request budget</span>
          <span class="vital__value num">
            {budgetRemaining}
            {budgetMax ? <span class="vital__of"> / {budgetMax}</span> : null}
          </span>
        </div>
        <Meter value={budgetValue} tone="steel" />
        <div class="vital__foot">requests remaining this window</div>
      </div>

      <div class="statline">
        <div class="statline__item">
          <span class="statline__k">Active hours</span>
          <span class="statline__v">
            {activeHours ? (
              <Fragment>
                <span
                  class="statdot"
                  data-on={activeHours.within ? 'true' : 'false'}
                />
                {activeHours.within ? 'Open' : 'Closed'} · {activeHours.window}
              </Fragment>
            ) : (
              '—'
            )}
          </span>
        </div>
        <div class="statline__item">
          <span class="statline__k">Next action</span>
          <span class="statline__v num">{nextAction}</span>
        </div>
      </div>
    </section>
  );
}
