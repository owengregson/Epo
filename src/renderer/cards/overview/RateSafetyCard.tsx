/** @jsx h */
import { h } from 'preact';
import type { EpoStatus, Settings } from '@/types';
import { Card, CardHeader, CardBody } from '@/renderer/ui/Card';
import { Badge } from '@/renderer/ui/Badge';
import { KeyValue } from '@/renderer/ui/KeyValue';
import { Meter } from '@/renderer/ui/Meter';
import { activeHoursText, hoursOpen } from '@/renderer/lib/engine-view';

export interface RateSafetyCardProps {
  status: EpoStatus | null;
  settings: Settings | null;
}

/**
 * Rate & Safety — today's operating-rate meter and the active-hours gate.
 */
export function RateSafetyCard({ status, settings }: RateSafetyCardProps): h.JSX.Element {
  const done = status?.actionsToday ?? 0;
  const rate = settings?.dailyOperatingRate ?? null;
  const ratePct = rate != null && rate > 0 ? Math.min(100, (done / rate) * 100) : 0;

  const open = settings !== null && hoursOpen(settings, new Date().getHours());

  return (
    <Card index={3}>
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
