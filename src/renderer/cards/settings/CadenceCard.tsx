/** @jsx h */
import { h, Fragment } from 'preact';
import type { Settings } from '@/types';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { Field } from '@/renderer/ui/Field';
import { Chips } from '@/renderer/ui/Chips';
import { Stepper } from '@/renderer/ui/Stepper';
import { Slider } from '@/renderer/ui/Slider';
import { commas } from '@/renderer/lib/format';
import type { SettingsDraftController } from '@/renderer/hooks/useSettingsDraft';

export interface CadenceCardProps {
  draft: Settings;
  set: SettingsDraftController['set'];
}

const SWEEP_OPTIONS = [2, 4, 6, 12, 24].map((hrs) => ({
  value: String(hrs),
  label: `${hrs}h`,
}));

/**
 * Cadence — the follow-back sweep interval, queue refill low-water mark, and
 * the chain-hop thresholds (min follow-back rate + min pool size).
 */
export function CadenceCard({ draft: d, set }: CadenceCardProps): h.JSX.Element {
  return (
    <Card index={6}>
      <CardHeader icon="calendar-days">Cadence</CardHeader>

      <Field
        label="Follow-back sweep"
        tip="How often the engine re-checks who followed back. Frequent sweeps recycle follow slots sooner but spend request budget on checking."
        value={`every ${d.followbackSweepHours} h`}
      >
        <Chips
          options={SWEEP_OPTIONS}
          value={String(d.followbackSweepHours)}
          onChange={(v) => set('followbackSweepHours', Number(v))}
          ariaLabel="Follow-back sweep"
        />
      </Field>

      <Field
        label={
          <Fragment>
            Low-water candidates <span class="dim2">· refill below</span>
          </Fragment>
        }
        tip="When the ranked queue drops below this count, the engine scrapes and enriches more candidates. Higher keeps a comfortable buffer; lower minimizes scraping."
      >
        <Stepper
          min={0}
          max={50}
          step={1}
          value={d.lowWaterCandidates}
          onChange={(v) => set('lowWaterCandidates', v)}
          ariaLabel="Low-water candidates"
        />
      </Field>

      <Field
        label={
          <Fragment>
            Min follow-back rate <span class="dim2">· hop threshold</span>
          </Fragment>
        }
        tip="A chain target must convert at least this fraction of follows into follow-backs. Below it, the chain hops onward. Raise for quality; lower to keep chains alive longer."
        value={d.minFollowBackRate.toFixed(2)}
      >
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={d.minFollowBackRate}
          onInput={(v) => set('minFollowBackRate', v)}
          ariaLabel="Minimum follow-back rate"
        />
      </Field>

      <Field
        label={
          <Fragment>
            Min pool size <span class="dim2">· hop threshold</span>
          </Fragment>
        }
        tip="Minimum follower pool a chain target needs to be worth mining. Small pools exhaust quickly and force frequent, riskier hops."
        value={commas(d.minPoolSize)}
        hint="Targets below either threshold are skipped and the chain hops forward."
      >
        <Slider
          min={0}
          max={5000}
          step={50}
          value={d.minPoolSize}
          onInput={(v) => set('minPoolSize', v)}
          ariaLabel="Minimum pool size"
        />
      </Field>
    </Card>
  );
}
