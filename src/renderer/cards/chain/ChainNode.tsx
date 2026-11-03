import { Fragment, type JSX } from 'preact';
import { commas, monogram, pctInt, withAt } from '@/renderer/lib/format';
import { Avatar } from '@/renderer/ui/Avatar';
import { Badge } from '@/renderer/ui/Badge';
import type { ChainTargetView } from '@/types';

export interface ChainNodeProps extends ChainTargetView {
  /** Its place in the trail, counted from 1. */
  step: number;
  /** True when this source is the one Epo explores now. */
  current: boolean;
  /** True when the page details this source WITHOUT Epo exploring it now — a highlight only. */
  viewing: boolean;
  /** Label for the connector rendered after this step. */
  linkLabel: string;
}

/** How each source came to be on the trail (the first one is the starting account). */
const SOURCE_LABELS: Record<ChainTargetView['source'], string> = {
  seed: 'Starting account',
  discovered: 'Found by Epo',
  own_followers: 'Your followers',
};

/**
 * What became of a source, in words. A source explored without a single follow
 * says so — running out of new people there is a different fact from having
 * worked it.
 */
export function sourceState(t: Pick<ChainTargetView, 'status' | 'yield'>, current: boolean): string {
  if (current) return `Exploring now · ${commas(t.yield.total)} followed here`;
  switch (t.status) {
    case 'exhausted':
      return t.yield.total === 0 ? 'Explored · no one new to follow' : `Explored · ${commas(t.yield.total)} followed`;
    case 'retired':
      return 'Set aside when you restarted';
    case 'retained':
      return 'Kept · Epo explores through it';
    default:
      return `${commas(t.yield.total)} followed here`;
  }
}

/**
 * One step in the expanded trail, plus the connector that follows it. Every
 * step — the starting account included — carries the same line: follow-backs,
 * people found so far, and what became of it; its numbers move during walks
 * (docs/PRINCIPLES.md §2). "People found" is what the walk has seen, never the
 * account's follower count.
 */
export function ChainNode(props: ChainNodeProps): JSX.Element {
  return (
    <Fragment>
      <div class={props.current || props.viewing ? 'chain-node current' : 'chain-node'}>
        <Avatar small>{monogram(props.username)}</Avatar>
        <div class="cn-body">
          <div class="h">
            <span class="handle">{withAt(props.username) || props.accountPk}</span>
            <Badge tone={props.current ? 'live' : undefined}>Step {props.step}</Badge>
            <Badge>{SOURCE_LABELS[props.source]}</Badge>
          </div>
          <div class="sub num">
            {pctInt(props.yield.followBackRate)}% followed back<span class="sep">·</span>
            {commas(props.yield.poolSize)} people found
            <span class="sep">·</span>
            {sourceState(props, props.current)}
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
