/** @jsx h */
import { Fragment, h } from 'preact';
import { useState } from 'preact/hooks';
import { monogram, withAt } from '@/renderer/lib/format';
import { Avatar } from '@/renderer/ui/Avatar';
import { Badge } from '@/renderer/ui/Badge';
import { Icon } from '@/renderer/ui/Icon';
import type { ChainTargetView } from '@/types';
import { ChainNode } from './ChainNode';

export interface ChainBreadcrumbProps {
  chain: ChainTargetView[];
  /** The target the console is detailing (usually the engine's current one). */
  currentPk: string | null;
}

/**
 * Tier 1 of the Targets console: the lineage as ONE horizontal strip —
 * seed → … → current → "next auto-discovers on exhaustion" — in compact chips
 * built from the chain-node vocabulary (monogram avatar, badge). Day 0 this
 * costs one row, not the whole tab. Once the chain actually has ≥2 nodes the
 * strip can expand back into the full vertical trail (the `ChainNode` rows,
 * every node carrying its yield subline).
 */
export function ChainBreadcrumb({ chain, currentPk }: ChainBreadcrumbProps): h.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const canExpand = chain.length >= 2;
  const showTrail = canExpand && expanded;

  return (
    <Fragment>
      <div class="crumbs num">
        {chain.map((t, i) => {
          const current = currentPk !== null && t.accountPk === currentPk;
          const seed = t.source === 'seed' || t.chainIndex === 0;
          return (
            <Fragment key={t.accountPk}>
              {i > 0 ? (
                <span class="crumb-sep">
                  <Icon name="angle-right" />
                </span>
              ) : null}
              <span class={current ? 'crumb current' : 'crumb'}>
                <Avatar small>{monogram(t.username)}</Avatar>
                <span class="handle">{withAt(t.username)}</span>
                {seed ? <Badge>Seed</Badge> : null}
                {current ? <Badge tone="live">Current</Badge> : null}
              </span>
            </Fragment>
          );
        })}
        <span class="crumb-sep">
          <Icon name="angle-right" />
        </span>
        <span class="crumb next">next auto-discovers on exhaustion</span>
        {canExpand ? (
          <button
            type="button"
            class={showTrail ? 'chip active' : 'chip'}
            aria-expanded={showTrail ? 'true' : 'false'}
            onClick={() => setExpanded((v) => !v)}
          >
            {showTrail ? 'collapse trail' : 'expand trail'}
          </button>
        ) : null}
      </div>
      {showTrail
        ? chain.map((t, i) => {
            const isLast = i === chain.length - 1;
            return (
              <ChainNode
                key={t.accountPk}
                {...t}
                current={currentPk !== null && t.accountPk === currentPk}
                isLast={isLast}
                linkLabel={isLast ? 'next target auto-discovers on exhaustion' : 'chained to'}
              />
            );
          })
        : null}
    </Fragment>
  );
}
