/** @jsx h */
import { Fragment, h } from 'preact';
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
import type { EpoStatus, Settings } from '@/types';

type Step = NonNullable<EpoStatus['lastStep']>;
type Sentinel = NonNullable<EpoStatus['lastSentinel']>;
type ParkReason = NonNullable<EpoStatus['parkReason']>;

/** Readable phrase for what the engine's last step did. */
export function stepLabel(step: Step): string {
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
    case 'waited-session':
      return 'waited · session';
    case 'waited-ceiling':
      return 'waited · ceiling';
    case 'recovering':
      return 'backing off';
    case 'halted':
      return 'halted';
    case 'aborted':
      return 'aborted';
    default:
      return 'idle';
  }
}

/** Epoch ms → local wall clock "8:00" / "14:10" (resume times in hold copy). */
function wallTime(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Whether two epochs fall on the same local calendar day. */
function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Big headline word for a hold state (the offline hold's "Offline" slot). */
export function parkHeadline(reason: ParkReason): string {
  switch (reason) {
    case 'daily-ceiling':
      return 'Plan done';
    case 'velocity':
      return 'Pacing';
    case 'enrich-backoff':
    case 'recovery':
      return 'Backing off';
    default:
      return 'Resting'; // active-hours and between-sessions are both a rest
  }
}

/** Centered ring glyph for a hold state (the offline hold's "wifi" slot). */
function parkGlyph(reason: ParkReason): string {
  switch (reason) {
    case 'daily-ceiling':
      return 'calendar-check';
    case 'velocity':
      return 'gauge-high';
    case 'enrich-backoff':
    case 'recovery':
      return 'arrows-rotate';
    case 'session':
      return 'hourglass-half';
    default:
      return 'moon';
  }
}

/** One-line caption under the headline: why, and when work resumes. */
export function parkCaption(
  reason: ParkReason,
  until: number,
  now: number,
  done: number,
  planned: number | null,
): string {
  const at = `${sameLocalDay(until, now) ? '' : 'tomorrow '}${wallTime(until)}`;
  switch (reason) {
    case 'active-hours':
      return `outside active hours · resumes ${at}`;
    case 'daily-ceiling':
      return `today's plan is done (${done}/${planned ?? done}) · resumes ${at}`;
    case 'session':
      return `between sessions · next session ${at}`;
    case 'velocity':
      return `easing off this hour · resumes ${at}`;
    case 'recovery':
      // Fallback when the status carries no recovery detail (attempt numbers
      // live in `recoveryHoldCaption`, preferred by the card).
      return `recent actions aren't landing · retrying ~${at}`;
    default:
      return `after fetch trouble · retrying ${at}`;
  }
}

/** Recovery-hold caption with the ladder's rung — the card's preferred copy. */
export function recoveryHoldCaption(
  rec: { attempt: number; maxAttempts: number; resumeAt: number | null },
  now: number,
): string {
  const at =
    rec.resumeAt != null
      ? ` ~${sameLocalDay(rec.resumeAt, now) ? '' : 'tomorrow '}${wallTime(rec.resumeAt)}`
      : ' soon';
  return `recent actions aren't landing · retrying${at} (attempt ${rec.attempt} of ${rec.maxAttempts})`;
}

/**
 * Hold chip copy: "in 12:34" (or "in 2h 05m" for long holds) while the
 * deadline is pending — "resuming…" once it passes while the hold is still
 * displayed, so an expired hold never sits on a dead "in 0:00" until the
 * engine's next push swaps the layout.
 */
export function holdChipText(until: number, now: number, remainingSec: number): string {
  if (remainingSec <= 0) return 'resuming…';
  return `in ${remainingSec >= 3600 ? durationHm(until - now) : mmss(remainingSec)}`;
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
    case 'recovery-exhausted':
      return 'Halted — actions kept failing after 3 long backoffs (~4h). This is not a normal rate limit; check the session in the Instagram tab, then press Start to try again.';
    case 'adapter-drift':
      return "Halted — Instagram's interface appears to have changed. Check for an Epo update.";
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
            replaces the countdown — no fabricated numbers while offline.
            A long park (outside active hours, plan done, between sessions)
            renders the same hold layout: calm headline, why, when it resumes,
            and a live countdown chip fed by the engine's real park deadline. */}
        <div class="hero-next">
          <RadialRing
            frac={offlineHold ? 0 : parkHold ? hold.frac : cd.frac}
            glyph={offlineHold ? 'wifi' : parkHold ? parkGlyph(parkHold.reason) : 'bolt'}
          />
          <div class="hn-main">
            {offlineHold ? (
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
                <div class="hn-count num">{running && cd.active ? mmss(cd.remainingSec) : '—'}</div>
                <div class="hn-cap">until next action</div>
              </Fragment>
            )}
          </div>
          {offlineHold ? (
            <span class="rchip">Reconnecting…</span>
          ) : parkHold ? (
            <span class="rchip num">{holdChipText(parkHold.until, now, hold.remainingSec)}</span>
          ) : null}
        </div>
        {offline && !offlineHold ? <div class="hint">Offline — no internet connection detected.</div> : null}
        {recovery?.phase === 'probing' && running ? (
          <div class="hint">
            Testing the waters — attempt {recovery.attempt} of {recovery.maxAttempts}.
          </div>
        ) : null}
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
