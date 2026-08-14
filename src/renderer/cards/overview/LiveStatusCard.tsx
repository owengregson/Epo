/** @jsx h */
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { EpoStatus, QueueRow, Settings } from '@/types';
import { Card, CardHeader, CardBody } from '@/renderer/ui/Card';
import { Icon } from '@/renderer/ui/Icon';
import { Meter } from '@/renderer/ui/Meter';
import { NumberTicker } from '@/renderer/ui/NumberTicker';
import { RadialRing } from '@/renderer/ui/RadialRing';
import { Stat } from '@/renderer/ui/Stat';
import { useCountdown } from '@/renderer/hooks/useCountdown';
import { useQueue } from '@/renderer/hooks/useQueue';
import { durationHm, mmss, ratio, withAt } from '@/renderer/lib/format';

type Step = NonNullable<EpoStatus['lastStep']>;
type Sentinel = NonNullable<EpoStatus['lastSentinel']>;

/** Human phrase for what the engine's last step did. */
function stepLabel(step: Step): string {
  switch (step) {
    case 'acted':
      return 'followed';
    case 'swept-followback':
      return 'swept follow-backs';
    case 'advanced-chain':
      return 'advanced chain';
    case 'acquired':
      return 'acquired pool';
    case 'waited-active-hours':
      return 'waited · hours';
    case 'waited-ceiling':
      return 'waited · ceiling';
    case 'halted':
      return 'halted';
    case 'aborted':
      return 'aborted';
    default:
      return 'idle';
  }
}

/** Short sentinel readout ("sentinel ok" in the mockup). */
function sentinelLabel(s: Sentinel): string {
  switch (s) {
    case 'ok':
      return 'ok';
    case 'action-blocked':
      return 'blocked';
    case 'challenge':
      return 'challenge';
    default:
      return 'logged out';
  }
}

/** The most recently acted-on row (max `followedAt`) from the pending queue. */
function mostRecentActed(rows: QueueRow[]): QueueRow | null {
  let best: QueueRow | null = null;
  for (const r of rows) {
    if (r.followedAt == null) continue;
    if (best === null || (best.followedAt ?? 0) < r.followedAt) best = r;
  }
  return best;
}

export interface LiveStatusCardProps {
  status: EpoStatus | null;
  settings: Settings | null;
}

/**
 * Live Status hero — the time-to-next-action instrument cluster: depleting
 * countdown ring, what fires next (head of the queued list), the compact
 * Today readout, and the Net-today / Session / Last-action cells.
 */
export function LiveStatusCard({ status, settings }: LiveStatusCardProps): h.JSX.Element {
  const cd = useCountdown(status, settings);
  const queued = useQueue('queued', status);
  const pendingQ = useQueue('pending_followback', status);

  const running = status?.state === 'running';
  const offline = status != null && !status.online;
  /** Engine is running but the connectivity monitor sees the internet down → auto-hold. */
  const offlineHold = running && offline;

  // Session uptime ticks at 1 Hz ONLY while running (holds when paused/idle).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const next = queued.rows.length > 0 ? queued.rows[0] : null;

  const done = status?.actionsToday ?? 0;
  const rate = settings?.dailyOperatingRate ?? null;
  const left = rate != null ? Math.max(0, rate - done) : null;
  const pct = rate != null && rate > 0 ? Math.min(100, (done / rate) * 100) : 0;

  const startedAt = status?.sessionStartedAt ?? null;
  const sessionText = startedAt != null ? durationHm(now - startedAt) : '—';

  const lastStep = status?.lastStep ?? null;
  const lastSentinel = status?.lastSentinel ?? null;
  const lastActed = mostRecentActed(pendingQ.rows);
  const lastActText = lastStep != null && lastActed?.username ? withAt(lastActed.username) : '—';
  const lastSub =
    lastStep == null
      ? '—'
      : lastSentinel == null
        ? stepLabel(lastStep)
        : `${stepLabel(lastStep)} · sentinel ${sentinelLabel(lastSentinel)}`;

  return (
    <Card raised index={0}>
      <CardHeader icon="stopwatch">Live Status</CardHeader>
      <CardBody>
        {/* next action: small depleting ring + prominent countdown.
            While the engine is running but the internet is down, the hold
            replaces the countdown — no fabricated numbers while offline. */}
        <div class="hero-next">
          <RadialRing frac={offlineHold ? 0 : cd.frac} glyph={offlineHold ? 'wifi' : 'bolt'} />
          <div class="hn-main">
            {offlineHold ? (
              <Fragment>
                <div class="hn-count">Offline</div>
                <div class="hn-cap">waiting for connection</div>
              </Fragment>
            ) : (
              <Fragment>
                <div class="hn-count num">{running && cd.active ? mmss(cd.remainingSec) : '—'}</div>
                <div class="hn-cap">until next action</div>
              </Fragment>
            )}
          </div>
          {offlineHold ? <span class="rchip">Reconnecting…</span> : null}
        </div>
        {offline && !offlineHold ? <div class="hint">Offline — no internet connection detected.</div> : null}

        {/* what fires next */}
        <div class="hero-what num">
          <span class="hw-k">Next</span>
          <Icon name="arrow-right-long" />
          <span class="hw-act">
            {next ? (
              <Fragment>
                follow <b>{withAt(next.username)}</b>
              </Fragment>
            ) : (
              '—'
            )}
          </span>
          <span class="spacer" />
          <span class="rchip num">{next && next.ratio != null ? `r=${ratio(next.ratio)}` : '—'}</span>
        </div>

        {/* compact Today readout (full detail lives in Rate & Safety) */}
        <div class="hero-today num">
          <div class="ht-top">
            <span class="k">Actions today</span>
            <span class="v">
              <b>
                <NumberTicker value={done} />
              </b>{' '}
              <span class="dim">/ {rate ?? '—'}</span>
            </span>
          </div>
          <Meter pct={pct} />
          <div class="ht-foot">
            <span>
              <b>{left ?? '—'}</b> left
            </span>
            <span>
              ceiling <b>{settings?.dailyHardCeiling ?? '—'}</b>
            </span>
          </div>
        </div>

        {/* secondary instruments */}
        <div class="hero-cells">
          <Stat label="Net today">
            <NumberTicker value={status?.netToday ?? 0} signed />
          </Stat>
          <Stat label="Session">{sessionText}</Stat>
          <Stat label="Last action" small sub={lastSub}>
            {lastActText}
          </Stat>
        </div>
      </CardBody>
    </Card>
  );
}
