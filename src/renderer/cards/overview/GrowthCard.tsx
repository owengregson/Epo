/** @jsx h */
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { GrowthChart } from '@/renderer/charts/GrowthChart';
import { computeGrowthOverlay, type GrowthOverlay } from '@/renderer/charts/growth-overlay';
import {
  computeMomentum,
  DEFAULT_GROWTH_WINDOW,
  GROWTH_WINDOWS,
  type GrowthWindowKey,
  hasMeasuredSignal,
  overlayHorizonDays,
} from '@/renderer/charts/growth-window';
import { useChainList } from '@/renderer/hooks/useChainList';
import { useGrowthSeries } from '@/renderer/hooks/useGrowthSeries';
import { pctInt } from '@/renderer/lib/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { Icon } from '@/renderer/ui/Icon';
import { NumberTicker } from '@/renderer/ui/NumberTicker';
import { Segmented } from '@/renderer/ui/Segmented';
import { CONVERSION_VERDICT_MIN, type EpoStatus, type Settings } from '@/types';

/** "+128" style signed counter. */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

export interface GrowthCardProps {
  status: EpoStatus | null;
  /** Persisted settings — the projection overlay's model inputs. */
  settings: Settings | null;
  /** Entrance-stagger index (`--i`); shifts down when the sign-in gate leads. */
  index?: number;
}

/**
 * Net Follower Growth — realized cumulative net growth (gained & retained,
 * minus lost) over a selectable window (14d / 30d / 90d / All-since-
 * measurement), continued past today by the projection band re-anchored at the
 * realized endpoint. The momentum delta (recent half vs prior half) only reads
 * once measurement genuinely covers the compared windows — before that it
 * shows a quiet collecting state, never a fabricated "+0".
 */
export function GrowthCard({ status, settings, index = 1 }: GrowthCardProps): h.JSX.Element {
  const [win, setWin] = useState<GrowthWindowKey>(DEFAULT_GROWTH_WINDOW);
  const { points, baselineAt, forWindow } = useGrowthSeries(win, status);
  const chain = useChainList(status);

  const total = points.length > 0 ? points[points.length - 1].cumulativeNet : 0;
  const momentum = computeMomentum(points, baselineAt);
  const hasData = points.length >= 2 && hasMeasuredSignal(points);

  // Aggregate realized follow-back sample across every chain target — the
  // overlay centers its expected path on this measured rate once the sample
  // clears the shared conversion-verdict gate (§1: the verdict waits).
  const sampleTotal = chain.reduce((a, t) => a + t.yield.total, 0);
  const sampleBack = chain.reduce((a, t) => a + t.yield.followedBack, 0);
  const sample = sampleTotal > 0 ? { followedBack: sampleBack, total: sampleTotal } : null;

  const overlay: GrowthOverlay | null =
    settings !== null && hasData
      ? computeGrowthOverlay({
          rate: settings.dailyOperatingRate,
          privateBoost: settings.privateBoost,
          bandWidth: settings.bandHigh - settings.bandLow,
          waitDays: settings.maxWaitForFollowbackDays,
          holdDays: settings.holdAfterFollowbackDays,
          horizonDays: overlayHorizonDays(points.length),
          realizedEnd: total,
          sample,
        })
      : null;

  return (
    <Card index={index}>
      <CardHeader
        icon="arrow-trend-up"
        controls={
          <Segmented
            options={GROWTH_WINDOWS}
            value={win}
            onChange={(v) => setWin(v)}
            ariaLabel="Growth history window"
          />
        }
      >
        Net Follower Growth
      </CardHeader>
      <CardBody>
        <div class="growth-head">
          <div>
            <div class="g-num num">
              <NumberTicker value={total} signed />
            </div>
            <div class="g-cap">net · gained &amp; retained, minus lost</div>
          </div>
          {momentum.ready ? (
            <div
              class="g-delta num"
              title={`Compared with the previous ${momentum.halfDays}-day period`}
            >
              <Icon name={momentum.delta >= 0 ? 'arrow-up' : 'arrow-down'} />
              {signed(momentum.delta)} <span class="dim">vs prior {momentum.halfDays}d</span>
            </div>
          ) : (
            <div
              class="g-delta quiet num"
              title="Momentum reads once measurement covers the full window and recorded activity exists"
            >
              <Icon name="hourglass-half" />
              collecting data
            </div>
          )}
        </div>
        <GrowthChart points={points} overlay={overlay} revealKey={forWindow} baselineAt={baselineAt} />
        {overlay !== null ? (
          <div class="growth-proj-note">
            {overlay.measuredYield
              ? `Band projects the next ${overlay.horizonDays} days at your measured ${pctInt(overlay.expectedP)}% follow-back.`
              : `Band projects the next ${overlay.horizonDays} days at settings-expected yield — the measured rate takes over after ${CONVERSION_VERDICT_MIN} follow outcomes.`}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
