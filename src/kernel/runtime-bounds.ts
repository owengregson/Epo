/**
 * Tier 1 — the main process's runtime guardrails (spec §17.8–§17.9): the repair budget, dashboard recovery,
 * the rotating runtime log, the failed-startup drain, RuntimeHealth, the origin settle and the landing press.
 * None is Instagram-facing pacing; each bounds a failure mode. Layering: kernel siblings only.
 */

import { MS_PER_MINUTE, MS_PER_SECOND } from './units';

/** Bytes per kibibyte (a unit, not a dial). */
const KIB = 1024;

export const RUNTIME_BOUNDS = {
  /** Guards: endless machinery repairs; three tab repairs inside the window, then the run blocks. */
  REPAIR_LIMIT: 3,
  /** Guards: watchdog restarts ageing out before the budget exhausts; spans several watchdog windows. */
  REPAIR_WINDOW_MS: 60 * MS_PER_MINUTE,
  /** Guards: an unbounded incident list in the run-intent file; the newest are kept. */
  INCIDENTS_KEPT: 50,
  /** Guards: a hung dashboard load leaving an invisible run; the load counts as failed past this. */
  DASHBOARD_LOAD_MS: 30 * MS_PER_SECOND,
  /** Guards: a crashing dashboard reloading forever; past these reloads in the window, work stops. */
  DASHBOARD_RELOADS: 3,
  /** Guards: reloads counted forever; only those inside this window count against the budget. */
  DASHBOARD_RELOAD_WINDOW_MS: 10 * MS_PER_MINUTE,
  /** Guards: back-to-back reloads; the n-th reload waits n steps. */
  DASHBOARD_RELOAD_STEP_MS: MS_PER_SECOND,
  /** Guards: diagnostics filling the disk; the active log rotates past this size. */
  LOG_MAX_BYTES: 2 * KIB * KIB,
  /** Guards: unbounded rotation; generations kept, the active file included. */
  LOG_FILES: 4,
  /** Guards: one oversized payload; a longer line keeps only its cut message. */
  LOG_LINE_BYTES: 32 * KIB,
  /** Guards: a long message inside a cut line. */
  LOG_MESSAGE_CHARS: 2_000,
  /** Guards: memory while the disk is slow; past this the queue drops lines and counts them. */
  LOG_PENDING_BYTES: 256 * KIB,
  /** Guards: a disk write per line; lines batch for this long. */
  LOG_FLUSH_MS: MS_PER_SECOND,
  /** Guards: a failed startup that never exits; its cleanup is abandoned past this. */
  STARTUP_CLEANUP_MS: 15 * MS_PER_SECOND,
  /** Guards: a failed startup waiting on a stuck disk; the log drain is abandoned past this. */
  STARTUP_LOG_DRAIN_MS: 2 * MS_PER_SECOND,
  /** Guards: an unbounded error string persisted with the lifecycle health. */
  HEALTH_ERROR_CHARS: 2_000,
  /** Guards: retrying a loop that keeps failing; this many consecutive errors end the run. */
  HEALTH_ERROR_STREAK: 5,
  /** Guards: a harness read racing the page's own first fetches after it lands on the origin. */
  ORIGIN_SETTLE_MS: 2 * MS_PER_SECOND,
  /** Guards: a just-quit instance still holding the legacy data directory; renames retried this often. */
  USERDATA_RENAME_RETRIES: 5,
  /** Guards: a busy retry loop before the window exists; the blocking wait between renames. */
  USERDATA_RENAME_RETRY_MS: 400,
  /** Guards: pressing a profile link that does not navigate forever; the landing presses at most this often. */
  PROFILE_LAND_CLICK_ATTEMPTS: 2,
} as const;
