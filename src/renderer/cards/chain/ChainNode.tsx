/** @jsx h */
import { Fragment, h } from 'preact';
import { commas, monogram, pctInt, withAt } from '@/renderer/lib/format';
import { Avatar } from '@/renderer/ui/Avatar';
import { Badge } from '@/renderer/ui/Badge';
import type { ChainTargetView } from '@/types';

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
/**
 * Status-truthful tail for a node's subline. The old markup hardcoded
 * "exhausted & chained" on every seed node — including a seed that IS the
 * live current target — and "exhausted" on every non-current node regardless
 * of its stored status.
 */
function statusText(props: ChainNodeProps): string {
  if (props.current) return `followed ${props.yield.total}`;
  switch (props.status) {
    case 'exhausted':
      return 'exhausted & chained';
    case 'retained':
      return 'retired';
    default:
      return `followed ${props.yield.total}`; // active but not adopted this session
  }
}

export function ChainNode(props: ChainNodeProps): h.JSX.Element {
  const seed = props.source === 'seed' || props.chainIndex === 0;

  return (
    <Fragment>
      <div class={props.current ? 'chain-node current' : 'chain-node'}>
        <Avatar small>{monogram(props.username)}</Avatar>
        <div class="cn-body">
          <div class="h">
            <span class="handle">{withAt(props.username)}</span>
            {seed ? <Badge>Seed</Badge> : null}
            {props.current ? (
              <Badge tone="live">Current · Hop {props.chainIndex ?? 0}</Badge>
            ) : seed ? null : (
              <Badge>{SOURCE_LABELS[props.source]}</Badge>
            )}
          </div>
          {seed ? (
            <div class="sub num">
              Origin account<span class="sep">·</span>
              {statusText(props)}
            </div>
          ) : (
            <div class="sub num">
              {pctInt(props.yield.followBackRate)}% back<span class="sep">·</span>pool{' '}
              {commas(props.yield.poolSize)}
              <span class="sep">·</span>
              {statusText(props)}
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
