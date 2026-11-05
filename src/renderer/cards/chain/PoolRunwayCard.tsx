import { Fragment, type JSX } from 'preact';
import { commas } from '@/renderer/lib/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { KeyValue } from '@/renderer/ui/KeyValue';
import { Meter } from '@/renderer/ui/Meter';
import { Stat } from '@/renderer/ui/Stat';
import { type ChainTargetDetail, RUNWAY_CAP_DAYS } from '@/types';

export interface PoolRunwayCardProps {
  detail: ChainTargetDetail | null;
}

/** Share of the account's followers found so far, honest at small fractions: "1.5%" under 10%, else "23%". */
function coveragePct(found: number, followers: number): string {
  const pct = followers > 0 ? (found / followers) * 100 : 0;
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/** "Enough people for about N days", clamped past the cap rather than falsely precise. */
export function runwayText(runway: { days: number; overCap: boolean }): string {
  if (runway.overCap) return `Enough people for more than ${RUNWAY_CAP_DAYS} days`;
  const days = Math.max(1, Math.ceil(runway.days));
  return `Enough people for about ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * How many people this source has, and how long they last. The source's real
 * follower count is known only once Epo has read its profile; until then the
 * card says so and never presents the people found as the whole audience. The
 * days left divide the people Epo can still follow (not the raw remainder,
 * which poor fits and the coverage cap make an overestimate) by the recent
 * follow pace.
 */
export function PoolRunwayCard({ detail }: PoolRunwayCardProps): JSX.Element {
  const followers = detail?.trueFollowers ?? null;
  const found = detail?.scanned ?? 0;

  return (
    <Card>
      <CardHeader icon="chart-pie">How many are left</CardHeader>
      <CardBody>
        {detail === null ? (
          <div class="hint">Epo isn’t exploring a source yet.</div>
        ) : (
          <Fragment>
            <div class="t-stats num">
              <Stat label="Followers" sub={followers === null ? 'not read yet' : 'on its profile'}>
                {followers === null ? '—' : commas(followers)}
              </Stat>
              <Stat label="People found" sub="so far">
                {commas(found)}
              </Stat>
              <Stat label="Good fits left" sub="Epo can still follow">
                {commas(detail.remainingActionable)}
              </Stat>
            </div>
            {followers === null ? (
              <div class="hint">
                <span class="num">{commas(found)}</span> found so far · the follower count appears once Epo
                reads this account’s profile.
              </div>
            ) : followers > 0 ? (
              <Fragment>
                <KeyValue k="Found so far">
                  {commas(found)} of {commas(followers)}
                  <span class="dim">({coveragePct(found, followers)})</span>
                </KeyValue>
                <Meter pct={(found / followers) * 100} live />
              </Fragment>
            ) : (
              <div class="hint">This account has no followers to look through.</div>
            )}
            {detail.runway === null ? (
              <KeyValue k="How long they last">
                <span class="dim">shows after the first follows</span>
              </KeyValue>
            ) : detail.remainingActionable === 0 ? (
              <KeyValue k="How long they last">
                none left
                <span class="dim">Epo moves on to the next source</span>
              </KeyValue>
            ) : (
              <KeyValue k="How long they last" live>
                {runwayText(detail.runway)}
                <span class="dim">at the recent pace</span>
              </KeyValue>
            )}
          </Fragment>
        )}
      </CardBody>
    </Card>
  );
}
