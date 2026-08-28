/** @jsx h */
import { h } from 'preact';
import { useCountUp } from '@/renderer/hooks/useCountUp';
import { commas, ratio, relTime } from '@/renderer/lib/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { NumberTicker } from '@/renderer/ui/NumberTicker';
import { Stat } from '@/renderer/ui/Stat';
import type { PruneStatus } from '@/types';

export interface PruneCensusCardProps {
  /** Live prune projection (carries the durable last-complete census). */
  prune: PruneStatus | null;
  /** True while this view's `scanPrune()` call is in flight. */
  scanning: boolean;
  /** Actionable candidates after the LIVE whitelist; null before any census. */
  visibleCount: number | null;
  /** Whitelisted (never-pruned) accounts. */
  whitelistCount: number;
}

/**
 * Prune · Census — the page-wide overview: Following / Followers / ratio /
 * Prunable tiles plus the composition bar showing how the census following
 * count splits. Every number is anchored on the LAST COMPLETE census (durable;
 * stamped "Scanned Nh ago" in the header) — a stopped scan or a consumed run
 * never swaps partial or unlabeled figures into these tiles. While a scan is
 * LIVE (docs/PRINCIPLES.md §2) the count tiles ride the walk's streaming
 * totals and the fourth tile switches to the distinctly-labeled live
 * "Unconfirmed" figure (the whole-graph not-following-back count, a broader
 * quantity than the census candidates — never shown under the census label).
 */
