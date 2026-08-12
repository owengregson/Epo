/** @jsx h */
import { h, Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Settings } from '@/types';
import type { ToastControls } from '../hooks/useToasts';

export interface SettingsPanelProps {
  settings: Settings | null;
  onSaved: (next: Settings) => void;
  toasts: ToastControls;
}

/** Above this, the daily ceiling is flagged as high-risk; the input is also capped here. */
const HARD_CEILING_MAX = 150;
const HARD_CEILING_WARN = 80;

type FieldKind = 'number' | 'text' | 'bool';

interface FieldDef {
  key: keyof Settings;
  label: string;
  kind: FieldKind;
  step?: number;
  min?: number;
  max?: number;
}

interface Group {
  title: string;
  fields: FieldDef[];
}

const GROUPS: Group[] = [
  {
    title: 'Targeting',
    fields: [
      { key: 'seed', label: 'Seed username', kind: 'text' },
      { key: 'bandLow', label: 'Ratio band low', kind: 'number', step: 0.1, min: 0 },
      { key: 'bandHigh', label: 'Ratio band high', kind: 'number', step: 0.1, min: 0 },
      { key: 'peakLow', label: 'Ratio peak low', kind: 'number', step: 0.1, min: 0 },
      { key: 'peakHigh', label: 'Ratio peak high', kind: 'number', step: 0.1, min: 0 },
      { key: 'hardLow', label: 'Ratio hard low', kind: 'number', step: 0.1, min: 0 },
      { key: 'hardHigh', label: 'Ratio hard high', kind: 'number', step: 0.1, min: 0 },
      { key: 'minFollowers', label: 'Min followers', kind: 'number', step: 10, min: 0 },
      { key: 'maxFollowers', label: 'Max followers', kind: 'number', step: 100, min: 0 },
      { key: 'privateBoost', label: 'Private boost', kind: 'number', step: 0.05, min: 0 },
    ],
  },
  {
    title: 'Lifecycle',
    fields: [
      { key: 'maxWaitForFollowbackDays', label: 'Wait for follow-back (days)', kind: 'number', step: 1, min: 0 },
      { key: 'holdAfterFollowbackDays', label: 'Hold after follow-back (days)', kind: 'number', step: 1, min: 0 },
      { key: 'maxRetries', label: 'Max retries', kind: 'number', step: 1, min: 0 },
    ],
  },
  {
    title: 'Safety',
    fields: [
      { key: 'dailyHardCeiling', label: 'Daily hard ceiling', kind: 'number', step: 1, min: 1, max: HARD_CEILING_MAX },
      { key: 'dailyOperatingRate', label: 'Daily operating rate', kind: 'number', step: 1, min: 0 },
      { key: 'minDelayMinutes', label: 'Min delay (min)', kind: 'number', step: 1, min: 0 },
      { key: 'maxDelayMinutes', label: 'Max delay (min)', kind: 'number', step: 1, min: 0 },
      { key: 'jitterPercent', label: 'Jitter (%)', kind: 'number', step: 1, min: 0, max: 100 },
      { key: 'activeHoursStart', label: 'Active hours start', kind: 'number', step: 1, min: 0, max: 23 },
      { key: 'activeHoursEnd', label: 'Active hours end', kind: 'number', step: 1, min: 1, max: 24 },
      { key: 'requestBudgetMaxPerWindow', label: 'Request budget / window', kind: 'number', step: 10, min: 1 },
      { key: 'requestBudgetWindowMinutes', label: 'Budget window (min)', kind: 'number', step: 5, min: 1 },
    ],
  },
  {
    title: 'Cadence',
    fields: [
      { key: 'followbackSweepHours', label: 'Follow-back sweep (hours)', kind: 'number', step: 1, min: 1 },
      { key: 'dailyPlanSize', label: 'Daily plan size', kind: 'number', step: 1, min: 1 },
      { key: 'lowWaterCandidates', label: 'Low-water candidates', kind: 'number', step: 1, min: 0 },
      { key: 'minFollowBackRate', label: 'Min follow-back rate', kind: 'number', step: 0.05, min: 0, max: 1 },
      { key: 'minPoolSize', label: 'Min pool size', kind: 'number', step: 50, min: 0 },
    ],
  },
];

interface Warning {
  level: 'warn' | 'danger';
  text: string;
}

