import { Fragment, type JSX } from 'preact';
import { frontierCaption } from '@/renderer/cards/overview/runtime-copy';
import { useChainList } from '@/renderer/hooks/useChainList';
import { commas, monogram, pctInt, withAt } from '@/renderer/lib/format';
import { Avatar } from '@/renderer/ui/Avatar';
import { Badge } from '@/renderer/ui/Badge';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { Stat } from '@/renderer/ui/Stat';
import type { ChainTargetView, EpoStatus } from '@/types';

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
export function NowTargetingCard({ status }: NowTargetingCardProps): JSX.Element {
  const chain = useChainList(status);

  const username = status?.currentTargetUsername ?? null;
  const pk = status?.currentTargetPk ?? null;
  const hop = status?.chainIndex ?? null;
  const target = pk !== null ? (chain.find((t) => t.accountPk === pk) ?? null) : null;
  const y = target?.yield ?? null;
  const portfolio = frontierCaption(status, chain, Date.now());

  return (
    <Card raised>
      <CardHeader icon="bullseye" aux={<Badge>Hop {hop ?? '—'}</Badge>}>
        Now Targeting
      </CardHeader>
      <CardBody>
        {username === null ? (
          <div class="hint">{status?.frontier?.sources.length ? 'Waiting for the next source visit.' : 'No target yet — set a seed and press Start.'}</div>
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
              {/* Observed-edge count — labeled "scanned", never "pool": the true
                  audience size lives on the Targets tab once enrichment lands. */}
              <Stat label="Scanned">{y ? commas(y.poolSize) : '—'}</Stat>
              <Stat label="Followed">{y ? commas(y.total) : '—'}</Stat>
            </div>
          </Fragment>
        )}
        {portfolio.map((line) => <div class="hint" key={line}>{line}</div>)}
      </CardBody>
    </Card>
  );
}
