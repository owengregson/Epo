/**
 * Advanced = Easy plus a Fine-tune block under each section, and five
 * Advanced-only sections. Rows follow the ParamView anatomy (spec §6.5):
 * label and help always visible, the recommendation and where it comes from,
 * "Set by you" only when overridden, the safe range and when a change applies.
 */
import { type JSX } from 'preact';
import { PLAN_DETAIL_DAY, PLAN_DETAIL_SESSIONS } from '@/renderer/gallery/direction/fixtures';
import { SectionHead } from '@/renderer/gallery/direction/settings-easy';
import { Icon } from '@/renderer/ui/Icon';

interface ParamRow {
  label: string;
  help: string;
  value: string;
  unit?: string;
  recommended: string;
  range: string;
  applies: string;
  setByYou?: boolean;
  today?: string;
}

function Stepper({ value, unit }: { value: string; unit?: string }): JSX.Element {
  return (
    <span class="dx-stepper">
      <button type="button" aria-label="Less">
        −
      </button>
      <span class="dx-stepper__value num">
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
      <button type="button" aria-label="More">
        +
      </button>
    </span>
  );
}

function Param({ r }: { r: ParamRow }): JSX.Element {
  return (
    <div class={r.setByYou ? 'dx-param is-set' : 'dx-param'}>
      <div class="dx-param__copy">
        <span class="dx-param__label">{r.label}</span>
        <span class="dx-param__help">{r.help}</span>
        <span class="dx-param__rec num">{r.recommended}</span>
      </div>
      <div class="dx-param__control">
        <div class="dx-param__line">
          <Stepper value={r.value} unit={r.unit} />
          {r.today ? <span class="dx-param__today num">Today: {r.today}</span> : null}
          {r.setByYou ? (
            <>
              <span class="dx-tag dx-tag--set">Set by you</span>
              <button type="button" class="dx-link">
                Use recommended
              </button>
            </>
          ) : null}
        </div>
        <span class="dx-param__meta num">
          Safe range {r.range} · {r.applies}
        </span>
      </div>
    </div>
  );
}

/** An intent choice shown as a row of chips at the top of the Fine-tune block. */
function IntentRow({ label, chips, on }: { label: string; chips: readonly string[]; on: number }): JSX.Element {
  return (
    <div class="dx-param dx-param--intent">
      <div class="dx-param__copy">
        <span class="dx-param__label">{label}</span>
      </div>
      <div class="dx-param__control dx-param__chips" role="radiogroup" aria-label={label}>
        {chips.map((c, i) => (
          <button key={c} type="button" role="radio" aria-checked={i === on} class={i === on ? 'dx-chip is-on' : 'dx-chip'}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

const PACE_ROWS: ParamRow[] = [
  {
    label: 'Daily action target',
    help: 'Epo’s days vary below it and never pass about 97% of it on their own.',
    value: '50',
    recommended: 'Recommended 50 · Moderate activity',
    range: '1–100',
    applies: 'Updates today’s remaining plan',
  },
  {
    label: 'Most actions in a day, including your own',
    help: 'The hard stop. It never raises Epo’s automatic day.',
    value: '65',
    recommended: 'Recommended 65 · 1.3 × your daily target',
    range: '50–130',
    applies: 'Applies now',
  },
  {
    label: 'Most actions in an hour',
    help: 'Epo spreads each hour’s actions out and never goes past this.',
    value: '18',
    recommended: 'Recommended 22 · Standard caution',
    range: '1–30',
    applies: 'Applies now',
    setByYou: true,
  },
  {
    label: 'Day-to-day variation',
    help: 'How much one day differs from the next.',
    value: '28',
    unit: '%',
    recommended: 'Recommended 28% · Typical consistency',
    range: '0–45%',
    applies: 'Updates today’s remaining plan',
  },
];

export function GrowthPaceFineTune(): JSX.Element {
  return (
    <div class="dx-fine" aria-label="Fine-tune">
      <div class="dx-fine__head">
        <span>Fine-tune</span>
        <button type="button" class="dx-link">
          Use recommended for this section
        </button>
      </div>
      <IntentRow label="Activity level" chips={['Very light 15', 'Light 30', 'Moderate 50', 'Active 75', 'Maximum 100']} on={2} />
      <IntentRow label="Caution" chips={['Careful ≤ 14/h', 'Standard ≤ 22/h', 'Quicker ≤ 30/h']} on={1} />
      <IntentRow label="Consistency" chips={['Even', 'Typical', 'Varied']} on={1} />
      {PACE_ROWS.map((r) => (
        <Param key={r.label} r={r} />
      ))}
    </div>
  );
}

const TIMING_ROWS: ParamRow[] = [
  {
    label: 'Average pause between actions',
    help: 'Epo’s typical wait between actions at a normal-pace session. You can only make it longer.',
    value: '5 m 4 s',
    recommended: 'Recommended 5 m 4 s · from your hourly limit',
    range: '5 m 4 s – 15 m 12 s',
    applies: 'Updates today’s remaining plan',
    today: '4 m 21 s – 6 m 40 s',
  },
  {
    label: 'Time spent on each profile',
    help: 'How long Epo looks at a profile before it decides. You can only make it longer.',
    value: '×1.0',
    recommended: 'Recommended ×1.0 · the plan’s own pace',
    range: '×1.0–×3.0',
    applies: 'Updates today’s remaining plan',
    today: '6–11 s',
  },
];

export function TimingDetail(): JSX.Element {
  return (
    <section class="dx-sec" aria-label="Timing">
      <SectionHead title="Timing" question="Every wait Epo uses comes from today’s plan. These rows only make it slower." />
      <div class="dx-plan">
        <div class="dx-plan__head">
          <h3>Today’s plan in detail</h3>
          <span class="dx-plan__ro">
            <Icon name="lock" /> Read only
          </span>
        </div>
        <dl class="dx-plan__day">
          {PLAN_DETAIL_DAY.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <table class="dx-plan__table num">
          <thead>
            <tr>
              <th>Session</th>
              <th>Time</th>
              <th>Follows</th>
              <th>Unfollows</th>
              <th>Approvals</th>
              <th>Pace</th>
              <th>Average pause</th>
              <th>Shortest</th>
            </tr>
          </thead>
          <tbody>
            {PLAN_DETAIL_SESSIONS.map((s) => (
              <tr key={s.i} class={`is-${s.state}`}>
                <td>
                  <i class="dx-plan__state" /> {s.i}
                </td>
                <td>{s.time}</td>
                <td>{s.f}</td>
                <td>{s.u}</td>
                <td>{s.a}</td>
                <td>{s.pace}</td>
                <td>{s.avg}</td>
                <td>{s.min}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {TIMING_ROWS.map((r) => (
        <Param key={r.label} r={r} />
      ))}
    </section>
  );
}
