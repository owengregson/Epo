import { useEffect, useState } from 'preact/hooks';
import type { ChainTargetDetail, ChainTargetView, EpoStatus } from '@/types';
import { chainListKey } from './useChainList';

/**
 * Which target the Targets console details: the engine's current target when
 * the chain knows it; otherwise the target the engine WOULD adopt (the active
 * target at the front of the chain — mirrors `Engine.adoptCurrent`); otherwise
 * the trail's last node (even exhausted — the funnel labels it truthfully).
 * Null only when the chain is empty. Exported for the picker's unit test.
 */
export function pickDetailTarget(
  chain: ChainTargetView[],
  currentPk: string | null,
): string | null {
  if (currentPk !== null && chain.some((t) => t.accountPk === currentPk)) return currentPk;
  let best: ChainTargetView | null = null;
  for (const t of chain) {
    if (t.status !== 'active') continue;
    if (best === null || (t.chainIndex ?? -1) > (best.chainIndex ?? -1)) best = t;
  }
  if (best !== null) return best.accountPk;
  return chain.length > 0 ? (chain[chain.length - 1]?.accountPk ?? null) : null;
}

/**
 * The `chain:detail` projection for one target, live (§2). Liveness comes from
 * the `chainList` push: main re-shapes and pushes the chain projection on every
 * throttled store mutation — including pure acquisition walks, where no status
 * counter moves — so each push IS the mutation tick, and this hook re-invokes
 * the detail read on every one. A pull keyed on the target pk plus
 * {@link chainListKey} backstops it (initial load before any push, and every
 * lifecycle transition the status stream reports).
 */
export function useTargetDetail(
  targetPk: string | null,
  status: EpoStatus | null,
): ChainTargetDetail | null {
  const [detail, setDetail] = useState<ChainTargetDetail | null>(null);
  // Bumped on every chainList push — the throttled store-mutation tick.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const onPush = (): void => setTick((n) => n + 1);
    window.epo.on('chainList', onPush);
    return () => window.epo.off('chainList', onPush);
  }, []);

  const key = `${targetPk ?? ''}|${chainListKey(status)}`;
  useEffect(() => {
    if (targetPk === null) {
      setDetail(null);
      return;
    }
    let alive = true;
    window.epo
      .chainDetail(targetPk)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        /* foundation logs; keep the last good detail */
      });
    return () => {
      alive = false;
    };
  }, [targetPk, key, tick]);

  return detail;
}
