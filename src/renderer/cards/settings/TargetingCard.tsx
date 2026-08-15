/** @jsx h */
import { h, Fragment } from 'preact';
import { useRef } from 'preact/hooks';
import type { Settings } from '@/types';
import { CollapsibleCard } from '@/renderer/ui/CollapsibleCard';
import { Field } from '@/renderer/ui/Field';
import { DualRange } from '@/renderer/ui/DualRange';
import { Stepper } from '@/renderer/ui/Stepper';
import { NumberInput } from '@/renderer/ui/NumberInput';
import { Slider } from '@/renderer/ui/Slider';
import { clamp, commas } from '@/renderer/lib/format';
import type { SettingsDraftController } from '@/renderer/hooks/useSettingsDraft';

export interface TargetingCardProps {
  draft: Settings;
  patch: SettingsDraftController['patch'];
  set: SettingsDraftController['set'];
  index?: number;
}

/** Absolute limits for the hard-bound steppers (mockup range). */
const HARD_MIN = 0.5;
const HARD_MAX = 3.0;
/** Minimum width the hard bounds may be squeezed to. */
const HARD_GAP = 0.1;

/** Snap a ratio value to the 0.05 grid the peak steppers use (mockup snap05). */
const snap05 = (v: number): number => Number((Math.round(v / 0.05) * 0.05).toFixed(4));

/**
 * Targeting — ratio band (dual range with peak plateau overlay), peak/hard-bound
 * steppers, follower range, and the private-account boost.
 */
