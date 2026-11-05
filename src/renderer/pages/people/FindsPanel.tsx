import { Fragment, type JSX } from 'preact';
import type { ChainList } from '@/renderer/app/live-signals';
import { statusSignal } from '@/renderer/app/shell-context';
import { ChainBreadcrumb } from '@/renderer/cards/chain/ChainBreadcrumb';
import { ConversionCard } from '@/renderer/cards/chain/ConversionCard';
import { PoolRunwayCard } from '@/renderer/cards/chain/PoolRunwayCard';
import { TargetFunnelCard } from '@/renderer/cards/chain/TargetFunnelCard';
import { detailTargetPk, useTargetDetail } from '@/renderer/hooks/useTargetDetail';

/**
 * "Where Epo finds people": the trail of sources, then the source Epo explores
 * now — or, while it is stopped, the one it would resume — in detail: where its
 * people are, how many are left and who followed back. "Now" belongs to Epo's
 * current source alone, so the trail and the details never disagree.
 */
export function FindsPanel({ chain, active }: { chain: ChainList; active: boolean }): JSX.Element {
  const status = statusSignal.value;
  const currentPk = status?.currentTargetPk ?? null;
  const detailPk = detailTargetPk(status);
  const detail = useTargetDetail(detailPk, status, active);

  return (
    <Fragment>
      <ChainBreadcrumb chain={chain} currentPk={currentPk} viewingPk={detailPk} />
      {detail === null ? <p class="hint">Epo isn’t exploring a source yet.</p> : (
        <Fragment>
          <TargetFunnelCard detail={detail} current={currentPk !== null && detailPk === currentPk} />
          <PoolRunwayCard detail={detail} />
          <ConversionCard detail={detail} />
        </Fragment>
      )}
    </Fragment>
  );
}
