import { Fragment, type JSX } from 'preact';
import {
  haltText,
  holdChipText,
  lastStepSummary,
  parkCaption,
  parkGlyph,
  parkHeadline,
  recoveryHoldCaption,
} from '@/renderer/cards/overview/live-status-copy';
import { progressCaption, runtimeHold } from '@/renderer/cards/overview/runtime-copy';
import { useCountdown, useHoldCountdown } from '@/renderer/hooks/useCountdown';
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
import type { EpoStatus, PruneStatus, Settings } from '@/types';

export interface LiveStatusCardProps {
  status: EpoStatus | null;
  /** The prune projection — while a prune holds the tab, the hero counts ITS
   *  next unfollow (unified status) instead of freezing on an idle engine. */
  prune: PruneStatus | null;
  settings: Settings | null;
}

/**
 * Live Status hero — the time-to-next-action instrument cluster: depleting
 * countdown ring, what fires next (head of the queued list), the compact
 * Today readout, and the Net-today / Session / Last-action cells.
 */
export function LiveStatusCard({ status, prune, settings }: LiveStatusCardProps): JSX.Element {
  const running = status?.state === 'running';
  // Unified status: while a prune holds the tab (growth idle or parked under
  // it), the hero's clock and countdown follow the PRUNE's pacing — the timer
  // used to freeze at "—" for a whole run.
  const pruneRunning = prune?.state === 'running';
  const pruneDrives = pruneRunning || prune?.state === 'paused';

  // ONE 1 Hz clock for the whole card — countdown, session uptime, and the
  // last-action age all read the same tick (holds when paused/idle).
  const now = useNow(1000, running || pruneRunning || status?.runtime?.desired === 'running');
  const cd = useCountdown(
    pruneDrives
      ? { running: pruneRunning, nextActionAt: prune?.nextActionAt ?? null, lastActionAt: null }
      : {
          running,
          nextActionAt: status?.nextActionAt ?? null,
          lastActionAt: status?.lastActionAt ?? null,
        },
    now,
  );
  const queued = useQueue('queued', status);
  const unfollowQ = useQueue('unfollow_queued', status);

  const offline = status != null && !status.online;
  /** Engine is running but the connectivity monitor sees the internet down → auto-hold. */
  const offlineHold = running && offline;

  // Running but deliberately holding — a long park (outside active hours,
  // plan done, between sessions, …). First-class like the offline hold, so a
  // parked engine never reads as "running with dashes". Offline wins: with no
  // connectivity the park wait is cancelled anyway.
  const parkReason = status?.parkReason ?? null;
  const parkedUntil = status?.parkedUntil ?? null;
  const parkHold =
    running && !offlineHold && parkReason != null && parkedUntil != null
      ? { reason: parkReason, until: parkedUntil }
      : null;
  // Recovery ladder posture: a holding ladder rides the park-hold layout with
  // its own rung-aware caption; a probing ladder gets a hint line below.
  const recovery = status?.recovery ?? null;
  const hold = useHoldCountdown(parkHold?.until ?? null, now);

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
  const lastSub = lastStepSummary(lastStep, lastSentinel);
  const deviceHold = runtimeHold(status, pruneDrives);
  const progress = progressCaption(status, now);

  return (
    <Card raised>
      <CardHeader icon="stopwatch">Live Status</CardHeader>
      <CardBody>
        {/* next action: small depleting ring + prominent countdown.
            While the engine is running but the internet is down, the hold
            replaces the countdown — no fabricated numbers while offline.
            A long park (outside active hours, plan done, between sessions)
            renders the same hold layout: calm headline, why, when it resumes,
            and a live countdown chip fed by the engine's real park deadline. */}
        <div class="hero-next">
          <RadialRing
            frac={deviceHold || offlineHold ? 0 : parkHold ? hold.frac : cd.frac}
            glyph={deviceHold ? 'hourglass-half' : offlineHold ? 'wifi' : parkHold ? parkGlyph(parkHold.reason) : 'bolt'}
          />
          <div class="hn-main">
            {deviceHold ? (
              <Fragment>
                <div class="hn-count">{deviceHold.headline}</div>
                <div class={deviceHold.alert ? 'hn-cap alarm' : 'hn-cap'} role={deviceHold.alert ? 'alert' : undefined}>
                  {deviceHold.caption}
                </div>
              </Fragment>
            ) : offlineHold ? (
              <Fragment>
                <div class="hn-count">Offline</div>
                <div class="hn-cap">waiting for connection</div>
              </Fragment>
            ) : parkHold ? (
              <Fragment>
                <div class="hn-count">{parkHeadline(parkHold.reason)}</div>
                <div class="hn-cap">
                  {parkHold.reason === 'recovery' && recovery != null
                    ? recoveryHoldCaption(recovery, now)
                    : parkCaption(parkHold.reason, parkHold.until, now, done, rate)}
                </div>
              </Fragment>
            ) : (
              <Fragment>
                <div class="hn-count num">{cd.active ? mmss(cd.remainingSec) : '—'}</div>
                <div class="hn-cap">{pruneDrives ? 'until next unfollow' : 'until next action'}</div>
              </Fragment>
            )}
          </div>
          {deviceHold ? null : offlineHold ? (
            <span class="rchip">Reconnecting…</span>
          ) : parkHold ? (
            <span class="rchip num">{holdChipText(parkHold.until, now, hold.remainingSec)}</span>
          ) : null}
        </div>
        {progress ? <div class="hint">{progress}</div> : null}
        {status?.reentry?.phase === 'probation' ? (
          <div class="hint">Returning gradually · {status.reentry.probationActions} actions completed since the session check.</div>
        ) : null}
        {(status?.health?.consecutiveErrors ?? 0) > 0 ? (
          <div class="hint alarm">{status?.health?.consecutiveErrors} consecutive step failures · {status?.health?.lastError?.slice(0, 180)}</div>
        ) : null}
        {offline && !offlineHold ? <div class="hint">Offline — no internet connection detected.</div> : null}
        {recovery?.phase === 'probing' && running ? (
          <div class="hint">
            Testing the waters — attempt {recovery.attempt} of {recovery.maxAttempts}.
          </div>
        ) : null}
        {!deviceHold?.alert && status?.state === 'halted' && status.haltReason != null ? (
          <div class="hint alarm" role="alert">
            {haltText(status.haltReason)}
          </div>
        ) : null}

        {/* what fires next — the prune's own subject while it drives the tab */}
        <div class="hero-what num">
          <span class="hw-k">Next</span>
          <Icon name="arrow-right-long" />
          <span class="hw-act">
            {pruneDrives ? (
              (prune?.upNext ?? null) !== null ? (
                <Fragment>
                  unfollow <b>{withAt(prune?.upNext ?? '')}</b>
                </Fragment>
              ) : (
                '—'
              )
            ) : next ? (
              <Fragment>
                {nextVerb} <b>{withAt(next.username)}</b>
              </Fragment>
            ) : (
              '—'
            )}
          </span>
          <span class="spacer" />
          <span class="rchip num">
            {!pruneDrives && next && next.ratio != null ? `r=${ratio(next.ratio)}` : '—'}
          </span>
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
