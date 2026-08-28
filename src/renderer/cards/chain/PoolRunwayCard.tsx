/** @jsx h */
import { Fragment, h } from 'preact';
import { commas } from '@/renderer/lib/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { KeyValue } from '@/renderer/ui/KeyValue';
import { Meter } from '@/renderer/ui/Meter';
import { Stat } from '@/renderer/ui/Stat';
import { type ChainTargetDetail, RUNWAY_CAP_DAYS } from '@/types';

export interface PoolRunwayCardProps {
  detail: ChainTargetDetail | null;
  /** Entrance-stagger index (`--i`). */
  index?: number;
}

/** Coverage percent, honest at small fractions: "1.5%" under 10%, else "23%". */
function coveragePct(scanned: number, audience: number): string {
  const pct = audience > 0 ? (scanned / audience) * 100 : 0;
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/**
 * Tier 3 of the Targets console — honest audience framing plus runway.
 *
 * The audience size is the target's TRUE follower count, known only once the
 * profile is enriched; until then the card says so ("audience size pending")
 * and the scanned count is never dressed up as the audience. The runway
 * divides the actionable stock (queued records + scoreable candidates — not
 * the raw remaining pool, which score-rejections and the coverage cap make a
 * systematic overestimate) by the realized follow pace, clamped past
 * {@link RUNWAY_CAP_DAYS} rather than reported with false precision.
 */
export function PoolRunwayCard({ detail, index = 1 }: PoolRunwayCardProps): h.JSX.Element {
  const audience = detail?.trueFollowers ?? null;
  const scanned = detail?.scanned ?? 0;

  return (
    <Card index={index}>
      <CardHeader icon="chart-pie">Pool &amp; Runway</CardHeader>
      <CardBody>
        {detail === null ? (
          <div class="hint">No target adopted yet.</div>
        ) : (
          <Fragment>
            <div class="t-stats num">
              <Stat label="Audience" sub={audience === null ? 'pending enrichment' : 'true followers'}>
                {audience === null ? '—' : commas(audience)}
              </Stat>
              <Stat label="Scanned" sub="observed so far">
                {commas(scanned)}
              </Stat>
              <Stat label="Actionable" sub="queued + scoreable">
                {commas(detail.remainingActionable)}
              </Stat>
            </div>
            {/* "Pending" is an enrichment fact (audience === null); an enriched
                zero-follower audience is a different, settled fact. The > 0
                guard only protects the coverage ratio/Meter division. */}
            {audience === null ? (
              <div class="hint">
                <span class="num">{commas(scanned)}</span> scanned · audience size pending — the
                true follower count lands with the target&apos;s profile enrichment.
              </div>
            ) : audience > 0 ? (
              <Fragment>
                <KeyValue k="Pool coverage">
                  {commas(scanned)} of {commas(audience)}
                  <span class="dim">({coveragePct(scanned, audience)})</span>
                </KeyValue>
                <Meter pct={(scanned / audience) * 100} live />
              </Fragment>
            ) : (
              <div class="hint">Enriched: this audience has zero followers — no pool to walk.</div>
            )}
            {detail.runway === null ? (
              <KeyValue k="Runway">
                <span class="dim">forms after the first follows</span>
              </KeyValue>
            ) : detail.remainingActionable === 0 ? (
              <KeyValue k="Runway">
                drained
                <span class="dim">chain advances next</span>
              </KeyValue>
            ) : (
              <KeyValue k="Runway" live>
                {detail.runway.overCap
                  ? `> ${RUNWAY_CAP_DAYS} days`
                  : `≈ ${Math.max(1, Math.ceil(detail.runway.days))} ${Math.ceil(detail.runway.days) <= 1 ? 'day' : 'days'}`}
                <span class="dim">at current pace · until the chain advances</span>
              </KeyValue>
            )}
          </Fragment>
        )}
      </CardBody>
    </Card>
  );
}
