/** @jsx h */
import { h, Fragment } from 'preact';
import type { Settings } from '@/types';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { Field } from '@/renderer/ui/Field';
import { Slider } from '@/renderer/ui/Slider';
import { DualRange } from '@/renderer/ui/DualRange';
import { Clock24 } from '@/renderer/ui/Clock24';
import { Select } from '@/renderer/ui/Select';
import { ceilFor, planFor } from '@/renderer/lib/settings-derive';
import { activeHoursText } from '@/renderer/lib/engine-view';
import type { SettingsDraftController } from '@/renderer/hooks/useSettingsDraft';

export interface SafetyCardProps {
  draft: Settings;
  /** True while a non-Custom preset locks rate/delay/jitter. */
  locked: boolean;
  setRate: SettingsDraftController['setRate'];
  patch: SettingsDraftController['patch'];
  set: SettingsDraftController['set'];
}

const WINDOW_OPTIONS = [15, 30, 60, 90, 120].map((m) => ({
  value: String(m),
  label: `${m} min`,
}));

/**
 * Safety — the daily-activity master (with auto-derived ceiling + plan), the
 * action-delay band, jitter, the 24-hour active window, and the request budget.
 * Rate/delay/jitter are preset-locked until Custom is chosen.
 */
export function SafetyCard({ draft: d, locked, setRate, patch, set }: SafetyCardProps): h.JSX.Element {
  return (
    <Card index={5}>
      <CardHeader icon="shield-halved">Safety</CardHeader>

      <Field
        label="Daily activity"
        tip="Follows + unfollows per day — the engine paces itself to this rate. It is the single master for per-day volume: the hard ceiling and daily plan below derive from it automatically. Higher grows faster but raises detection risk."
        locked={locked}
        lockable
        value={
          <Fragment>
            {d.dailyOperatingRate} <span class="dim">/ day</span>
          </Fragment>
        }
        hint="High volume sharply raises detection risk."
        hintKind="alarm"
        hintHidden={d.dailyOperatingRate < 80}
      >
        <Slider
          min={5}
          max={150}
          step={1}
          value={d.dailyOperatingRate}
          onInput={setRate}
          disabled={locked}
          ariaLabel="Daily activity"
        />
        <div class="derived num">
          <span
            class="dlab"
            data-tip="Read-only per-day amounts that follow the Daily activity slider: the hard ceiling (rate × 1.3, max 150) absorbs catch-up bursts; the daily plan (rate × 1.1, max 120) is how many candidates are queued into each day's plan."
          >
            Auto-derived
          </span>
          <span class="dchip">
            Hard ceiling <b>{ceilFor(d.dailyOperatingRate)}</b> <span class="dim">/ day</span>
          </span>
          <span class="dchip">
            Daily plan <b>{planFor(d.dailyOperatingRate)}</b>{' '}
            <span class="dim">queued / day</span>
          </span>
        </div>
      </Field>

      <Field
        label="Action delay"
        tip="Minimum and maximum wait between consecutive actions. Wider and slower reads more human; tighter and faster is more efficient but more pattern-like."
        locked={locked}
        lockable
        value={`${d.minDelayMinutes} – ${d.maxDelayMinutes} min`}
      >
        <DualRange
          min={1}
          max={30}
          step={1}
          lo={d.minDelayMinutes}
          hi={d.maxDelayMinutes}
          scaleFmt={(v) => `${Math.round(v)}m`}
          ariaFmt={(v) => String(Math.round(v))}
          ariaLabelLo="Delay minimum"
          ariaLabelHi="Delay maximum"
          disabled={locked}
          onChange={(lo, hi) => patch({ minDelayMinutes: lo, maxDelayMinutes: hi })}
        />
      </Field>

      <Field
        label={
          <Fragment>
            Jitter <span class="dim2">· timing randomness</span>
          </Fragment>
        }
        tip="Randomizes the gap between actions so timing looks human. Higher = safer but slower and less predictable; lower = faster but more pattern-like."
        locked={locked}
        lockable
        value={`±${d.jitterPercent}%`}
      >
        <Slider
          min={0}
          max={100}
          step={5}
          value={d.jitterPercent}
          onInput={(v) => set('jitterPercent', v)}
          disabled={locked}
          ariaLabel="Timing jitter percent"
        />
      </Field>

      <Field
        label="Active hours"
        tip="The engine only acts inside this daily window. Match your real waking hours — activity at 4 a.m. every night is an easy tell."
        value={activeHoursText(d)}
      >
        <Clock24
          start={d.activeHoursStart}
          end={d.activeHoursEnd}
          onChange={(s, e) => patch({ activeHoursStart: s, activeHoursEnd: e })}
        />
        <div class="hint center">Drag a handle · arrow keys nudge ±1 h</div>
      </Field>

      <Field
        label={
          <Fragment>
            Request budget <span class="dim2">· per window</span>
          </Fragment>
        }
        tip="Cap on Instagram requests — scrapes plus actions — per window. Lower is stealthier but enriches candidates slower; higher fills the queue faster."
        value={
          <Fragment>
            {d.requestBudgetMaxPerWindow}{' '}
            <span class="dim">/ {d.requestBudgetWindowMinutes} min</span>
          </Fragment>
        }
      >
        <Slider
          min={50}
          max={500}
          step={10}
          value={d.requestBudgetMaxPerWindow}
          onInput={(v) => set('requestBudgetMaxPerWindow', v)}
          ariaLabel="Request budget per window"
        />
      </Field>

      <Field
        label="Budget window"
        htmlFor="windowSel"
        tip="The period the request budget applies to. Shorter windows smooth traffic into small, steady bursts; longer windows permit bigger spikes."
      >
        <Select
          id="windowSel"
          options={WINDOW_OPTIONS}
          value={String(d.requestBudgetWindowMinutes)}
          onChange={(v) => set('requestBudgetWindowMinutes', Number(v))}
          ariaLabel="Budget window"
        />
      </Field>
    </Card>
  );
}
