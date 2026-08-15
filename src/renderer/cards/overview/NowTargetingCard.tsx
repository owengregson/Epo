/** @jsx h */
import { h, Fragment } from 'preact';
import type { ChainTargetView, EpoStatus } from '@/types';
import { Card, CardHeader, CardBody } from '@/renderer/ui/Card';
import { Avatar } from '@/renderer/ui/Avatar';
import { Badge } from '@/renderer/ui/Badge';
import { Stat } from '@/renderer/ui/Stat';
import { useChainList } from '@/renderer/hooks/useChainList';
import { commas, monogram, pctInt, withAt } from '@/renderer/lib/format';

/** Display label for a target's source. */
function sourceLabel(source: ChainTargetView['source']): string {
  switch (source) {
    case 'seed':
      return 'Seed';
    case 'own_followers':
      return 'Own Followers';
    default:
      return 'Discovered';
  }
}

export interface NowTargetingCardProps {
  status: EpoStatus | null;
}

/**
 * Now Targeting — the engine's active chain target with its identity row and
 * live yield (follow-back rate · candidate pool · followed so far), joined
 * from the chain lineage by pk.
 */
export function NowTargetingCard({ status }: NowTargetingCardProps): h.JSX.Element {
  const chain = useChainList(status);

  const username = status?.currentTargetUsername ?? null;
  const pk = status?.currentTargetPk ?? null;
  const hop = status?.chainIndex ?? null;
  const target = pk !== null ? (chain.find((t) => t.accountPk === pk) ?? null) : null;
  const y = target?.yield ?? null;

  return (
    <Card raised index={2}>
      <CardHeader icon="bullseye" aux={<Badge>Hop {hop ?? '—'}</Badge>}>
        Now Targeting
      </CardHeader>
      <CardBody>
        {username === null ? (
          <div class="hint">No target yet — set a seed and press Start.</div>
        ) : (
          <Fragment>
            <div class="target-row">
              <Avatar>{monogram(username)}</Avatar>
              <div class="t-id">
                <div class="handle">{withAt(username)}</div>
                <div class="meta">
                  Source · {target ? sourceLabel(target.source) : '—'}
                  <span class="sep">·</span>Chain hop {hop ?? '—'}
                </div>
              </div>
            </div>
            <div class="t-stats num">
              <Stat label="Follow-back">
                {y ? (
                  <Fragment>
                    {pctInt(y.followBackRate)}
                    <small>%</small>
                  </Fragment>
                ) : (
                  '—'
                )}
              </Stat>
              <Stat label="Pool">{y ? commas(y.poolSize) : '—'}</Stat>
              <Stat label="Followed">{y ? commas(y.total) : '—'}</Stat>
            </div>
          </Fragment>
        )}
      </CardBody>
    </Card>
  );
}
