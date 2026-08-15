/** @jsx h */
import { h } from 'preact';
import type { EpoStatus, Settings } from '@/types';
import { Card, CardHeader, CardBody } from '@/renderer/ui/Card';
import { Badge } from '@/renderer/ui/Badge';
import { KeyValue } from '@/renderer/ui/KeyValue';
import { Meter } from '@/renderer/ui/Meter';
import { useNow } from '@/renderer/hooks/useNow';
import { activeHoursText, dailyRateView, hoursOpen } from '@/renderer/lib/engine-view';

export interface RateSafetyCardProps {
  status: EpoStatus | null;
  settings: Settings | null;
  /** Entrance-stagger index (`--i`); shifts down when the sign-in gate leads. */
  index?: number;
}

/**
 * Rate & Safety — today's operating-rate meter and the active-hours gate.
 */
export function RateSafetyCard({ status, settings, index = 3 }: RateSafetyCardProps): h.JSX.Element {
  const { done, rate, pct: ratePct } = dailyRateView(status, settings);

  // A minute tick keeps Open/Closed truthful across hour boundaries even while
  // the engine is idle (no status pushes to force a re-render).
  const now = useNow(60_000);
  const open = settings !== null && hoursOpen(settings, new Date(now).getHours());

  return (
    <Card index={index}>
      <CardHeader icon="shield-halved">Rate &amp; Safety</CardHeader>
      <CardBody>
        <div class="kv-block">
          <div class="top">
            <span class="k">
              Actions today <span class="dim2">· operating rate</span>
            </span>
            <span class="v num">
              {done} <span class="dim">/ {rate ?? '—'}</span>
            </span>
          </div>
          <Meter pct={ratePct} />
        </div>

        <KeyValue k="Active hours">
          {settings ? activeHoursText(settings) : '—'}
          <Badge tone={open ? 'live' : 'default'}>{open ? 'Open' : 'Closed'}</Badge>
        </KeyValue>
      </CardBody>
    </Card>
  );
}
