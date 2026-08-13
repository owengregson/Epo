/** @jsx h */
import { h } from 'preact';
import type { Settings } from '@/types';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { Field } from '@/renderer/ui/Field';
import { Slider } from '@/renderer/ui/Slider';
import { Stepper } from '@/renderer/ui/Stepper';
import type { SettingsDraftController } from '@/renderer/hooks/useSettingsDraft';

export interface LifecycleCardProps {
  draft: Settings;
  set: SettingsDraftController['set'];
}

/** "4 days" / "1 day". */
function days(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/**
 * Lifecycle — how long a follow waits for a follow-back, how long it holds
 * afterwards, and how many times a failed unfollow is retried.
 */
export function LifecycleCard({ draft: d, set }: LifecycleCardProps): h.JSX.Element {
  return (
    <Card index={4}>
      <CardHeader icon="arrows-rotate">Lifecycle</CardHeader>

      <Field
        label="Wait for follow-back"
        tip="How long a followed account gets to follow back before it's written off and unfollowed. Longer catches slow responders but bloats the awaiting queue."
        value={days(d.maxWaitForFollowbackDays)}
      >
        <Slider
          min={1}
          max={14}
          step={1}
          value={d.maxWaitForFollowbackDays}
          onInput={(v) => set('maxWaitForFollowbackDays', v)}
          ariaLabel="Days to wait for follow-back"
          ticks={14}
          tickLabels={['1d', '14d']}
        />
      </Field>

      <Field
        label="Hold after follow-back"
        tip="Days to keep following after they follow back, so the unfollow isn't obvious. Longer reads more natural and retains more; shorter recycles slots faster."
        value={days(d.holdAfterFollowbackDays)}
      >
        <Slider
          min={0}
          max={10}
          step={1}
          value={d.holdAfterFollowbackDays}
          onInput={(v) => set('holdAfterFollowbackDays', v)}
          ariaLabel="Days to hold after follow-back"
          ticks={11}
          tickLabels={['0d', '10d']}
        />
      </Field>

      <Field
        label="Unfollow retries"
        tip="How many times a failed unfollow is retried before the account is flagged for manual review. More retries leave fewer stragglers but spend extra requests."
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
    </Card>
  );
}
