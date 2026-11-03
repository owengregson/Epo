/**
 * Attention copy (spec Appendix C.15.2, exhaustive over `KnownBlockKey`; "Prune" wording): one plain
 * sentence per key. An unknown key reads neutrally and shows its raw key only on a muted code line. Counts
 * come from the status (`recovery.maxAttempts`, the unconfirmed streak), never from copy.
 */
import type { Attention, KnownBlockKey } from '@/shared/attention';

const SIGN_IN = 'Instagram signed you out. Sign in on the Live tab, then press Start.';
const OTHER_ACCOUNT = 'A different Instagram account is signed in. Switch back on the Live tab, or press Start to continue with this one.';
const PAGE_STUCK = 'The Instagram page didn’t recover by itself. Check the Live tab, then press Start.';
const REFUSED = 'Instagram refused several actions in a row. Giving it time usually helps. Press Start when you’re ready.';
const NEW_SOURCE = 'Epo ran out of new people to find from your starting account. Choose a new one.';
const PRUNE_STOPPED = 'Pruning stopped early. Your previous check is kept. Try again from the Prune page.';
const TROUBLE = 'Epo had trouble starting and stopped its work. Diagnostics has details.';

/** Every key's sentence; the two keys with counts are filled in by `attentionSentence`. */
const SENTENCE: Readonly<Record<Exclude<KnownBlockKey, 'recovery-exhausted' | 'actions-unconfirmed'>, string>> = {
  'account-changed': OTHER_ACCOUNT, 'identity-changed': OTHER_ACCOUNT,
  'login-required': SIGN_IN, 'sentinel:logged-out': SIGN_IN,
  'account-identity-unavailable': 'Epo couldn’t confirm which account is signed in. Check the Live tab, then press Start.',
  'sentinel:challenge': 'Instagram wants to confirm it’s you. Follow its steps on the Live tab, then press Start.',
  'sentinel:action-blocked': 'Instagram has paused some of your account’s actions. Check the Live tab. Epo waits until you press Start.',
  'sentinel:ok': 'Epo stopped to check your session. Press Start to continue.',
  'rate-limited': REFUSED, 'blocked-repeatedly': REFUSED,
  'actions-failing': 'Several actions in a row didn’t go through. Check the Live tab, then press Start.',
  'adapter-drift': 'Instagram changed something Epo doesn’t recognise yet. An Epo update may fix this. See Settings › Advanced › Instagram compatibility.',
  'chain-exhausted': NEW_SOURCE, 'no-current-target': NEW_SOURCE,
  'seed-missing': 'Choose a starting account so Epo knows where to find people.',
  'seed-unresolved': 'Epo couldn’t open your starting account. Check the spelling, or choose another.',
  'runtime-error': 'Something unexpected stopped Epo. Press Start to try again.',
  'scan-failed': PRUNE_STOPPED, 'run-failed': PRUNE_STOPPED,
  'runtime-recovery-exhausted': 'The Instagram page needed several repairs in a short time. Check the Live tab, then press Start.',
  'tab-recovery-failed': PAGE_STUCK, 'wake-recovery-failed': PAGE_STUCK, 'wake-sentinel-failed': PAGE_STUCK,
  'wake-reconciliation-failed': PAGE_STUCK,
  'automatic-resume-failed': 'Epo couldn’t pick up where it left off. Press Start to continue.',
  'runtime-state-persist-failed': 'Epo couldn’t save its progress. Check that your disk has free space, then restart Epo.',
  'runtime-state-unreadable': 'Epo couldn’t read its saved progress. Your data is safe. Press Start to continue.',
  'startup-failed': TROUBLE, 'dashboard-recovery-exhausted': TROUBLE,
  'data-clear-in-progress': 'Clearing your data…',
};

export const UNKNOWN_ATTENTION = 'Something needs a look before Epo continues. Diagnostics has details.';
/** The reason line under every attention that holds scheduled work. */
export const SCHEDULES_WAIT = 'Scheduled work waits until you press Start.';

export interface AttentionCounts {
  /** `status.recovery.maxAttempts`, when the ladder reported one. */
  readonly maxAttempts: number | null;
  /** `status.actionsUnconfirmed`. */
  readonly unconfirmed: { readonly kind: 'follow' | 'unfollow'; readonly streak: number } | null;
}

export function attentionSentence(a: Attention, c: AttentionCounts): string {
  if (a.key === 'unknown') return UNKNOWN_ATTENTION;
  if (a.key === 'recovery-exhausted') {
    const breaks = c.maxAttempts === null ? '' : `, even after ${c.maxAttempts} breaks`;
    return `Instagram kept limiting actions${breaks}. Check the Live tab, then press Start.`;
  }
  if (a.key === 'actions-unconfirmed') {
    const u = c.unconfirmed;
    const what = u === null || u.streak <= 1
      ? `last ${u?.kind ?? 'action'}, so it waits`
      : `last ${u.streak} ${u.kind}s, so they wait`;
    return `Epo couldn’t confirm its ${what} until the next session. If it happens again, Epo takes a break.`;
  }
  return SENTENCE[a.key];
}

/** The muted code line, only for a key Epo does not know. */
export function attentionCode(a: Attention): string | null {
  return a.key === 'unknown' ? `Code: ${a.raw}` : null;
}
