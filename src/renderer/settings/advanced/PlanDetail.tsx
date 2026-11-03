/**
 * "Today's plan in detail" (spec §6.5, Advanced → Timing): read-only, from `status.plan.detail` — the
 * plan-day's window, reset and limits, and per session its time, kind budgets, pace, pauses (average,
 * typical, shortest, longest), pointer pace, scroll depth and reads. Without a built plan it says so and
 * shows no number at all.
 */
import type { JSX } from 'preact';
import type { Push } from '@/ipc/contract';
import { Icon } from '@/renderer/ui/Icon';
import type { PlanProjection } from '@/shared/plan-projection';
import { PLAN_DETAIL_COPY as C } from '../copy/advanced';
import { count, fill, minuteLabel, spanLabel, timeLabel, waitLabel } from '../format';

const MS_PER_S = 1000;
const secs = (ms: number): string => waitLabel(ms / MS_PER_S);
const factor = (x: number): string => x.toFixed(2);

export function builtPlan(status: Push<'status'> | null): PlanProjection | null {
  return status?.basis === 'built' ? (status.plan ?? null) : null;
}

interface Row {
  readonly i: number;
  readonly startAt: number;
  readonly endAt: number;
  readonly state: string;
  readonly pace: string;
  readonly d: PlanProjection['detail']['sessions'][number];
}

function rowsOf(plan: PlanProjection): Row[] {
  return plan.detail.sessions.map((d) => {
    const s = plan.sessions.find((x) => x.idx === d.idx);
    return {
      i: d.idx + 1, startAt: s?.startAt ?? plan.day.startsAt, endAt: s?.endAt ?? plan.day.startsAt,
      state: s?.state ?? 'later', pace: s === undefined ? '' : C.paceWords[s.pace], d,
    };
  });
}

function DayFacts({ plan }: { plan: PlanProjection }): JSX.Element {
  const c = plan.detail.caps;
  const facts: ReadonlyArray<[string, string]> = [
    [C.day, spanLabel(plan.day.startsAt, plan.day.endsAt)],
    [C.resets, minuteLabel(plan.day.quietMinute)],
    [C.automaticMax, String(c.automaticMax)],
    [C.hardStop, String(c.day)],
    [C.hourly, String(c.hour)],
    [C.unfollowHourly, String(c.unfollowHour)],
    [C.probationHourly, String(c.probationHour)],
    [C.accepts, String(c.acceptsPerPass)],
  ];
  return (
    <dl class="set-plan__day num">
      {facts.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Tables({ rows }: { rows: readonly Row[] }): JSX.Element {
  return (
    <div class="set-plan__tables">
      <table class="set-plan__table num">
        <thead>
          <tr>
            {[C.session, C.time, C.follows, C.unfollows, C.approvals, C.pace, C.average, C.shortest].map((h) => <th key={h}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.i} class={`is-${r.state}`}>
              <td><i class="set-plan__state" /> {r.i}</td>
              <td>{spanLabel(r.startAt, r.endAt)}</td>
              <td>{r.d.kinds.follow}</td>
              <td>{r.d.kinds.unfollow}</td>
              <td>{r.d.kinds.accept}</td>
              <td>{r.pace} ×{factor(r.d.pace)}</td>
              <td>{secs(r.d.gap.targetMeanMs)}</td>
              <td>{secs(r.d.gap.floorMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 class="set-plan__sub">{C.tempoTitle}</h4>
      <table class="set-plan__table num">
        <thead>
          <tr>
            {[C.session, C.median, C.longest, C.motion, C.depth, C.profiles, C.pages, C.checks].map((h) => <th key={h}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.i} class={`is-${r.state}`}>
              <td>{r.i}</td>
              <td>{secs(r.d.gap.medianMs)}</td>
              <td>{secs(r.d.gap.capMs)}</td>
              <td>×{factor(r.d.motion)}</td>
              <td>×{factor(r.d.depth)}</td>
              <td>{r.d.reads.profiles}</td>
              <td>{r.d.reads.pages}</td>
              <td>{r.d.reads.checks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Narrow stages: each session as the deck's two sentences, wrapped, nothing hidden. */
function Sentences({ rows }: { rows: readonly Row[] }): JSX.Element {
  return (
    <ol class="set-plan__sessions num">
      {rows.map((r) => (
        <li key={r.i} class={`is-${r.state}`}>
          <span class="set-plan__when">
            <i class="set-plan__state" />{' '}
            {fill(C.sessionLine, {
              i: r.i, start: timeLabel(r.startAt), end: timeLabel(r.endAt), f: count(r.d.kinds.follow, 'follow', 'follows'),
              u: count(r.d.kinds.unfollow, 'unfollow', 'unfollows'), a: count(r.d.kinds.accept, 'approval', 'approvals'),
              pace: r.pace, t: secs(r.d.gap.targetMeanMs), s: secs(r.d.gap.floorMs),
            })}
          </span>
          <span class="set-plan__what">
            {fill(C.tempoLine, {
              m: secs(r.d.gap.medianMs), l: secs(r.d.gap.capMs), mo: factor(r.d.motion), d: factor(r.d.depth),
              p: r.d.reads.profiles, g: r.d.reads.pages, c: r.d.reads.checks,
            })}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function PlanDetail({ status }: { status: Push<'status'> | null }): JSX.Element {
  const plan = builtPlan(status);
  const rows = plan === null ? [] : rowsOf(plan);
  return (
    <div class="set-plan" data-row="plan.detail">
      <div class="set-plan__head">
        <h3>{C.title}</h3>
        <span class="set-plan__ro">
          <Icon name="lock" /> {C.readOnly}
        </span>
      </div>
      {plan === null ? (
        <p class="set-sec__hint">{C.notBuilt}</p>
      ) : (
        <>
          <DayFacts plan={plan} />
          <div class="set-plan__wide">
            <Tables rows={rows} />
          </div>
          <div class="set-plan__narrow">
            <Sentences rows={rows} />
          </div>
        </>
      )}
    </div>
  );
}
