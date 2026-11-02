/**
 * Live Status copy — every phrase the hero can render, as pure functions of the
 * status projection. Split out of the card so the wording is testable without a
 * DOM and so the component keeps only layout.
 */

import { durationHm, mmss } from '@/renderer/lib/format';
import { sentinelLabel } from '@/renderer/lib/labels';
import type { EpoStatus } from '@/types';

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
    case 'reconcile-backoff':
    case 'recovery':
      return 'Backing off';
    default:
      return 'Resting'; // active-hours and between-sessions are both a rest
  }
}

/** Centered ring glyph for a hold state (the offline hold's "wifi" slot). */
export function parkGlyph(reason: ParkReason): string {
  switch (reason) {
    case 'daily-ceiling':
      return 'calendar-check';
    case 'velocity':
      return 'gauge-high';
    case 'enrich-backoff':
    case 'reconcile-backoff':
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
    case 'reconcile-backoff':
      return `couldn't read follow-backs · retrying ${at}`;
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

/** The "last action" sub-line: what the step was, and what the sentinel saw. */
export function lastStepSummary(step: Step | null, sentinel: Sentinel | null): string {
  if (step === null) return '—';
  return sentinel === null
    ? stepLabel(step)
    : `${stepLabel(step)} · sentinel ${sentinelLabel(sentinel)}`;
}

/**
 * Readable sentence for a GROWTH halt reason. The cases are exactly what
 * `HaltReason` can serialize for this loop (`src/engine/halt-reason.ts`); the
 * prune loop has its own halts and its own copy in PruneRunCard. Anything
 * unmapped is shown verbatim rather than swallowed.
 */
export function haltText(reason: string): string {
  if (reason.startsWith('sentinel:')) {
    return `Halted — Instagram flagged the session (${reason.slice('sentinel:'.length)}). Resolve it in the tab, then start again.`;
  }
  switch (reason) {
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