export function TargetingCard({ draft: d, patch, set, index }: TargetingCardProps): h.JSX.Element {
  // The peak plateau keeps its PROPORTIONAL position inside the band (mockup:
  // peakFracLo/peakFracHi). Anchored once from the draft; band drags re-fit the
  // peak from these fractions, manual stepper edits re-anchor them.
  const frac = useRef({ lo: 1 / 6, hi: 1 / 2 });
  const anchored = useRef(false);
  if (!anchored.current) {
    anchored.current = true;
    if (d.bandHigh > d.bandLow) {
      const w = d.bandHigh - d.bandLow;
      frac.current = { lo: (d.peakLow - d.bandLow) / w, hi: (d.peakHigh - d.bandLow) / w };
    }
  }

  /** Band moved → re-fit the peak at its stored fractions of the new band. */
  const setBand = (lo: number, hi: number): void => {
    const nl = clamp(snap05(lo + frac.current.lo * (hi - lo)), lo, hi);
    const nh = clamp(snap05(lo + frac.current.hi * (hi - lo)), nl, hi);
    patch({ bandLow: lo, bandHigh: hi, peakLow: nl, peakHigh: nh });
  };

  /** Manual peak edit → clamp inside the band, keep order, re-anchor fractions. */
  const setPeak = (a: number, b: number): void => {
    const nl = clamp(Math.min(a, b), d.bandLow, d.bandHigh);
    const nh = clamp(Math.max(a, b), nl, d.bandHigh);
    if (d.bandHigh > d.bandLow) {
      const w = d.bandHigh - d.bandLow;
      frac.current = { lo: (nl - d.bandLow) / w, hi: (nh - d.bandLow) / w };
    }
    patch({ peakLow: nl, peakHigh: nh });
  };

  /** Move a hard bound; keeps ordering and clamps the band back inside. */
  const setHard = (lo: number, hi: number): void => {
    const l = Math.min(lo, hi - HARD_GAP);
    const h2 = Math.max(hi, l + HARD_GAP);
    patch({
      hardLow: l,
      hardHigh: h2,
      bandLow: Math.max(l, Math.min(d.bandLow, h2 - 0.05)),
      bandHigh: Math.min(h2, Math.max(d.bandHigh, l + 0.05)),
    });
  };

  return (
    <CollapsibleCard icon="bullseye" title="Targeting" index={index} defaultCollapsed>
      <Field
        label={
          <Fragment>
            Ratio band <span class="dim2">· follower : following</span>
          </Fragment>
        }
        tip="Only accounts whose follower:following ratio falls inside this band are eligible. Widen it for a bigger candidate pool; tighten it to focus on the follow-back sweet spot."
        value={`${d.bandLow.toFixed(2)} – ${d.bandHigh.toFixed(2)}`}
      >
        <DualRange
          min={d.hardLow}
          max={d.hardHigh}
          step={0.01}
          gap={0.05}
          lo={d.bandLow}
          hi={d.bandHigh}
          peak={{ lo: d.peakLow, hi: d.peakHigh }}
          scaleFmt={(v) => v.toFixed(1)}
          ariaFmt={(v) => v.toFixed(2)}
          ariaLabelLo="Band low"
          ariaLabelHi="Band high"
          onChange={setBand}
        />
        <div class="legend">
          <span class="l-band">
            <i />
            Eligible band
          </span>
          <span class="l-peak">
            <i />
            Peak plateau{' '}
            <span class="num">
              {d.peakLow.toFixed(2)} – {d.peakHigh.toFixed(2)}
            </span>
          </span>
        </div>
      </Field>

      <Field
        label={
          <Fragment>
            Peak plateau <span class="dim2">· full-score zone</span>
          </Fragment>
        }
        tip="The ratio zone that scores full marks — candidates here rank first in the queue. Edit the steppers to reposition it inside the band."
      >
        <div class="pair">
          <div>
            <span class="plab">Low</span>
            <Stepper
              min={d.hardLow}
              max={d.hardHigh}
              step={0.05}
              dec={2}
              value={d.peakLow}
              onChange={(v) => setPeak(v, d.peakHigh)}
              ariaLabel="Peak plateau low"
            />
          </div>
          <div>
            <span class="plab">High</span>
            <Stepper
              min={d.hardLow}
              max={d.hardHigh}
              step={0.05}
              dec={2}
              value={d.peakHigh}
              onChange={(v) => setPeak(d.peakLow, v)}
              ariaLabel="Peak plateau high"
            />
          </div>
        </div>
      </Field>

      <Field
        label={
          <Fragment>
            Hard bounds <span class="dim2">· never target outside</span>
          </Fragment>
        }
        tip="Absolute ratio limits — accounts outside are never targeted, whatever the band says. Widen only if candidates run dry; tighten to be strict about profile shape."
      >
        <div class="pair">
          <div>
            <span class="plab">Low</span>
            <Stepper
              min={HARD_MIN}
              max={HARD_MAX}
              step={0.05}
              dec={2}
              value={d.hardLow}
              onChange={(v) => setHard(v, d.hardHigh)}
              ariaLabel="Hard bound low"
            />
          </div>
          <div>
            <span class="plab">High</span>
            <Stepper
              min={HARD_MIN}
              max={HARD_MAX}
              step={0.05}
              dec={2}
              value={d.hardHigh}
              onChange={(v) => setHard(d.hardLow, v)}
              ariaLabel="Hard bound high"
            />
          </div>
        </div>
      </Field>

      <Field
        label={
          <Fragment>
            Followers <span class="dim2">· candidate range</span>
          </Fragment>
        }
        tip="Candidates must have a follower count inside this range. Smaller accounts follow back far more often; very large ones almost never do."
        value={`${commas(d.minFollowers)} – ${commas(d.maxFollowers)}`}
      >
        <div class="pair">
          <div>
            <span class="plab">Min</span>
            <NumberInput
              value={d.minFollowers}
              onChange={(v) => set('minFollowers', v)}
              ariaLabel="Minimum followers"
            />
          </div>
          <div>
            <span class="plab">Max</span>
            <NumberInput
              value={d.maxFollowers}
              onChange={(v) => set('maxFollowers', v)}
              ariaLabel="Maximum followers"
            />
          </div>
        </div>
      </Field>

      <Field
        label="Private-account boost"
        tip="Score bonus applied to private profiles, which follow back more often. Raise it to favor them in ranking; set 0 to treat everyone equally."
        value={`+${d.privateBoost.toFixed(2)}`}
        hint="Private accounts follow back more often — score bonus at ranking."
      >
        <Slider
          min={0}
          max={0.5}
          step={0.01}
          value={d.privateBoost}
          onInput={(v) => set('privateBoost', v)}
          ariaLabel="Private account boost"
        />
      </Field>

      <Field
        label={
          <Fragment>
            Min follow-back rate <span class="dim2">· chain-hop threshold</span>
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
            Min pool size <span class="dim2">· chain-hop threshold</span>
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
    </CollapsibleCard>
  );
}
