/**
 * Why a loop halted, as a closed union. The STATUS surface still carries a
 * string (`EngineStatus.haltReason` / `PruneStatus.haltReason`) — renderer and
 * composition root match on it — so {@link haltReasonKey} is the one place a
 * reason becomes text, and adding a variant is a tsc error until it is mapped.
 *
 * Two surfaces, one truth: {@link isRateLimitHalt} decides over the TYPED union
 * and {@link isRateLimitHaltKey} answers the same question about a wire string —
 * the string set is DERIVED from the typed predicate over {@link ALL_HALT_REASONS},
 * so the two can never drift.
 */

import type { SentinelStatus } from '../adapter/sentinel';
import { absurd } from './absurd';

export type HaltReason =
  | { kind: 'runtime-error' }
  | { kind: 'identity-changed' }
  | { kind: 'reconciliation-failed' }
  /** A verified auth block: only the user can repair the session. */
  | { kind: 'sentinel'; status: SentinelStatus }
  /** The chain found no next hop and the dead-end self-heal found nothing to revive. */
  | { kind: 'chain-exhausted' }
  /** Every recovery rung was served and the wall did not lift. */
  | { kind: 'recovery-exhausted' }
  /** Two drift-classified windows with clean tab diagnostics: waiting cannot fix it. */
  | { kind: 'adapter-drift' }
  /** No seed configured — there is nothing safe to do without a target. */
  | { kind: 'seed-missing' }
  /** The configured seed could not be resolved to a pk. */
  | { kind: 'seed-unresolved' }
  /** Defensive: the loop reached the action gate with no current target. */
  | { kind: 'no-current-target' }
  /** Instagram's own response refused the mutation as throttling. */
  | { kind: 'rate-limited' }
  /** Consecutive failed actions: the machinery or the account is broken. */
  | { kind: 'actions-failing' }
  /** Consecutive blocked actions: Instagram is pushing back persistently. */
  | { kind: 'blocked-repeatedly' }
  /** A prune run's internal scan failed (the previous census is retained). */
  | { kind: 'scan-failed' }
  /** A prune run failed mid-loop for an unexpected reason. */
  | { kind: 'run-failed' };

/** The sentinel statuses a `{ kind: 'sentinel' }` halt may carry. */
const SENTINEL_STATUSES = ['ok', 'challenge', 'logged-out', 'action-blocked'] as const;

/**
 * Every inhabitant of {@link HaltReason} — the enumeration the derived string
 * sets and the round-trip tests are built from. The two `_exhaustive` witnesses
 * below make an unlisted variant (or a new sentinel status) a tsc error.
 */
export const ALL_HALT_REASONS: readonly HaltReason[] = [
  { kind: 'runtime-error' },
  { kind: 'identity-changed' },
  { kind: 'reconciliation-failed' },
  ...SENTINEL_STATUSES.map((status): HaltReason => ({ kind: 'sentinel', status })),
  { kind: 'chain-exhausted' },
  { kind: 'recovery-exhausted' },
  { kind: 'adapter-drift' },
  { kind: 'seed-missing' },
  { kind: 'seed-unresolved' },
  { kind: 'no-current-target' },
  { kind: 'rate-limited' },
  { kind: 'actions-failing' },
  { kind: 'blocked-repeatedly' },
  { kind: 'scan-failed' },
  { kind: 'run-failed' },
];

/** Compile-time proof that {@link ALL_HALT_REASONS} covers every kind/status. */
type ListedKind =
  | 'runtime-error'
  | 'identity-changed'
  | 'reconciliation-failed'
  | 'sentinel'
  | 'chain-exhausted'
  | 'recovery-exhausted'
  | 'adapter-drift'
  | 'seed-missing'
  | 'seed-unresolved'
  | 'no-current-target'
  | 'rate-limited'
  | 'actions-failing'
  | 'blocked-repeatedly'
  | 'scan-failed'
  | 'run-failed';
type _UncoveredKind = Exclude<HaltReason['kind'], ListedKind>;
type _UncoveredStatus = Exclude<SentinelStatus, (typeof SENTINEL_STATUSES)[number]>;
const _exhaustiveKinds: _UncoveredKind[] = [];
const _exhaustiveStatuses: _UncoveredStatus[] = [];
void _exhaustiveKinds;
void _exhaustiveStatuses;

/** The wire/display string for a reason — the historical vocabulary, unchanged. */
export function haltReasonKey(reason: HaltReason): string {
  switch (reason.kind) {
    case 'sentinel':
      return `sentinel:${reason.status}`;
    case 'chain-exhausted':
    case 'runtime-error':
    case 'identity-changed':
    case 'reconciliation-failed':
    case 'recovery-exhausted':
    case 'adapter-drift':
    case 'seed-missing':
    case 'seed-unresolved':
    case 'no-current-target':
    case 'rate-limited':
    case 'actions-failing':
    case 'blocked-repeatedly':
    case 'scan-failed':
    case 'run-failed':
      return reason.kind;
    default:
      return absurd(reason);
  }
}

/**
 * Whether a halt means "Instagram is rate-limiting this account" — the predicate
 * the scheduled-prune cool-down gates on, so the set lives here rather than as
 * string literals at the call sites. An auth sentinel (`challenge`,
 * `logged-out`) is NOT a rate limit: only the user can repair those.
 */
function rateLimited(reason: HaltReason): boolean {
  switch (reason.kind) {
    case 'sentinel':
      return reason.status === 'action-blocked';
    case 'recovery-exhausted':
    case 'rate-limited':
    case 'blocked-repeatedly':
      return true;
    case 'chain-exhausted':
    case 'runtime-error':
    case 'identity-changed':
    case 'reconciliation-failed':
    case 'adapter-drift':
    case 'seed-missing':
    case 'seed-unresolved':
    case 'no-current-target':
    case 'actions-failing':
    case 'scan-failed':
    case 'run-failed':
      return false;
    default:
      return absurd(reason);
  }
}

/** The DERIVED wire-string set — never hand-listed (see {@link isRateLimitHaltKey}). */
const RATE_LIMIT_HALT_KEYS: ReadonlySet<string> = new Set(
  ALL_HALT_REASONS.filter(rateLimited).map(haltReasonKey),
);

export function isRateLimitHalt(reason: HaltReason): boolean {
  return rateLimited(reason);
}

/**
 * The wire-string form of {@link isRateLimitHalt}: whether a serialized halt key
 * (`EngineStatus.haltReason`) means Instagram is throttling this account.
 */
export function isRateLimitHaltKey(key: string | null): boolean {
  return key !== null && RATE_LIMIT_HALT_KEYS.has(key);
}
