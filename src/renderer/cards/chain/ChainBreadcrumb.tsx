import { Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { ChainNode } from '@/renderer/cards/chain/ChainNode';
import { crumbTier } from '@/renderer/hooks/useTargetDetail';
import { monogram, withAt } from '@/renderer/lib/format';
import { Avatar } from '@/renderer/ui/Avatar';
import { Badge } from '@/renderer/ui/Badge';
import { Icon } from '@/renderer/ui/Icon';
import type { ChainTargetView } from '@/types';

export interface ChainBreadcrumbProps {
  chain: ChainTargetView[];
  /** The source Epo explores now — the only step "Now" may mark. */
  currentPk: string | null;
  /** The source the page details (can differ while Epo is stopped). */
  viewingPk: string | null;
}

/**
 * The trail of sources as ONE strip — the starting account → … → the source
 * explored now → "the next one when this runs out" — in compact chips. Once the
 * trail has two steps it expands into every step's own line (`ChainNode`).
 * "Now" marks Epo's source alone; a source shown while Epo is stopped gets the
 * highlight and "Shown", so the strip never contradicts the details below it.
 */
export function ChainBreadcrumb({ chain, currentPk, viewingPk }: ChainBreadcrumbProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const canExpand = chain.length >= 2;
  const showTrail = canExpand && expanded;

  return (
    <Fragment>
      <div class="crumbs num">
        {chain.map((t, i) => {
          const tier = crumbTier(t.accountPk, currentPk, viewingPk);
          return (
            <Fragment key={t.accountPk}>
              {i > 0 ? (
                <span class="crumb-sep">
                  <Icon name="angle-right" />
                </span>
              ) : null}
              <span class={tier === 'plain' ? 'crumb' : 'crumb current'}>
                <Avatar small>{monogram(t.username)}</Avatar>
                <span class="handle">{withAt(t.username) || t.accountPk}</span>
                {t.source === 'seed' ? <Badge>Start</Badge> : null}
                {tier === 'current' ? <Badge tone="live">Now</Badge> : null}
                {tier === 'viewing' ? <Badge>Shown</Badge> : null}
              </span>
            </Fragment>
          );
        })}
        <span class="crumb-sep">
          <Icon name="angle-right" />
        </span>
        <span class="crumb next">the next one when this runs out</span>
        {canExpand ? (
          <button
            type="button"
            class={showTrail ? 'chip active' : 'chip'}
            aria-expanded={showTrail ? 'true' : 'false'}
            onClick={() => setExpanded((v) => !v)}
          >
            {showTrail ? 'Show fewer' : 'Show every step'}
          </button>
        ) : null}
      </div>
      {showTrail
        ? chain.map((t, i) => {
            const tier = crumbTier(t.accountPk, currentPk, viewingPk);
            return (
              <ChainNode
                key={t.accountPk}
                {...t}
                step={i + 1}
                current={tier === 'current'}
                viewing={tier === 'viewing'}
                linkLabel={i === chain.length - 1 ? 'Epo finds the next source when this one runs out' : 'led to'}
              />
            );
          })
        : null}
    </Fragment>
  );
}
