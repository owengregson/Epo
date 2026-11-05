import { Fragment, type JSX } from 'preact';
import { commas, durationCoarse, pctInt } from '@/renderer/lib/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { KeyValue } from '@/renderer/ui/KeyValue';
import { type ChainTargetDetail, CONVERSION_VERDICT_MIN } from '@/types';

export interface ConversionCardProps {
  detail: ChainTargetDetail | null;
}

/**
 * Who follows back. The plain count ("9 of 41 followed back") streams from the
 * graph at once; the RATE and the usual wait are verdicts and wait for enough
 * results (docs/PRINCIPLES.md §1): until {@link CONVERSION_VERDICT_MIN} follows
 * have an outcome, the card says how many it has rather than presenting three
 * follow-backs as a rate.
 */
export function ConversionCard({ detail }: ConversionCardProps): JSX.Element {
  const ready = detail !== null && detail.resolvedOutcomes >= CONVERSION_VERDICT_MIN;

  return (
    <Card>
      <CardHeader icon="arrow-trend-up" aux={detail !== null ? `${commas(detail.resolvedOutcomes)} results` : undefined}>
        Follow-backs
      </CardHeader>
      <CardBody>
        {detail === null ? (
          <div class="hint">Epo isn’t exploring a source yet.</div>
        ) : (
          <Fragment>
            <KeyValue k="Followed back" live={ready}>
              {commas(detail.yield.followedBack)} of {commas(detail.yield.total)}
              {ready ? <span>· {pctInt(detail.yield.followBackRate)}%</span> : null}
            </KeyValue>
            {ready ? (
              <KeyValue k="Usually follows back within">
                {detail.medianFollowbackMs === null ? <span class="dim">—</span> : durationCoarse(detail.medianFollowbackMs)}
              </KeyValue>
            ) : (
              <div class="hint">
                Epo shows a rate once {CONVERSION_VERDICT_MIN} follows have a result (
                <span class="num">{commas(detail.resolvedOutcomes)}</span> so far).
              </div>
            )}
          </Fragment>
        )}
      </CardBody>
    </Card>
  );
}
