/** @jsx h */
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ChainTargetView, PeanutStatus } from '@/types';
import { fmtPercent } from '../format';

export interface ChainPanelProps {
  status: PeanutStatus | null;
}

const SOURCE_LABEL: Record<ChainTargetView['source'], string> = {
  seed: 'Seed',
  discovered: 'Discovered',
  own_followers: 'Own followers',
};

/**
 * The self-chaining story (spec §3): the current target made prominent, the lineage a
 * compact vertical trail beneath. Lineage + per-target yield come lazily from
 * `chain:list`, refetched whenever the current target or engine state changes.
 */
export function ChainPanel({ status }: ChainPanelProps): h.JSX.Element {
  const [chain, setChain] = useState<ChainTargetView[]>([]);
  const loggedIn = status?.loggedIn ?? false;
  const currentPk = status?.currentTargetPk ?? null;

  useEffect(() => {
    if (!loggedIn) {
      setChain([]);
      return;
    }
    let alive = true;
    window.peanut
      .chainList()
      .then((rows) => {
        if (alive) setChain(rows);
      })
      .catch(() => {
        // best-effort; failures surface in the activity log
      });
    return () => {
      alive = false;
    };
  }, [loggedIn, currentPk, status?.chainIndex, status?.state]);

  const currentName =
    status?.currentTargetUsername ?? (currentPk ? `#${currentPk}` : null);
  const current = currentPk
    ? chain.find((t) => t.accountPk === currentPk) ?? null
    : null;

  const hasChain = chain.length > 0;
  const empty = !currentName && !hasChain;

  return (
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">Chain</span>
        {status?.chainIndex !== null && status?.chainIndex !== undefined ? (
          <span class="panel__meta num">hop {status.chainIndex}</span>
        ) : null}
      </div>

      {empty ? (
        <p class="empty">No target yet — set a seed and press Start.</p>
      ) : (
        <Fragment>
          {currentName ? (
            <div class="chain-current">
              <div class="chain-current__label">Current target</div>
              <div class="chain-current__name">@{currentName}</div>
              {current ? (
                <div class="chain-current__stats">
                  <span>
                    <span class="num">{fmtPercent(current.yield.followBackRate)}</span>{' '}
                    follow-back
                  </span>
                  <span class="chain-dot">·</span>
                  <span>
                    pool <span class="num">{current.yield.poolSize}</span>
                  </span>
                  <span class="chain-dot">·</span>
                  <span>
                    followed <span class="num">{current.yield.total}</span>
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {hasChain ? (
            <ol class="trail">
              {chain.map((t) => (
                <li
                  key={t.accountPk}
                  class="trail__node"
                  data-current={t.accountPk === currentPk ? 'true' : 'false'}
                >
                  <span class="trail__rail" />
                  <div class="trail__body">
                    <div class="trail__top">
                      <span class="trail__name">
                        @{t.username ?? `#${t.accountPk}`}
                      </span>
                      <span class="tag">{SOURCE_LABEL[t.source]}</span>
                    </div>
                    <div class="trail__yield">
                      <span class="num">{fmtPercent(t.yield.followBackRate)}</span> back
                      <span class="chain-dot">·</span>
                      pool <span class="num">{t.yield.poolSize}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </Fragment>
      )}
    </section>
  );
}
