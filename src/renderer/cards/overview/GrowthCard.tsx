/** @jsx h */
import { h } from 'preact';
import type { EpoStatus } from '@/types';
import { Card, CardHeader, CardBody } from '@/renderer/ui/Card';
import { Icon } from '@/renderer/ui/Icon';
import { GrowthChart } from '@/renderer/charts/GrowthChart';
import { useGrowthSeries } from '@/renderer/hooks/useGrowthSeries';

/** How many days of cumulative net growth the card charts. */
const DAYS = 14;

/** "+128" style signed counter. */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

export interface GrowthCardProps {
  status: EpoStatus | null;
}

/**
 * Net Follower Growth — the last {@link DAYS} days of cumulative net growth
 * (gained & retained, minus lost) with a momentum delta: growth in the recent
 * half of the window versus the prior half.
 */
export function GrowthCard({ status }: GrowthCardProps): h.JSX.Element {
  const points = useGrowthSeries(DAYS, status);

  const total = points.length > 0 ? points[points.length - 1].cumulativeNet : 0;

  // Momentum: net gained during the recent half minus net gained during the
  // prior half. Meaningless below two points, so it hides itself.
  const hasDelta = points.length >= 2;
  const mid = Math.floor(points.length / 2);
  const prior = hasDelta ? points[mid].cumulativeNet - points[0].cumulativeNet : 0;
  const recent = hasDelta ? points[points.length - 1].cumulativeNet - points[mid].cumulativeNet : 0;
  const delta = recent - prior;

  return (
    <Card index={1}>
      <CardHeader icon="arrow-trend-up" aux="last 14 days">
        Net Follower Growth
      </CardHeader>
      <CardBody>
        <div class="growth-head">
          <div>
            <div class="g-num num">{signed(total)}</div>
            <div class="g-cap">net · gained &amp; retained, minus lost</div>
          </div>
          {hasDelta ? (
            <div class="g-delta num" title="Compared with the previous 7-day period">
              <Icon name={delta >= 0 ? 'arrow-up' : 'arrow-down'} />
              {signed(delta)} <span class="dim">vs prior 7d</span>
            </div>
          ) : null}
        </div>
        <GrowthChart points={points} />
      </CardBody>
    </Card>
  );
}
