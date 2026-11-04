/**
 * Results (spec §12.2): today's net followers as the one hero number (a true minus sign; bright only when
 * up, so losses while pruning never alarm), with a "+N" chip that rises on an increase after first paint;
 * the follower count with its age (law L-FRESH); and today's follow-backs.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { statusSignal } from '@/renderer/app/shell-context';
import { RESULTS } from '@/renderer/sidebar/copy/zone-copy';
import { count } from '@/renderer/sidebar/format';
import { NumberTicker } from '@/renderer/ui/NumberTicker';

/** The chip floats for one arrival; a new increase replaces it. */
interface Chip {
  readonly id: number;
  readonly delta: number;
}

export function ResultsPanel(): JSX.Element {
  const status = statusSignal.value;
  const [chip, setChip] = useState<Chip | null>(null);
  const now = Date.now();
  const today = status?.today ?? null;
  const net = today?.net ?? status?.netToday ?? 0;
  const followers = status?.own?.followers ?? null;
  const catching = status?.catchUp?.state === 'running';
  const age = catching ? RESULTS.checkingNow : followers === null ? null : RESULTS.checked(followers.at, now);
  return (
    <section class="sb-zone sb-results" data-zone="results" data-tour="results">
      <div class="sb-results__top">
        <div class="sb-results__hero-wrap">
          <div class={net > 0 ? 'sb-results__hero num is-up' : 'sb-results__hero num'} data-tip={today === null ? undefined : RESULTS.heroTip(today.startsAt)}>
            <NumberTicker value={net} signed minus onIncrease={(delta) => setChip((c) => ({ id: (c?.id ?? 0) + 1, delta }))} />
            {chip === null ? null : (
              <span key={chip.id} class="sb-results__chip num" aria-hidden="true" onAnimationEnd={() => setChip(null)}>
                +{count(chip.delta)}
              </span>
            )}
          </div>
          <div class="sb-results__label">{RESULTS.heroLabel}</div>
        </div>
        <p class="sb-results__followers num">
          {followers === null ? (
            <span class="sb-muted">{catching ? RESULTS.checkingNow : RESULTS.neverSeen}</span>
          ) : (
            <>
              {RESULTS.followers(followers.count)} <span class="sb-muted sb-results__age">{age}</span>
            </>
          )}
        </p>
      </div>
      <p class="sb-results__backs">
        {RESULTS.backs(today?.followBacks ?? null, status?.pendingFollowback ?? 0)}
        {catching ? <span> · {RESULTS.updating}</span> : null}
      </p>
    </section>
  );
}
