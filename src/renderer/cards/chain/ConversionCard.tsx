/** @jsx h */
import { Fragment, h } from 'preact';
import { commas, durationCoarse, pctInt } from '@/renderer/lib/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { KeyValue } from '@/renderer/ui/KeyValue';
import { type ChainTargetDetail, CONVERSION_VERDICT_MIN } from '@/types';

export interface ConversionCardProps {
  detail: ChainTargetDetail | null;
  /** Entrance-stagger index (`--i`). */
  index?: number;
}

/**
 * Tier 4 of the Targets console — the progressive conversion readout. The raw
 * n-of-m tally ("9 of 41 followed back") streams from the graph immediately;
 * the PERCENTAGE and the median time-to-follow-back are VERDICTS and wait for
 * a sample (docs/PRINCIPLES.md §1): both appear only once
 * {@link CONVERSION_VERDICT_MIN} follow outcomes have resolved — before that
 * the card says the verdict is still forming rather than presenting three
 * follow-backs as a rate.
 */
export function ConversionCard({ detail, index = 2 }: ConversionCardProps): h.JSX.Element {
  const verdictReady = detail !== null && detail.resolvedOutcomes >= CONVERSION_VERDICT_MIN;

  return (
    <Card index={index}>
      <CardHeader
        icon="arrow-trend-up"
        aux={detail !== null ? `${commas(detail.resolvedOutcomes)} resolved` : undefined}
      >
        Conversion
      </CardHeader>
      <CardBody>
        {detail === null ? (
          <div class="hint">No target adopted yet.</div>
        ) : (
          <Fragment>
            <KeyValue k="Followed back" live={verdictReady}>
              {commas(detail.yield.followedBack)} of {commas(detail.yield.total)}
              {verdictReady ? (
                <span>· {pctInt(detail.yield.followBackRate)}%</span>
              ) : null}
            </KeyValue>
            {verdictReady ? (
              <KeyValue k="Median time to follow-back">
                {detail.medianFollowbackMs === null ? (
                  <span class="dim">—</span>
                ) : (
                  durationCoarse(detail.medianFollowbackMs)
                )}
              </KeyValue>
            ) : (
              <div class="hint">
                Warming up — the rate and median form as follows resolve (
                <span class="num">{commas(detail.resolvedOutcomes)}</span> of{' '}
                {CONVERSION_VERDICT_MIN} outcomes settled).
              </div>
            )}
          </Fragment>
        )}
      </CardBody>
    </Card>
  );
}
