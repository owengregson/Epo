/**
 * The five Advanced-only sections (spec §6.5): Timing (today's plan in detail, then the pause and tempo
 * rows), Finding new people, Limits & reading and Under the hood (read only, from the view and main's
 * catalog), and Diagnostics (the Instagram compatibility panel and the log panel's slot).
 */
import type { JSX } from 'preact';
import { CompatibilityPanel } from '@/renderer/settings/compatibility/CompatibilityPanel';
import type { BasisRow } from '@/shared/settings-view';
import { BasisTable } from '../advanced/BasisTable';
import { paramsOf } from '../advanced/FineTune';
import { ParamRow } from '../advanced/ParamRow';
import { PlanDetail } from '../advanced/PlanDetail';
import { DIAGNOSTICS_COPY, EXPLORE_COPY, LIMITS_COPY, TIMING_COPY } from '../copy/advanced';
import { diagnosticsPanelSlot } from '../diagnostics-slot';
import { Sub } from '../fields/controls';
import { fill } from '../format';
import type { SectionProps } from '../stage-api';

const byPrefix = (prefix: string) => (r: BasisRow): boolean => r.id.startsWith(prefix);
const EXPLORATION = byPrefix('EXPLORATION_POLICY.');
const ENVELOPE = byPrefix('ENVELOPE.');
const POLICY = byPrefix('POLICY.');
const WALLS = (r: BasisRow): boolean => r.group === 'fundamental';

export function TimingSection({ s }: SectionProps): JSX.Element {
  return (
    <>
      <PlanDetail status={s.status} />
      {paramsOf(s, 'timing').filter((p) => !p.key.startsWith('tempo.')).map((p) => <ParamRow key={p.key} p={p} s={s} />)}
      <Sub>{TIMING_COPY.title}</Sub>
      <p id="settings-timing-guidance" class="set-sec__hint">{TIMING_COPY.guidance}</p>
      {paramsOf(s, 'timing').filter((p) => p.key.startsWith('tempo.')).map((p) => (
        <ParamRow key={p.key} p={p} s={s} sharedDescription="settings-timing-guidance" />
      ))}
    </>
  );
}

export function ExploreSection({ s }: SectionProps): JSX.Element {
  return (
    <>
      {paramsOf(s, 'explore').map((p) => <ParamRow key={p.key} p={p} s={s} />)}
      <Sub>{EXPLORE_COPY.policy}</Sub>
      <BasisTable only={EXPLORATION} filter={false} />
    </>
  );
}

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, string | number]> }): JSX.Element {
  return (
    <dl class="set-plan__day num">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LimitsSection({ s }: SectionProps): JSX.Element {
  const r = s.view.reads;
  const t = s.view.typical;
  return (
    <>
      <Sub>{LIMITS_COPY.reads}</Sub>
      <Facts rows={[
        [LIMITS_COPY.profiles, fill(LIMITS_COPY.withExploring, { n: r.profiles, e: r.explorationProfiles })],
        [LIMITS_COPY.listPages, fill(LIMITS_COPY.withExploring, { n: r.listPages, e: r.explorationPages })],
        [LIMITS_COPY.notifications, r.notifications],
      ]} />
      <p class="set-sec__hint">{LIMITS_COPY.backstop}</p>
      <Sub>{LIMITS_COPY.day}</Sub>
      <Facts rows={[
        [LIMITS_COPY.automaticMax, t.automaticMax], [LIMITS_COPY.ceiling, t.ceiling], [LIMITS_COPY.hourly, t.perHourMax],
        [LIMITS_COPY.risk, LIMITS_COPY.risks[t.risk]],
      ]} />
      <Sub>{LIMITS_COPY.walls}</Sub>
      <BasisTable only={WALLS} filter={false} />
      <Sub>{LIMITS_COPY.envelope}</Sub>
      <BasisTable only={ENVELOPE} filter={false} />
      <Sub>{LIMITS_COPY.policy}</Sub>
      <BasisTable only={POLICY} filter={false} />
    </>
  );
}

export function TechnicalSection(_p: SectionProps): JSX.Element {
  return <BasisTable />;
}

export function DiagnosticsSection(_p: SectionProps): JSX.Element {
  const Log = diagnosticsPanelSlot.value;
  return (
    <>
      <CompatibilityPanel />
      <Sub>{DIAGNOSTICS_COPY.log}</Sub>
      {Log === null ? <p class="set-sec__hint">{DIAGNOSTICS_COPY.logPending}</p> : <Log />}
    </>
  );
}
