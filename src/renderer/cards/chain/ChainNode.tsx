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
 * Status-truthful tail for a node's subline. An exhausted target that never
 * yielded a follow is called out as "exhausted (unworked)" — the pool being
 * drained without work is a different fact from a poached-out target.
 */
function statusText(props: ChainNodeProps): string {
  if (props.current) return `followed ${props.yield.total}`;
  switch (props.status) {
    case 'exhausted':
      return props.yield.total === 0 ? 'exhausted (unworked)' : 'exhausted & chained';
    case 'retained':
      return 'retired';
    default:
      return `followed ${props.yield.total}`; // active but not adopted this session
  }
}

/**
 * One node in the expanded lineage trail, plus the `.chain-link` connector that
 * follows it. Every node — the seed included — carries the same yield subline
 * (follow-back rate · followers scanned · status): the seed is a working
 * target like any other, and its numbers move during walks (§2). The observed
 * follower count is labeled "scanned", never "pool" — it is what the walk has
 * seen, not the audience size.
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
            {seed ? <Badge>Seed</Badge> : null}
            {props.current ? (
              <Badge tone="live">Current · Hop {props.chainIndex ?? 0}</Badge>
            ) : seed ? null : (
              <Badge>{SOURCE_LABELS[props.source]}</Badge>
            )}
          </div>
          <div class="sub num">
            {pctInt(props.yield.followBackRate)}% back<span class="sep">·</span>
            {commas(props.yield.poolSize)} scanned
            <span class="sep">·</span>
            {statusText(props)}
          </div>
        </div>
      </div>
      <div class="chain-link">
        <span class="stem" />
        <span>{props.linkLabel}</span>
      </div>
    </Fragment>
  );
}
