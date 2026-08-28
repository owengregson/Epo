/** @jsx h */
import { Fragment, h } from 'preact';
import { ChainBreadcrumb } from '@/renderer/cards/chain/ChainBreadcrumb';
import { ConversionCard } from '@/renderer/cards/chain/ConversionCard';
import { PoolRunwayCard } from '@/renderer/cards/chain/PoolRunwayCard';
import { TargetFunnelCard } from '@/renderer/cards/chain/TargetFunnelCard';
import { useChainList } from '@/renderer/hooks/useChainList';
import { pickDetailTarget, useTargetDetail } from '@/renderer/hooks/useTargetDetail';
import { Icon } from '@/renderer/ui/Icon';
import type { EpoStatus } from '@/types';

export interface ChainViewProps {
  status: EpoStatus | null;
}

/**
 * The Targets console (nav key stays 'chain'): four tiers, top to bottom —
 * the lineage breadcrumb (expanding into the full trail once the chain has
 * ≥2 nodes), the detailed target's live funnel, the honest pool & runway
 * framing, and the progressive conversion readout. Everything derives from
 * the pushed `chain:list` projection plus the `chain:detail` read the detail
 * hook re-invokes on every push — so the whole tab ticks DURING walks (§2),
 * not only when a chain node is ever appended.
 */
export function ChainView(props: ChainViewProps): h.JSX.Element {
  const chain = useChainList(props.status);
  const currentPk = props.status?.currentTargetPk ?? null;
  const detailPk = pickDetailTarget(chain, currentPk);
  const detail = useTargetDetail(detailPk, props.status);

  if (chain.length === 0) {
    return (
      <Fragment>
        <div class="view-h">
          <Icon name="link" /> Targets · Chain Lineage
        </div>
        <div class="chain-node">
          <div class="cn-body">
            <div class="sub">No targets yet — set a seed and press Start.</div>
          </div>
        </div>
      </Fragment>
    );
  }

  return (
    <Fragment>
      <div class="view-h">
        <Icon name="link" /> Targets · Chain Lineage
      </div>
      {/* "Current" semantics come from the ENGINE's pk; the detailed target
          (which can fall back to an exhausted node while stopped) only gets
          the viewing highlight — the tiers must never contradict. */}
      <ChainBreadcrumb chain={chain} currentPk={currentPk} viewingPk={detailPk} />
      <TargetFunnelCard
        detail={detail}
        current={currentPk !== null && detailPk === currentPk}
        index={0}
      />
      <PoolRunwayCard detail={detail} index={1} />
      <ConversionCard detail={detail} index={2} />
    </Fragment>
  );
}
