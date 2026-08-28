/** @jsx h */
import { h } from 'preact';
import type { SettingsDraftController } from '@/renderer/hooks/useSettingsDraft';
import { activeHoursText } from '@/renderer/lib/engine-view';
import { CollapsibleCard } from '@/renderer/ui/CollapsibleCard';
import { Field } from '@/renderer/ui/Field';
import { Segmented } from '@/renderer/ui/Segmented';
import { Toggle } from '@/renderer/ui/Toggle';
import {
  type PatternSettings,
  type PersonaId,
  patternCircadianProfile,
  personaPattern,
  resolvePattern,
} from '@/settings/pattern-map';
import { intensityAt } from '@/timing/circadian';
import type { Settings } from '@/types';

export interface BehaviorCardProps {
  draft: Settings;
  patch: SettingsDraftController['patch'];
  set: SettingsDraftController['set'];
  index?: number;
}

const PERSONA_OPTIONS: ReadonlyArray<{ value: PersonaId; label: string }> = [
  { value: 'casual', label: 'Casual' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'grower', label: 'Grower' },
  { value: 'nineToFive', label: '9–5' },
  { value: 'nightOwl', label: 'Night owl' },
  { value: 'custom', label: 'Custom' },
];

// --- Pacing model (which timing engine actually runs) -------------------------------

/** User-facing labels for the two pacing models (internal values stay 'organic'/'legacy'). */
export const PACING_OPTIONS: ReadonlyArray<{ value: Settings['pacingModel']; label: string }> = [
  { value: 'organic', label: 'Adaptive sessions' },
  { value: 'legacy', label: 'Steady intervals' },
];

/** One-line description of what the selected model actually does. */
export function pacingModelHint(model: Settings['pacingModel']): string {
  return model === 'organic'
    ? 'Session-based pacing that varies day to day (recommended).'
    : 'Evenly paced actions inside active hours — the session knobs below are inactive.';
}

/**
 * The knobs ONLY the adaptive-sessions model consults. Traced to their consumers:
 * caution → hourlyVelocityCap + gapFloorSeconds (engine organic branch / SessionPlanner);
 * cleanup → weaveEnabled + maxUnfollowFractionPerSession (woven-prune path, organic-gated
 * in engine.selectPruneCandidate and the foundation's scheduled-prune launcher);
 * dayShape/weeklyShape → the circadian profile (SessionPlanner construction);
 * rhythm → sessionsPerDay + gapMedianSeconds (SessionPlanner);
 * consistency → dailyVolumeVariancePct + restDayChancePct (SessionPlanner day draw).
 * Live under BOTH models (never gated): activityLevel → dailyOperatingRate/-HardCeiling/
 * dailyPlanSize (rate governor + scanner); patience → follow-back wait/hold windows
 * (churn scheduler + follow-back watcher).
 */
export const ADAPTIVE_ONLY_KNOBS: ReadonlySet<keyof PatternSettings> = new Set([
  'caution',
  'cleanup',
  'dayShape',
  'weeklyShape',
  'rhythm',
  'consistency',
]);

/** The plain note shown on a gated knob while steady intervals are selected. */
export const ADAPTIVE_ONLY_NOTE = 'Requires adaptive sessions';

const opt = (...vs: Array<[string, string]>): ReadonlyArray<{ value: string; label: string }> =>
  vs.map(([value, label]) => ({ value, label }));

