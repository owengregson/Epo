import { useEffect, useState } from 'preact/hooks';
import { chainListSignal } from '@/renderer/app/live-signals';
import { chainListKey } from '@/renderer/hooks/chain-list-key';
import type { ChainTargetDetail, EpoStatus } from '@/types';

/**
 * The source the People page details: the engine's current one, else the one
 * the engine would resume (`status.resumeTarget`, the same pure pick the
 * pipeline adopts — spec §13). Null when neither exists.
 */
export function detailTargetPk(status: EpoStatus | null): string | null {
  return status?.currentTargetPk ?? status?.resumeTarget?.pk ?? null;
}

/** How the steps list marks one source. */
export type CrumbTier = 'current' | 'viewing' | 'plain';

/**
 * The marking for one step. "Now" belongs to the ENGINE's current source alone;
 * the source the page merely details while Epo is stopped is 'viewing' — a
 * highlight, never a claim the detail's own status would contradict.
 */
export function crumbTier(accountPk: string, currentPk: string | null, viewingPk: string | null): CrumbTier {
  if (currentPk !== null && accountPk === currentPk) return 'current';
  if (viewingPk !== null && accountPk === viewingPk) return 'viewing';
  return 'plain';
}

/** Main logs a failing handler and answers its fallback; a rejected invoke keeps the last good detail. */
const keepLast = (): void => undefined;

/**
 * The `chain:detail` projection for one source, live (docs/PRINCIPLES.md §2):
 * every chain push is the throttled store-mutation tick, so the read re-runs on
 * each one — counts move DURING walks. Read only while `active` (the page is
 * shown); a page that opens re-reads at once. A pull keyed on the source and
 * the lifecycle counters backstops the push.
 */
export function useTargetDetail(
  targetPk: string | null,
  status: EpoStatus | null,
  active = true,
): ChainTargetDetail | null {
  const [detail, setDetail] = useState<ChainTargetDetail | null>(null);
  const tick = chainListSignal.value;
  const key = `${targetPk ?? ''}|${chainListKey(status)}`;

  useEffect(() => {
    if (!active) return;
    if (targetPk === null) {
      setDetail(null);
      return;
    }
    let alive = true;
    window.epo.chainDetail(targetPk).then((d) => {
      if (alive) setDetail(d);
    }, keepLast);
    return () => {
      alive = false;
    };
  }, [targetPk, key, tick, active]);

  return detail;
}
