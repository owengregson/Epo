/** @jsx h */
import { Fragment, h } from 'preact';
import { ChainNode } from '@/renderer/cards/chain/ChainNode';
import { useChainList } from '@/renderer/hooks/useChainList';
import { Icon } from '@/renderer/ui/Icon';
import type { EpoStatus } from '@/types';

export interface ChainViewProps {
  status: EpoStatus | null;
}

/**
 * Chain view — the target lineage trail. Renders the shared `.view-h` header,
 * then the `.chain-node` / `.chain-link` trail as direct children of the view
 * (no card wrapper — the mockup faked that with inline overrides), bound to
 * the live `chain:list` projection.
 */
export function ChainView(props: ChainViewProps): h.JSX.Element {
  const chain = useChainList(props.status);
  const currentPk = props.status?.currentTargetPk ?? null;

  if (chain.length === 0) {
    return (
      <Fragment>
        <div class="view-h">
          <Icon name="link" /> Target Chain · Lineage
        </div>
        <div class="chain-node">
          <div class="cn-body">
            <div class="sub">No chain yet — set a seed and press Start.</div>
          </div>
        </div>
      </Fragment>
    );
  }

  return (
    <Fragment>
      <div class="view-h">
        <Icon name="link" /> Target Chain · Lineage
      </div>
      {chain.map((target, i) => {
        const isLast = i === chain.length - 1;
        return (
          <ChainNode
            key={target.accountPk}
            {...target}
            current={currentPk !== null && target.accountPk === currentPk}
            isLast={isLast}
            linkLabel={isLast ? 'next target auto-discovers on exhaustion' : 'chained to'}
          />
        );
      })}
    </Fragment>
  );
}
