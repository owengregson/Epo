/**
 * The Prune page's words (spec §7.8, §8.4, Appendix E.2, the recorded answer Q28): the feature is Prune;
 * protection is read here and edited in Settings; `{name}` slots come from the projections.
 */
import type { ProtectedBy } from '@/shared/unfollow-protection';

export const PRUNE_COPY = {
  title: 'Prune',
  lead: 'Check who follows you back, review who doesn’t, and unfollow them at a safe pace.',
  allowance: 'Today’s prune allowance',
  allowanceLine: '{used} of {n} used',
  allowanceUnknown: '—',
  pruneNow: 'Prune now',
  pruneNowTitle: 'Prune now?',
  pruneNowBody: 'Unfollow {n} accounts that don’t follow you back? Protected accounts are kept, and today’s prune allowance still applies.',
  pruneNowBodyNoList: 'Epo checks who follows you back, then unfollows the accounts that don’t. Protected accounts are kept, and today’s prune allowance still applies.',
  pruneNowYes: 'Prune now',
  pruneNowNo: 'Keep them',
  gradual: 'Unfollow these gradually',
  gradualOn: 'Epo prunes these a few at a time inside its sessions.',
  gradualChange: 'Change in Settings',
  gradualSaved: 'Epo will prune these a few at a time inside its sessions.',
  notSaved: 'Couldn’t save — nothing was changed.',
  tooLarge: 'Your followers list is too long to check in full, so Epo won’t prune people you followed yourself. Everything else works as usual.',
  showProtected: 'Show protected ({n})',
  hideProtected: 'Hide protected',
  protectedBadge: 'Protected · {why}',
  bioUnread: 'Bio not read yet — checked before any unfollow',
  listFailed: 'Couldn’t load the list Epo saved.',
  tryAgain: 'Try again',
  protection: 'Protection',
  protectionLine: '{a} accounts and {w} bio keywords are protected.',
  protectionVerified: 'Verified accounts are kept too.',
  protectionNever: 'Epo never prunes anyone protected.',
  protectionEdit: 'Edit in Settings',
  protectionUnknown: 'Your protection list appears once your settings load.',
  candidates: 'Candidates',
  toPrune: '{n} to prune',
  scanFirst: 'Run a scan to list accounts that don’t follow you back.',
  scanning: 'Scanning…',
  everyone: 'Everyone you follow follows you back, or is protected.',
  notFollowingBack: 'not following back',
  capped: 'Showing the first {max} of {n} — the run covers them all.',
} as const;

export const PROTECTED_WHY = {
  account: 'in your list', verified: 'verified', 'bio-word': 'bio keyword', source: 'an account Epo explores through',
} as const satisfies Readonly<Record<ProtectedBy, string>>;

/** A refused scan or run, in plain words. */
export const PRUNE_REFUSAL = {
  'growth-running': 'Stop the growth engine before pruning.',
  'growth-busy': 'The growth engine is finishing a step — try again in a moment.',
  'prune-running': 'A prune scan or run is already active.',
  'not-logged-in': 'Not signed in — sign in on the Live tab first.',
  'boost-active': 'Pruning waits during Boost. End Boost to prune now.',
} as const satisfies Readonly<Record<string, string>>;
