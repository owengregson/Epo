/** @jsx h */
import { h } from 'preact';
import { useCountUp } from '@/renderer/hooks/useCountUp';
import { commas, ratio, relTime } from '@/renderer/lib/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { NumberTicker } from '@/renderer/ui/NumberTicker';
import { Stat } from '@/renderer/ui/Stat';
import type { PruneScanResult, PruneStatus } from '@/types';

export interface PruneCensusCardProps {
  /** Live prune projection (carries the last persisted scan's counts). */
  prune: PruneStatus | null;
  /** This session's scan result, when one has completed. */
  scan: PruneScanResult | null;
  /** True while this view's `scanPrune()` call is in flight. */
  scanning: boolean;
  /** Actionable candidates after the LIVE whitelist; null before any census. */
  visibleCount: number | null;
  /** Whitelisted (never-pruned) accounts. */
  whitelistCount: number;
}

/**
 * Prune · Census — the page-wide overview: Following / Followers / ratio /
 * Not-following-back tiles plus the reciprocity bar showing how the following
 * count splits (follow back / prunable / whitelist-protected). All numbers are
 * LIVE during a scan (docs/PRINCIPLES.md §2): scan sources stream every row's
 * edge into the graph, and the pushed projection carries graph-derived counts —
 * so the tiles and the bar move WHILE the walk runs, not when it ends.
 */
export function PruneCensusCard({
  prune,
  scan,
  scanning,
  visibleCount,
  whitelistCount,
}: PruneCensusCardProps): h.JSX.Element {
  const isScanning = scanning || prune?.state === 'scanning';

  // While a scan is LIVE the pushed projection carries the mid-scrape counts —
  // prefer it over a previous session's cached scan so the numbers tick in
  // real time. Otherwise prefer this session's scan, then the persisted counts.
  const following =
    (isScanning ? prune?.following : undefined) ?? scan?.following ?? prune?.following ?? 0;
  const followers =
    (isScanning ? prune?.followers : undefined) ?? scan?.followers ?? prune?.followers ?? 0;
  const notBack = isScanning
    ? (prune?.graph.notFollowingBack ?? 0)
    : scan !== null
      ? scan.candidates.length
      : (prune?.candidates ?? 0);

  // Paced count-ups while scanning (pushes land in page-sized jumps); the quick
  // ease-out otherwise. The bar rides the same display values as the tiles.
  const followingD = useCountUp(following, { paced: isScanning });
  const followersD = useCountUp(followers, { paced: isScanning });
  const notBackD = useCountUp(notBack, { paced: isScanning });

  const scannedEver =
    isScanning ||
    scan !== null ||
    (prune !== null && (prune.following > 0 || prune.followers > 0));

  // The whitelist shields part of the not-following-back set; the rest is
  // prunable. Split the DISPLAY value the same way so the bar ticks with it.
  const shielded =
    visibleCount !== null ? Math.max(0, notBack - Math.min(notBack, visibleCount)) : 0;
  const shieldedW = Math.min(shielded, notBackD);
  const prunableW = Math.max(0, notBackD - shieldedW);
  const mutualW = Math.max(0, followingD - notBackD);
  const total = Math.max(1, followingD);
  const pct = (n: number): string => `width:${((n / total) * 100).toFixed(2)}%`;

  return (
    <Card raised index={0}>
      <CardHeader
        icon="chart-pie"
        aux={isScanning ? 'live' : prune?.scanAt != null ? relTime(prune.scanAt) : undefined}
      >
        Prune · Census
      </CardHeader>
      <CardBody>
        <div class="prune-stats">
          <Stat label="Following">
            {scannedEver ? <NumberTicker value={followingD} /> : '—'}
          </Stat>
          <Stat label="Followers">
            {scannedEver ? <NumberTicker value={followersD} /> : '—'}
          </Stat>
          <Stat label="Ratio" sub="followers per following">
            {scannedEver && followingD > 0 ? ratio(followersD / followingD) : '—'}
          </Stat>
          <Stat label="Not following back">
            {scannedEver ? <NumberTicker value={notBackD} /> : '—'}
          </Stat>
          <Stat label="Whitelisted">{commas(whitelistCount)}</Stat>
        </div>
        {scannedEver && followingD > 0 ? (
          <div class="pcomp">
            <div
              class="pcomp-bar"
              role="img"
              aria-label={`Of ${commas(followingD)} followed accounts: ${commas(mutualW)} follow back, ${commas(prunableW)} are prunable, ${commas(shieldedW)} are whitelist-protected`}
            >
              <i class="pcomp-seg mutual" style={pct(mutualW)} />
              <i class="pcomp-seg prunable" style={pct(prunableW)} />
              {shieldedW > 0 ? <i class="pcomp-seg shielded" style={pct(shieldedW)} /> : null}
            </div>
            <div class="pcomp-legend">
              <span>
                <i class="dot mutual" /> Follow back <b class="num">{commas(mutualW)}</b>
              </span>
              <span>
                <i class="dot prunable" /> Prunable <b class="num">{commas(prunableW)}</b>
              </span>
              <span>
                <i class="dot shielded" /> Whitelist-protected{' '}
                <b class="num">{commas(shieldedW)}</b>
              </span>
            </div>
          </div>
        ) : (
          <div class="hint">
            Run a scan to take the census — the bar shows how your following splits between
            accounts that follow back, prunable accounts, and whitelisted ones.
          </div>
        )}
      </CardBody>
    </Card>
  );
}
