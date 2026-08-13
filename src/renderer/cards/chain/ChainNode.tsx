/** @jsx h */
import { h, Fragment } from 'preact';
import type { ChainTargetView } from '@/types';
import { Avatar } from '@/renderer/ui/Avatar';
import { Badge } from '@/renderer/ui/Badge';
import { monogram, withAt, commas, pctInt } from '@/renderer/lib/format';

export interface ChainNodeProps extends ChainTargetView {
  /** True when this node is the engine's active target. */
  current: boolean;
  /** True for the final node in the trail. */
  isLast: boolean;
  /** Label for the `.chain-link` connector rendered after this node. */
  linkLabel: string;
}

/** Badge label for each target source (seed handled separately). */
const SOURCE_LABELS: Record<ChainTargetView['source'], string> = {
  seed: 'Seed',
  discovered: 'Discovered',
  own_followers: 'Own Followers',
};

/**
 * One node in the target lineage trail, plus the `.chain-link` connector that
 * follows it. Faithful to the mockup's markup — `.chain-node` (with `.current`
 * for the active target), `.avatar.small` monogram, `.cn-body` with the
 * handle + badge header and yield subline — with no card wrapper and no
 * inline styles; all tone comes from the shared classes in cards.css.
 */
export function ChainNode(props: ChainNodeProps): h.JSX.Element {
  const seed = props.source === 'seed' || props.chainIndex === 0;

  return (
    <Fragment>
      <div class={props.current ? 'chain-node current' : 'chain-node'}>
        <Avatar small>{monogram(props.username)}</Avatar>
        <div class="cn-body">
          <div class="h">
            <span class="handle">{withAt(props.username)}</span>
            {seed ? (
              <Badge>Seed</Badge>
            ) : props.current ? (
              <Badge tone="live">Current · Hop {props.chainIndex ?? 0}</Badge>
            ) : (
              <Badge>{SOURCE_LABELS[props.source]}</Badge>
            )}
          </div>
          {seed ? (
            <div class="sub">
              Origin account<span class="sep">·</span>exhausted &amp; chained
            </div>
          ) : (
            <div class="sub num">
              {pctInt(props.yield.followBackRate)}% back<span class="sep">·</span>pool{' '}
              {commas(props.yield.poolSize)}
              <span class="sep">·</span>
              {props.current ? `followed ${props.yield.total}` : 'exhausted'}
            </div>
          )}
        </div>
      </div>
      <div class="chain-link">
        <span class="stem" />
        <span>{props.linkLabel}</span>
      </div>
    </Fragment>
  );
}
