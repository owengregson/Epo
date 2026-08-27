/** @jsx h */
import { h } from 'preact';
import type { SettingsDraftController } from '@/renderer/hooks/useSettingsDraft';
import { Chips } from '@/renderer/ui/Chips';
import { CollapsibleCard } from '@/renderer/ui/CollapsibleCard';
import { Field } from '@/renderer/ui/Field';
import { Stepper } from '@/renderer/ui/Stepper';
import type { Settings } from '@/types';

export interface AdvancedCardProps {
  draft: Settings;
  set: SettingsDraftController['set'];
  index?: number;
}

const SWEEP_OPTIONS = [1, 2, 4, 6, 12, 24].map((hrs) => ({ value: String(hrs), label: `${hrs}h` }));

/**
 * Advanced — engine internals most users never touch: how often to check for follow-backs,
 * when to refill the candidate queue, and how many times to retry a failed unfollow. (Pace,
 * volume, and lifecycle windows come from the Behavior card's qualitative knobs.)
 */
export function AdvancedCard({ draft: d, set, index }: AdvancedCardProps): h.JSX.Element {
  return (
    <CollapsibleCard icon="sliders" title="Advanced" index={index} defaultCollapsed>
      <Field
        label="Follow-back check"
        tip="How often the engine opens the notifications feed to see who followed back — one click, one request per check. Frequent checks recycle follow slots sooner."
        value={`every ${d.followbackSweepHours} h`}
      >
        <Chips
          options={SWEEP_OPTIONS}
          value={String(d.followbackSweepHours)}
          onChange={(v) => set('followbackSweepHours', Number(v))}
          ariaLabel="Follow-back check interval"
        />
      </Field>

      <Field
        label="Refill below"
        tip="When the ranked candidate queue drops below this count, the engine scrapes and enriches more. Higher keeps a buffer; lower minimizes scraping."
      >
        <Stepper
          min={0}
          max={50}
          step={1}
          value={d.lowWaterCandidates}
          onChange={(v) => set('lowWaterCandidates', v)}
          ariaLabel="Refill low-water candidates"
        />
      </Field>

      <Field
        label="Unfollow retries"
        tip="How many times a failed unfollow is retried before the account is flagged for manual review."
      >
        <Stepper
          min={0}
          max={10}
          step={1}
          value={d.maxRetries}
          onChange={(v) => set('maxRetries', v)}
          ariaLabel="Unfollow retries"
        />
      </Field>
    </CollapsibleCard>
  );
}
