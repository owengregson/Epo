/** @jsx h */
import { h } from 'preact';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { Field } from '@/renderer/ui/Field';
import { Segmented } from '@/renderer/ui/Segmented';
import {
  AGGRESSIVENESS_ORDER,
  presetHint,
  type Aggressiveness,
} from '@/renderer/lib/strategy-presets';

export interface StrategyCardProps {
  preset: Aggressiveness;
  setPreset(next: Aggressiveness): void;
}

/** Capitalize an aggressiveness value for its segment label. */
function cap(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/**
 * Strategy — the one-tap aggressiveness preset. Picking a preset writes daily
 * activity, delay and jitter together (via the draft hook) and locks those
 * knobs; Custom unlocks them.
 */
export function StrategyCard({ preset, setPreset }: StrategyCardProps): h.JSX.Element {
  return (
    <Card raised index={1}>
      <CardHeader icon="bolt">Strategy</CardHeader>
      <Field
        label="Aggressiveness"
        tip="One-tap pace tuning: daily activity, action delay and jitter move together — and stay locked to the preset. Per-day amounts like the plan derive from activity automatically. Choose Custom to unlock and tune each knob by hand."
      >
        <Segmented
          options={AGGRESSIVENESS_ORDER.map((v) => ({ value: v, label: cap(v) }))}
          value={preset}
          onChange={setPreset}
          ariaLabel="Aggressiveness"
        />
        <div class="hint num">{presetHint(preset)}</div>
      </Field>
    </Card>
  );
}
