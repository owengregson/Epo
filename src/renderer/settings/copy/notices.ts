/**
 * The one-time notices and recovery sheets (Appendix B.10, spec §6.6, §6.10, §7.6): exhaustive over the
 * view's notice kinds, `{name}` filled from the notice's data or the view. Prune wording for cleanup.
 */
import type { SettingsNotice } from '@/shared/settings-view';

export const NOTICE_COPY = {
  'bio-words-widened': 'Your bio keywords ({words}) now protect everyone you follow, not only people who follow you back.',
  'verified-kept': 'Verified accounts are now kept by default.',
  'quiet-hours-derived': 'Epo now keeps quiet hours overnight ({start}–{end}, from your schedule). Change them in Settings → When Epo works.',
  'quiet-hours-from-active-hours': 'Your active hours became quiet hours outside them. Change them in Settings → When Epo works.',
  'cleanup-own-follows-off': 'Pruning people you followed yourself is now its own setting, and it’s off.',
  'cleanup-scheduled-now-gradual': 'Scheduled pruning now happens gradually inside Epo’s sessions.',
  'cleanup-trickle-from-schedule': 'Your scheduled pruning now runs a few at a time inside sessions.',
  'value-clamped': 'A value from the older version was outside the safe range, so Epo uses {to} instead of {from}.',
  'list-items-dropped': 'Some entries in your older protection lists couldn’t be read ({count}). Check Protection.',
  'legacy-pacing-retired': 'Steady intervals is retired. Epo now paces every action from your daily plan. For more regular days, Consistency is set to Even.',
  'faster-value-dropped': 'A setting from the older version would have made Epo faster than its own plan, so it was left out.',
  migrated: 'Your settings moved to the new format. Everything you could set before is still here.',
  'restored-backup': 'Epo couldn’t read your settings file and restored it from a saved copy.',
  'unreadable-defaults': 'Epo couldn’t read your settings and found no saved copy, so it started from the recommended ones.',
  'needs-review': 'Check your protection list before Epo unfollows anyone. Epo restored it from a saved copy.',
  'older-version-changed': 'Settings were changed in an older version of Epo: {accounts} protected accounts and {words} keywords were added there. (Removals made there aren’t applied.)',
  'override-stale': '{count} values you set yourself no longer match Epo’s recommendation.',
  'everything-in-advanced': 'Everything you could set before is in Advanced.',
  'migration-refused': 'Epo couldn’t move your settings to the new format, so it is running on your previous settings as they were (practice mode and your protection lists included). Unfollows wait until this is sorted out.',
} as const satisfies Readonly<Record<SettingsNotice['kind'], string>>;

export const NOTICE_ACTIONS = {
  dismiss: 'Dismiss',
  reviewProtection: 'Review protection',
  protectionRight: 'My protection list is right',
  unavailable: 'Epo couldn’t read your settings and found no saved copy, so it won’t unfollow anyone until you check Protection.',
  addThem: 'Add them here',
  ignore: 'Ignore',
  review: 'Review',
  tryAgain: 'Try again',
  startRecommended: 'Start from recommended settings',
  startRecommendedTitle: 'Start from recommended settings?',
  startRecommendedBody: 'Epo writes fresh settings from the recommended choices. Your protection lists and practice mode are kept, and your protection list will need a review.',
  startRecommendedYes: 'Start from recommended',
  cancel: 'Cancel',
} as const;
