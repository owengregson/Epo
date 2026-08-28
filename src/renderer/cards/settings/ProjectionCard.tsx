/** @jsx h */
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { computeProjection } from '@/renderer/charts/growth-model';
import { ProjectionChart } from '@/renderer/charts/ProjectionChart';
import { pctInt } from '@/renderer/lib/format';
import { sliderFromYieldMult, yieldMultFromSlider } from '@/renderer/lib/settings-derive';
import { CardBody } from '@/renderer/ui/Card';
import { CollapsibleCard } from '@/renderer/ui/CollapsibleCard';
import { Slider } from '@/renderer/ui/Slider';
import type { Settings } from '@/types';

export interface ProjectionCardProps {
  draft: Settings;
  index?: number;
}

/**
 * Projected Growth — a live three-scenario simulation of the next 30 days under
 * the current draft settings. The audience-yield slider is view-local (it models
 * a hypothesis, not a persisted setting).
 */
export function ProjectionCard({ draft, index }: ProjectionCardProps): h.JSX.Element {
  const [yieldSlider, setYieldSlider] = useState(() => sliderFromYieldMult(1));
  const mult = yieldMultFromSlider(yieldSlider);

  const result = computeProjection({
    rate: draft.dailyOperatingRate,
    yieldMult: mult,
    privateBoost: draft.privateBoost,
    bandWidth: draft.bandHigh - draft.bandLow,
    waitDays: draft.maxWaitForFollowbackDays,
    holdDays: draft.holdAfterFollowbackDays,
    days: 30,
  });

  return (
    <CollapsibleCard
      icon="arrow-trend-up"
      title="Projected growth"
      aux="next 30 days · if sustained"
      index={index}
      defaultCollapsed
    >
      <CardBody>
        <ProjectionChart result={result} />
        <div class="growth-x num">
          <span>day 0</span>
          <span>10</span>
          <span>20</span>
          <span>30</span>
        </div>
        <div class="proj-legend num">
          <span class="pl bad">
            <i />
            Cautious <b>{pctInt(result.scenarios[0].P)}%</b>
          </span>
          <span class="pl avg">
            <i />
            Expected <b>{pctInt(result.scenarios[1].P)}%</b>
          </span>
          <span class="pl good">
            <i />
            Optimistic <b>{pctInt(result.scenarios[2].P)}%</b>
          </span>
          <span class="plc">follow-back</span>
        </div>
        <div class="hint">
          Estimate assumes you sustain this pace and keep chaining fresh targets; real yield varies
          with audience quality.
        </div>
        <div class="hint">Simulates these settings — see Overview for actuals vs plan.</div>
        <div class="proj-yield">
          <div class="ftop">
            <label
              for="yieldSlider"
              data-tip="Models a more or less favorable audience: one multiplier scales all three scenario yields together — cautious, expected and optimistic keep their relative proportions. Center = today's default yields."
            >
              Audience yield
            </label>
            <output class="fv num">×{mult.toFixed(2)}</output>
          </div>
          <Slider
            id="yieldSlider"
            min={0}
            max={100}
            step={1}
            value={yieldSlider}
            onInput={setYieldSlider}
            ariaLabel="Audience yield multiplier"
            tickLabels={['×0.50', '×1.00', '×1.50']}
          />
        </div>
      </CardBody>
    </CollapsibleCard>
  );
}
