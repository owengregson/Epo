/** @jsx h */
import { Fragment, h } from 'preact';
import { useCountdown } from '@/renderer/hooks/useCountdown';
import { useNow } from '@/renderer/hooks/useNow';
import { useQueue } from '@/renderer/hooks/useQueue';
import { dailyRateView } from '@/renderer/lib/engine-view';
import { durationHm, mmss, ratio, withAt } from '@/renderer/lib/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { Icon } from '@/renderer/ui/Icon';
import { Meter } from '@/renderer/ui/Meter';
import { NumberTicker } from '@/renderer/ui/NumberTicker';
import { RadialRing } from '@/renderer/ui/RadialRing';
import { Stat } from '@/renderer/ui/Stat';
import type { EpoStatus, Settings } from '@/types';

type Step = NonNullable<EpoStatus['lastStep']>;
type Sentinel = NonNullable<EpoStatus['lastSentinel']>;

/** Readable phrase for what the engine's last step did. */
function stepLabel(step: Step): string {
  switch (step) {
    case 'acted':
      return 'acted';
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

/** Readable sentence for an engine halt reason (raw reason shown when unknown). */
function haltText(reason: string): string {
  if (reason.startsWith('sentinel:')) {
    return `Halted — Instagram flagged the session (${reason.slice('sentinel:'.length)}). Resolve it in the tab, then start again.`;
  }
  switch (reason) {
    case 'actions-failing':
      return 'Halted — every recent action failed to register. Something systemic (Instagram change, input pipeline) needs a look before restarting.';
    case 'chain-exhausted':
      return 'Halted — the target chain is exhausted. Restart from a new seed.';
    case 'seed-missing':
      return 'Halted — no seed account is configured.';
    case 'seed-unresolved':
      return 'Halted — the seed account could not be resolved.';
    default:
      return `Halted — ${reason}.`;
  }
}

export interface LiveStatusCardProps {
  status: EpoStatus | null;
  settings: Settings | null;
  /** Entrance-stagger index (`--i`); shifts down when the sign-in gate leads. */
  index?: number;
}

/**
 * Live Status hero — the time-to-next-action instrument cluster: depleting
 * countdown ring, what fires next (head of the queued list), the compact
 * Today readout, and the Net-today / Session / Last-action cells.
 */
export function LiveStatusCard({ status, settings, index = 0 }: LiveStatusCardProps): h.JSX.Element {
  const running = status?.state === 'running';

  // ONE 1 Hz clock for the whole card — countdown, session uptime, and the
  // last-action age all read the same tick (holds when paused/idle).
  const now = useNow(1000, running);
  const cd = useCountdown(status, now);
  const queued = useQueue('queued', status);
  const unfollowQ = useQueue('unfollow_queued', status);

  const offline = status != null && !status.online;
  /** Engine is running but the connectivity monitor sees the internet down → auto-hold. */
  const offlineHold = running && offline;

  // What the engine will REALLY do next mirrors nextDue's precedence: reclaim
  // slots first — any due unfollow fires before a new follow. The card used to
  // read only the queued list and claim "follow @x" while an unfollow was due.
  const nextUnfollow =
    (status?.unfollowDue ?? 0) > 0 && unfollowQ.rows.length > 0 ? unfollowQ.rows[0] : null;
  const nextFollow = queued.rows.length > 0 ? queued.rows[0] : null;
  const next = nextUnfollow ?? nextFollow;
  const nextVerb = nextUnfollow !== null ? 'unfollow' : 'follow';

  const { done, rate, pct } = dailyRateView(status, settings);
  const left = rate != null ? Math.max(0, rate - done) : null;

  const startedAt = status?.sessionStartedAt ?? null;
  const sessionText = startedAt != null ? durationHm(now - startedAt) : '—';

  const lastStep = status?.lastStep ?? null;
  const lastSentinel = status?.lastSentinel ?? null;
  // The truthful last-action source is `lastActionAt` (the engine stamps it
  // only when churn genuinely executed). The old handle-from-the-pending-queue
  // display broke two ways: the page is oldest-first and capped, so past 100
  // pending records it showed an account followed DAYS ago — and it rendered a
  // handle beside non-action steps like "waited · ceiling".
  const lastActionAt = status?.lastActionAt ?? null;
  const lastActText = lastActionAt != null ? `${durationHm(Math.max(0, now - lastActionAt))} ago` : '—';
  const lastSub =
    lastStep == null
      ? '—'
      : lastSentinel == null
        ? stepLabel(lastStep)
        : `${stepLabel(lastStep)} · sentinel ${sentinelLabel(lastSentinel)}`;

  return (
    <Card raised index={index}>
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
        {status?.state === 'halted' && status.haltReason != null ? (
          <div class="hint alarm" role="alert">
            {haltText(status.haltReason)}
          </div>
        ) : null}

        {/* what fires next */}
        <div class="hero-what num">
          <span class="hw-k">Next</span>
          <Icon name="arrow-right-long" />
          <span class="hw-act">
            {next ? (
              <Fragment>
                {nextVerb} <b>{withAt(next.username)}</b>
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
