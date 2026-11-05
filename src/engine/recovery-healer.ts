/**
 * The recovery requeue-healer: a ladder reset just CLOSED a systemic-incident
 * window, so the `abandoned` verdicts that window minted were spurious — the
 * machinery was broken, not the records. Requeue them ONCE, store-only, no IG
 * traffic. See `docs/adr/0201-recovery-ladder.md` for why the window is widened
 * and capped rather than replayed wholesale.
 */

import { RECOVERY as RECOVERY_TIMING } from '../timing/config';
import * as log from '../utils/logger';
import type { RecoveryIncident } from './recovery';

/** The store slice the healer touches (both calls are store-only). */
export interface HealerStore {
  healAbandonedInWindow(opts: {
    windowStartMs: number;
    windowEndMs: number;
    cap: number;
    now: number;
  }): { healed: number; toQueued: number; toUnfollowQueued: number; skippedUnworkable: number };
  setRecoveryLastIncident(raw: string | null): void;
}

export interface HealResult {
  healed: number;
  toQueued: number;
  toUnfollowQueued: number;
  skippedUnworkable: number;
  /** The window actually healed (the incident's, widened by the entry grace). */
  window: { from: number; to: number };
}

/**
 * Requeue the closed incident window's burn. The window starts
 * {@link RECOVERY_TIMING.HEAL_GRACE_MS} BEFORE the ladder entry so the entry
 * streak's own pre-ladder burn is covered, and the persisted incident record is
 * amended with the outcome so the heal itself is on the record.
 */
export function healIncidentWindow(
  store: HealerStore,
  incident: RecoveryIncident,
  now: number,
): HealResult {
  const windowStartMs = incident.enteredAt - RECOVERY_TIMING.HEAL_GRACE_MS;
  const result = store.healAbandonedInWindow({
    windowStartMs,
    windowEndMs: incident.resolvedAt,
    cap: RECOVERY_TIMING.HEAL_MAX_RECORDS,
    now,
  });
  store.setRecoveryLastIncident(
    JSON.stringify({ ...incident, healed: { count: result.healed, at: now } }),
  );
  const out: HealResult = { ...result, window: { from: windowStartMs, to: incident.resolvedAt } };
  log.info('engine: recovery healer requeued the closed incident window burn', out);
  return out;
}