interface Knob {
  key: keyof PatternSettings;
  label: string;
  tip: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

// The three choices most people actually care about — kept up front.
const PRIMARY: readonly Knob[] = [
  {
    key: 'activityLevel',
    label: 'Activity level',
    tip: 'Roughly how many follows to plan per day. Unfollowing and follow-back checks are woven in on top; the exact daily number varies naturally around this.',
    options: opt(
      ['minimal', 'Minimal'],
      ['light', 'Light'],
      ['moderate', 'Moderate'],
      ['active', 'Active'],
      ['aggressive', 'Aggressive'],
    ),
  },
  {
    key: 'caution',
    label: 'Caution',
    tip: 'How close to the safe speed limits to run. Bolder is faster (closer to the hourly ceiling); cautious leaves more headroom.',
    options: opt(['cautious', 'Cautious'], ['standard', 'Standard'], ['bold', 'Bold']),
  },
  {
    key: 'cleanup',
    label: 'Cleanup',
    tip: 'How aggressively to unfollow accounts that never followed back — woven into the normal stream, never in a bulk burst.',
    options: opt(['off', 'Off'], ['trickle', 'Trickle'], ['steady', 'Steady'], ['deep', 'Deep']),
  },
];

// The finer character of the schedule — sensible under a persona, tunable on demand.
const ADVANCED: readonly Knob[] = [
  {
    key: 'dayShape',
    label: 'Time of day',
    tip: 'When you tend to be active — the daily rhythm the sessions follow.',
    options: opt(
      ['morning', 'Morning'],
      ['balanced', 'Balanced'],
      ['evening', 'Evening'],
      ['nightowl', 'Night owl'],
      ['business', 'Business hrs'],
    ),
  },
  {
    key: 'weeklyShape',
    label: 'Week shape',
    tip: 'How the week is weighted — even, weekday-heavy, weekend-heavy, or a natural mix.',
    options: opt(
      ['uniform', 'Even'],
      ['weekdays', 'Weekdays'],
      ['weekends', 'Weekends'],
      ['realistic', 'Realistic'],
    ),
  },
  {
    key: 'rhythm',
    label: 'Rhythm',
    tip: 'How activity clusters: a steady trickle of small sessions, natural sessions, or a few intense bursts.',
    options: opt(['trickle', 'Trickle'], ['sessions', 'Sessions'], ['bursts', 'Bursts']),
  },
  {
    key: 'consistency',
    label: 'Consistency',
    tip: 'How much the daily amount varies day to day, and how often a quiet "rest day" happens.',
    options: opt(['clockwork', 'Clockwork'], ['natural', 'Natural'], ['erratic', 'Erratic']),
  },
  {
    key: 'patience',
    label: 'Patience',
    tip: 'How long to wait for a follow-back before moving on and unfollowing.',
    options: opt(['quick', 'Quick'], ['normal', 'Normal'], ['patient', 'Patient']),
  },
];

/** 24 hourly intensity samples (a reference Monday) for the day-shape preview. */
function dayIntensities(pattern: PatternSettings): number[] {
  const profile = patternCircadianProfile(pattern, 0);
  return Array.from({ length: 24 }, (_, hour) =>
    intensityAt(new Date(2026, 0, 5, hour, 30).getTime(), profile),
  );
}

/**
 * Behavior — the PRIMARY, qualitative settings surface (§5.6). The pacing model comes
 * first (it decides which knobs below actually run): adaptive sessions is the default;
 * steady intervals stays selectable, and every knob only the adaptive model consults is
 * then disabled with a plain note rather than silently ignored. A persona sets the whole
 * character in one tap; the headline knobs cover what most people tune; the finer schedule
 * character lives under "Advanced". The preview shows the day shape the adaptive model
 * will follow — or the flat pace when steady intervals are selected. Two operational
 * toggles (auto-accept requests, dry run) sit at the bottom.
 */
export function BehaviorCard({ draft, patch, set, index }: BehaviorCardProps): h.JSX.Element {
  const pattern = draft.pattern;
  const r = resolvePattern(pattern);
  const adaptive = draft.pacingModel === 'organic';

  const applyPattern = (next: PatternSettings, persona: PersonaId): void => {
    patch({ persona, pattern: next, ...resolvePattern(next) });
  };
  const onPersona = (id: PersonaId): void => {
    if (id === 'custom') patch({ persona: 'custom' });
    else applyPattern(personaPattern(id), id);
  };
  const onKnob = (key: keyof PatternSettings, value: string): void => {
    applyPattern({ ...pattern, [key]: value } as PatternSettings, 'custom');
  };

  const renderKnob = (k: Knob): h.JSX.Element => {
    const gated = !adaptive && ADAPTIVE_ONLY_KNOBS.has(k.key);
    return (
      <Field key={k.key} label={k.label} tip={k.tip} hint={gated ? ADAPTIVE_ONLY_NOTE : undefined}>
        <Segmented
          options={k.options}
          value={pattern[k.key]}
          onChange={(v: string) => onKnob(k.key, v)}
          ariaLabel={k.label}
          disabled={gated}
        />
      </Field>
    );
  };

  const intensities = dayIntensities(pattern);
  const restNote = r.restDayChancePct > 0 ? ` · ~${r.restDayChancePct}% rest days` : '';

  return (
    <CollapsibleCard icon="wand-magic-sparkles" title="Behavior" index={index} defaultCollapsed>
      <Field
        label="Pacing"
        tip="How the engine times its actions. Adaptive sessions spreads a varying daily plan across natural sessions shaped by the knobs below; Steady intervals spaces actions evenly inside active hours. A model change takes effect the next time Epo starts."
        hint={pacingModelHint(draft.pacingModel)}
      >
        <Segmented
          options={PACING_OPTIONS}
          value={draft.pacingModel}
          onChange={(v) => set('pacingModel', v)}
          ariaLabel="Pacing model"
        />
      </Field>

      <Field
        label="Persona"
        tip="A one-tap behavior profile. Pick one, or tune the knobs below (which switches to Custom)."
      >
        <Segmented options={PERSONA_OPTIONS} value={draft.persona} onChange={onPersona} ariaLabel="Persona" />
      </Field>

      <Field
        label={PRIMARY[0].label}
        tip={PRIMARY[0].tip}
        value={`~${r.dailyOperatingRate}/day`}
      >
        <Segmented
          options={PRIMARY[0].options}
          value={pattern.activityLevel}
          onChange={(v: string) => onKnob('activityLevel', v)}
          ariaLabel={PRIMARY[0].label}
        />
      </Field>
      {renderKnob(PRIMARY[1])}
      {renderKnob(PRIMARY[2])}

      {adaptive ? (
        <Field label="Preview" tip="The daily activity shape and the pace these choices produce.">
          <div class="pattern-preview" aria-hidden="true">
            {intensities.map((v, hour) => (
              <span
                key={hour}
                class="pattern-preview__bar"
                style={{ height: `${Math.max(4, Math.round(v * 100))}%` }}
                title={`${hour}:00`}
              />
            ))}
          </div>
          <div class="hint num">
            {`~${r.dailyOperatingRate} follows/day · ${r.sessionsPerDayMin}–${r.sessionsPerDayMax} sessions · ~${Math.round(
              r.gapMedianSeconds / 60,
            )} min between actions${restNote} · cleanup ${r.weaveEnabled ? pattern.cleanup : 'off'}`}
          </div>
        </Field>
      ) : (
        <Field label="Preview" tip="The flat pace steady intervals will run.">
          <div class="hint num">
            {`~${r.dailyOperatingRate} follows/day · steady ${draft.minDelayMinutes}–${draft.maxDelayMinutes} min intervals · active ${activeHoursText(draft)}`}
          </div>
        </Field>
      )}

      <details class="pattern-advanced">
        <summary>Advanced — schedule character</summary>
        {ADVANCED.map(renderKnob)}
      </details>

      <div class="field-toggle">
        <div class="kv">
          <div class="k">
            <div>
              <div data-tip="On a PRIVATE account, follow-backs arrive as follow requests. Each follow-back check accepts them (bounded, paced) so requesters count as reciprocation. No effect on public accounts.">
                Auto-accept follow requests
              </div>
              <div class="hint">Accept incoming requests during each follow-back check</div>
            </div>
          </div>
          <div class="v">
            <Toggle
              checked={draft.autoAcceptFollowRequests}
              onChange={(v) => set('autoAcceptFollowRequests', v)}
              ariaLabel="Auto-accept follow requests"
            />
          </div>
        </div>
      </div>

      <div class="field-toggle">
        <div class="kv">
          <div class="k">
            <div>
              <div data-tip="Simulates every decision — targeting, timing, queueing — and logs it, without sending anything to Instagram. Perfect for tuning settings risk-free.">
                Dry run
              </div>
              <div class="hint">Simulate every action — nothing is sent to Instagram</div>
            </div>
          </div>
          <div class="v">
            <Toggle checked={draft.dryRun} onChange={(v) => set('dryRun', v)} ariaLabel="Dry run" />
          </div>
        </div>
      </div>
    </CollapsibleCard>
  );
}
