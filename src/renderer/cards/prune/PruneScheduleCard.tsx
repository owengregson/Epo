/** @jsx h */
import { Fragment, h } from 'preact';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { Field } from '@/renderer/ui/Field';
import { Stepper } from '@/renderer/ui/Stepper';
import { Toggle } from '@/renderer/ui/Toggle';
import type { Settings } from '@/types';

/** Cadence adopted when the schedule toggle turns on (weekly — a sane default). */
const DEFAULT_SCHEDULE_DAYS = 7;

export interface PruneScheduleCardProps {
  settings: Settings;
  /** Persist a partial settings change (the view saves + relays onSaved). */
  onSave(part: Partial<Settings>): void;
}

/**
 * Prune · Schedule — the recurring-prune cadence (`pruneScheduleDays`, 0 = off)
 * and the scan pacing band (`pruneScanMinSeconds` / `pruneScanMaxSeconds` — the
 * jittered wait between scroll rounds during a scan, the rate-limit brake).
 * Scheduled runs only fire while the app is open and inside active hours; if the
 * growth engine is running when one is due, it is paused for the prune and
 * resumed afterward. (The per-day unfollow cap lives on Prune · Run.)
 */
export function PruneScheduleCard({ settings, onSave }: PruneScheduleCardProps): h.JSX.Element {
  const days = settings.pruneScheduleDays;
  const scheduled = days > 0;

  return (
    <Card index={3}>
      <CardHeader icon="calendar-check">Prune · Schedule</CardHeader>

      {/* Label left, switch right. The .kv row has no side padding of its own —
          the CardBody wrapper supplies it (matching the fields below). */}
      <CardBody>
        <div class="kv">
          <div class="k">
            <div>
              <div data-tip="Re-run the prune on its own every N days. Off means prunes only happen when you press Run.">
                Auto-prune schedule
              </div>
              <div class="hint">
                {scheduled ? `Re-runs every ${days} ${days === 1 ? 'day' : 'days'}` : 'Off — prune only when you press Run'}
              </div>
            </div>
          </div>
          <div class="v">
            <Toggle
              checked={scheduled}
              onChange={(next) => onSave({ pruneScheduleDays: next ? DEFAULT_SCHEDULE_DAYS : 0 })}
              ariaLabel="Auto-prune schedule"
            />
          </div>
        </div>
      </CardBody>

      {scheduled ? (
        <Field
          label={
            <Fragment>
              Cadence <span class="dim2">· every N days</span>
            </Fragment>
          }
          tip="Days between scheduled prune runs. Longer cadences give follow-backs more time to land before an account is judged."
          hint="Scheduled prunes only run while the app is open and inside active hours; a running growth engine is paused for the prune, then resumed."
        >
          <Stepper
            min={1}
            max={30}
            step={1}
            suffix="d"
            value={days}
            onChange={(v) => onSave({ pruneScheduleDays: v })}
            ariaLabel="Days between scheduled prunes"
          />
        </Field>
      ) : null}

      <Field
        label={
          <Fragment>
            Scan pacing <span class="dim2">· min wait</span>
          </Fragment>
        }
        tip="Shortest jittered wait between scroll rounds while scanning. Raising it above the max wait raises the max with it."
      >
        <Stepper
          min={1}
          max={30}
          step={1}
          suffix="s"
          value={settings.pruneScanMinSeconds}
          onChange={(v) =>
            onSave(
              v > settings.pruneScanMaxSeconds
                ? { pruneScanMinSeconds: v, pruneScanMaxSeconds: v }
                : { pruneScanMinSeconds: v },
            )
          }
          ariaLabel="Minimum seconds between scan scroll rounds"
        />
      </Field>

      <Field
        label={
          <Fragment>
            Scan pacing <span class="dim2">· max wait</span>
          </Fragment>
        }
        tip="Longest jittered wait between scroll rounds while scanning. Never drops below the min wait."
        hint="Longer waits scan slower but are safer against rate limits."
      >
        <Stepper
          min={1}
          max={60}
          step={1}
          suffix="s"
          value={settings.pruneScanMaxSeconds}
          onChange={(v) => onSave({ pruneScanMaxSeconds: Math.max(v, settings.pruneScanMinSeconds) })}
          ariaLabel="Maximum seconds between scan scroll rounds"
        />
      </Field>
    </Card>
  );
}
