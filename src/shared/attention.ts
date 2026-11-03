/**
 * Attention (spec §12.3, Appendix C.1): every persisted runtime-block key and every halt key, classified to
 * the action that resolves it. An unknown key gets neutral handling: its raw key is shown only as "Code: …"
 * and in Diagnostics, never as the sentence. Pure and renderer-safe.
 */

export const KNOWN_BLOCK_KEYS = [
  'account-changed', 'login-required', 'account-identity-unavailable', 'automatic-resume-failed',
  'tab-recovery-failed', 'wake-recovery-failed', 'wake-sentinel-failed', 'wake-reconciliation-failed',
  'runtime-recovery-exhausted', 'runtime-state-persist-failed', 'runtime-state-unreadable',
  'startup-failed', 'dashboard-recovery-exhausted', 'data-clear-in-progress',
  // The halt vocabulary: parity with haltReasonKey(ALL_HALT_REASONS) is a test.
  'runtime-error', 'identity-changed', 'sentinel:ok', 'sentinel:challenge',
  'sentinel:logged-out', 'sentinel:action-blocked', 'chain-exhausted', 'recovery-exhausted', 'adapter-drift',
  'seed-missing', 'seed-unresolved', 'no-current-target', 'rate-limited', 'actions-failing',
  'blocked-repeatedly', 'scan-failed', 'run-failed',
  // The unconfirmed-actions breaker's attention: not a runtime block, so schedules keep running.
  'actions-unconfirmed',
] as const;

export type KnownBlockKey = (typeof KNOWN_BLOCK_KEYS)[number];

/** What an attention asks of the user. */
export type AttentionAction =
  | 'start' | 'show-live' | 'choose-seed' | 'check-update' | 'open-prune' | 'diagnostics' | 'restart-app' | 'wait';

export interface Attention {
  readonly key: KnownBlockKey | 'unknown';
  /** The key as it arrived: shown only as "Code: {raw}" when unknown, and in Diagnostics. */
  readonly raw: string;
  readonly action: AttentionAction;
  /** A runtime block holds scheduled work until the user presses Start. */
  readonly blocksSchedules: boolean;
}

const ACTION: Readonly<Record<KnownBlockKey, AttentionAction>> = {
  'account-changed': 'show-live', 'identity-changed': 'show-live', 'login-required': 'show-live',
  'sentinel:logged-out': 'show-live', 'account-identity-unavailable': 'show-live', 'sentinel:challenge': 'show-live',
  'sentinel:action-blocked': 'show-live', 'sentinel:ok': 'start', 'rate-limited': 'start', 'blocked-repeatedly': 'start',
  'recovery-exhausted': 'show-live', 'actions-failing': 'show-live', 'adapter-drift': 'check-update',
  'chain-exhausted': 'choose-seed', 'no-current-target': 'choose-seed', 'seed-missing': 'choose-seed',
  'seed-unresolved': 'choose-seed', 'runtime-error': 'start', 'scan-failed': 'open-prune', 'run-failed': 'open-prune',
  'actions-unconfirmed': 'wait', 'runtime-recovery-exhausted': 'show-live', 'tab-recovery-failed': 'show-live',
  'wake-recovery-failed': 'show-live', 'wake-sentinel-failed': 'show-live', 'wake-reconciliation-failed': 'show-live',
  'automatic-resume-failed': 'start', 'runtime-state-persist-failed': 'restart-app', 'runtime-state-unreadable': 'start',
  'startup-failed': 'diagnostics', 'dashboard-recovery-exhausted': 'diagnostics', 'data-clear-in-progress': 'wait',
};

const KNOWN: ReadonlySet<string> = new Set(KNOWN_BLOCK_KEYS);

export function isKnownBlockKey(raw: string): raw is KnownBlockKey {
  return KNOWN.has(raw);
}

/** The typed attention for a raw block or halt key. */
export function classifyBlock(raw: string): Attention {
  if (!isKnownBlockKey(raw)) return { key: 'unknown', raw, action: 'diagnostics', blocksSchedules: true };
  return { key: raw, raw, action: ACTION[raw], blocksSchedules: raw !== 'actions-unconfirmed' };
}