export function PruneCensusCard({
  prune,
  scanning,
  visibleCount,
  whitelistCount,
}: PruneCensusCardProps): h.JSX.Element {
  const isScanning = scanning || prune?.state === 'scanning';
  const census = prune?.census ?? null;

  // Count tiles: the settled census while idle; the walk's LIVE streaming
  // counts while a scan runs (the header marks that state 'live').
  const following = isScanning ? (prune?.following ?? 0) : (census?.following ?? 0);
  const followers = isScanning ? (prune?.followers ?? 0) : (census?.followers ?? 0);

  // THE one 'Prunable' definition, at all times: candidates still unvisited
  // after the live whitelist — always the same number as the candidate list.
  const prunable = visibleCount ?? prune?.remaining ?? 0;
  // The live mid-scan figure is a DIFFERENT quantity (whole-graph count,
  // including whitelisted, growth-managed, and stale edges) — it only ever
  // renders under its own label while scanning.
  const unconfirmed = prune?.graph.notFollowingBack ?? 0;

  // Paced count-ups while scanning (pushes land in page-sized jumps); the
  // quick ease-out otherwise.
  const followingD = useCountUp(following, { paced: isScanning });
  const followersD = useCountUp(followers, { paced: isScanning });
  const prunableD = useCountUp(prunable);
  const unconfirmedD = useCountUp(unconfirmed, { paced: isScanning });

  const showTiles = isScanning || census !== null;

  // Composition of the census following count, every segment from the same
  // scraped basis so they sum to the total exactly:
  //   scraped list  = follow back + exempt + (handled + prunable + shielded)
  //   header count  = scraped list + unresolvable (deactivated ghosts)
  const seg =
    census !== null
      ? (() => {
          const rawRemaining = Math.min(prune?.rawRemaining ?? 0, census.candidates);
          const actionable = Math.min(Math.max(0, prunable), rawRemaining);
          return {
            at: census.at,
            mutual: Math.max(0, census.scrapedFollowing - census.notFollowingBack),
            exempt: Math.max(0, census.notFollowingBack - census.candidates),
            handled: census.candidates - rawRemaining,
            prunable: actionable,
            shielded: rawRemaining - actionable,
            unresolvable: Math.max(0, census.following - census.scrapedFollowing),
            // Both sums the segments can form (scraped list, or header count
            // when it runs higher) — so widths can never exceed 100% and get
            // silently distorted by flex-shrink.
            total: Math.max(1, census.following, census.scrapedFollowing),
          };
        })()
      : null;
  const pct = (n: number): string => `width:${((n / (seg?.total ?? 1)) * 100).toFixed(2)}%`;

  return (
    <Card raised index={0}>
      <CardHeader
        icon="chart-pie"
        aux={isScanning ? 'live' : census !== null ? `Scanned ${relTime(census.at)}` : undefined}
      >
        Prune · Census
      </CardHeader>
      <CardBody>
        <div class="prune-stats">
          <Stat label="Following">
            {showTiles ? <NumberTicker value={followingD} /> : '—'}
          </Stat>
          <Stat label="Followers">
            {showTiles ? <NumberTicker value={followersD} /> : '—'}
          </Stat>
          <Stat label="Ratio" sub="followers per following">
            {showTiles && followingD > 0 ? ratio(followersD / followingD) : '—'}
          </Stat>
          {isScanning ? (
            <Stat label="Unconfirmed" sub="not yet seen following back">
              <NumberTicker value={unconfirmedD} />
            </Stat>
          ) : (
            <Stat label="Prunable" sub="don’t follow back · unprotected">
              {census !== null ? <NumberTicker value={prunableD} /> : '—'}
            </Stat>
          )}
          <Stat label="Whitelisted">{commas(whitelistCount)}</Stat>
        </div>
        {seg !== null ? (
          <div class="pcomp">
            {isScanning ? (
              <div class="hint">
                Composition from the last complete scan ({relTime(seg.at)}) — the tiles above are
                live.
              </div>
            ) : null}
            <div
              class="pcomp-bar"
              role="img"
              aria-label={
                `Of ${commas(seg.total)} followed accounts at the last scan: ` +
                `${commas(seg.mutual)} follow back, ${commas(seg.prunable)} are prunable, ` +
                `${commas(seg.shielded)} are whitelist-protected, ` +
                `${commas(seg.handled)} were already unfollowed or skipped by a run, ` +
                `${commas(seg.exempt)} are managed by the growth engine, and ` +
                `${commas(seg.unresolvable)} are unresolvable (deactivated or unavailable ` +
                `accounts Instagram still counts but no longer lists)`
              }
            >
              {seg.mutual > 0 ? <i class="pcomp-seg mutual" style={pct(seg.mutual)} /> : null}
              {seg.handled > 0 ? <i class="pcomp-seg handled" style={pct(seg.handled)} /> : null}
              {seg.prunable > 0 ? <i class="pcomp-seg prunable" style={pct(seg.prunable)} /> : null}
              {seg.shielded > 0 ? <i class="pcomp-seg shielded" style={pct(seg.shielded)} /> : null}
              {seg.exempt > 0 ? <i class="pcomp-seg exempt" style={pct(seg.exempt)} /> : null}
              {seg.unresolvable > 0 ? (
                <i class="pcomp-seg unresolvable" style={pct(seg.unresolvable)} />
              ) : null}
            </div>
            <div class="pcomp-legend">
              <span>
                <i class="dot mutual" /> Follow back <b class="num">{commas(seg.mutual)}</b>
              </span>
              <span>
                <i class="dot prunable" /> Prunable <b class="num">{commas(seg.prunable)}</b>
              </span>
              {seg.shielded > 0 ? (
                <span>
                  <i class="dot shielded" /> Whitelist-protected{' '}
                  <b class="num">{commas(seg.shielded)}</b>
                </span>
              ) : null}
              {seg.handled > 0 ? (
                <span title="Census candidates a run has already unfollowed or skipped">
                  <i class="dot handled" /> Unfollowed / skipped{' '}
                  <b class="num">{commas(seg.handled)}</b>
                </span>
              ) : null}
              {seg.exempt > 0 ? (
                <span title="Accounts the growth engine manages (including chain targets) — never pruned">
                  <i class="dot exempt" /> Growth-managed{' '}
                  <b class="num">{commas(seg.exempt)}</b>
                </span>
              ) : null}
              {seg.unresolvable > 0 ? (
                <span title="Deactivated or unavailable accounts Instagram still counts in your following total but no longer lists">
                  <i class="dot unresolvable" /> Unresolvable{' '}
                  <b class="num">{commas(seg.unresolvable)}</b>
                </span>
              ) : null}
            </div>
          </div>
        ) : !isScanning ? (
          <div class="hint">
            Run a scan to take the census — the bar shows how your following splits between
            accounts that follow back, prunable accounts, and protected or unresolvable ones.
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