/** Live guidance from the current draft (§3 — yellow guidance, red near the ceiling). */
function validate(d: Settings): Warning[] {
  const out: Warning[] = [];
  if (d.dailyHardCeiling >= HARD_CEILING_WARN) {
    out.push({
      level: 'danger',
      text: `A daily ceiling of ${d.dailyHardCeiling} is high — Instagram ban risk climbs sharply above ~${HARD_CEILING_WARN}/day.`,
    });
  }
  if (d.dailyOperatingRate > d.dailyHardCeiling) {
    out.push({
      level: 'warn',
      text: 'Operating rate is above the hard ceiling, so it can never be reached. Lower it below the ceiling.',
    });
  }
  if (d.minDelayMinutes > d.maxDelayMinutes) {
    out.push({ level: 'warn', text: 'Min delay is greater than max delay.' });
  }
  if (d.activeHoursStart >= d.activeHoursEnd) {
    out.push({ level: 'warn', text: 'Active hours start is not before active hours end.' });
  }
  if (d.bandLow > d.bandHigh) {
    out.push({ level: 'warn', text: 'Ratio band low is greater than band high.' });
  }
  return out;
}

function settingsEqual(a: Settings, b: Settings): boolean {
  return (Object.keys(a) as Array<keyof Settings>).every((k) => a[k] === b[k]);
}

/**
 * The full knob set (spec §3), grouped and collapsible, with live validation and a
 * save that writes through `settings:update` (persist + live-reload the engine). The
 * hard-ceiling input is capped; the engine enforces the ceiling regardless.
 */
export function SettingsPanel({
  settings,
  onSaved,
  toasts,
}: SettingsPanelProps): h.JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [saving, setSaving] = useState(false);

  // Adopt fresh canonical settings whenever they change and there are no local edits.
  useEffect(() => {
    setDraft((prev) => {
      if (settings === null) return null;
      if (prev === null) return settings;
      return settingsEqual(prev, settings) ? settings : prev;
    });
  }, [settings]);

  const warnings = useMemo(() => (draft ? validate(draft) : []), [draft]);
  const dirty = draft !== null && settings !== null && !settingsEqual(draft, settings);

  function setField(field: FieldDef, raw: string | boolean): void {
    setDraft((prev) => {
      if (prev === null) return prev;
      let value: string | number | boolean;
      if (field.kind === 'number') {
        const n = typeof raw === 'string' ? Number(raw) : Number(raw);
        value = Number.isNaN(n) ? 0 : n;
      } else if (field.kind === 'bool') {
        value = Boolean(raw);
      } else {
        value = String(raw);
      }
      return { ...prev, [field.key]: value };
    });
  }

  async function save(): Promise<void> {
    if (draft === null) return;
    setSaving(true);
    try {
      const next = await window.peanut.updateSettings(draft);
      setDraft(next);
      onSaved(next);
      toasts.push('success', 'Settings saved.');
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toasts.push('error', `Couldn't save settings: ${reason}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section class="panel">
      <button
        class="panel__head panel__head--button"
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen((v) => !v)}
      >
        <span class="panel__title">Settings</span>
        <span class="panel__meta">
          {dirty ? <span class="tag tag--warn">Unsaved</span> : null}
          <span class="caret" data-open={open ? 'true' : 'false'}>
            ›
          </span>
        </span>
      </button>

      {open ? (
        draft === null ? (
          <p class="empty">Loading settings…</p>
        ) : (
          <Fragment>
            {warnings.length > 0 ? (
              <div class="warnings">
                {warnings.map((w, i) => (
                  <div key={i} class="warnings__item" data-level={w.level}>
                    {w.text}
                  </div>
                ))}
              </div>
            ) : null}

            {GROUPS.map((group) => (
              <div key={group.title} class="settings-group">
                <div class="settings-group__title">{group.title}</div>
                <div class="settings-grid">
                  {group.fields.map((field) => (
                    <label key={String(field.key)} class="sf">
                      <span class="sf__label">{field.label}</span>
                      <input
                        class="sf__input"
                        type={field.kind === 'number' ? 'number' : 'text'}
                        step={field.step}
                        min={field.min}
                        max={field.max}
                        value={String(draft[field.key])}
                        onInput={(e) =>
                          setField(field, (e.currentTarget as HTMLInputElement).value)
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}

            <div class="settings-group">
              <div class="settings-group__title">Dry run</div>
              <label class="sf sf--switch">
                <input
                  type="checkbox"
                  checked={draft.dryRun}
                  onInput={(e) =>
                    setField(
                      { key: 'dryRun', label: 'Dry run', kind: 'bool' },
                      (e.currentTarget as HTMLInputElement).checked,
                    )
                  }
                />
                <span class="sf__label">
                  Log actions without touching the account
                </span>
              </label>
            </div>

            <div class="settings-actions">
              <button
                class="btn btn--primary"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save settings'}
              </button>
              <button
                class="btn"
                disabled={!dirty || saving}
                onClick={() => setDraft(settings)}
              >
                Reset
              </button>
            </div>
          </Fragment>
        )
      ) : null}
    </section>
  );
}
