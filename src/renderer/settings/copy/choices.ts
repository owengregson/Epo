/**
 * The Easy controls' words (spec §6.4, Appendix B.10): one word per concept, card lines with `{n}` filled
 * from `SettingsView.options`, and the confirm sheets. Prune is the user-facing word for cleanup.
 */
import type {
  ActivityLevel, AudienceFocus, AudienceSize, Caution, CleanupLevel, Consistency, DayShape, PaceCardId, Patience,
  Rhythm, WeeklyShape,
} from '@/shared/settings-intent';

export const PACE_COPY = {
  cards: {
    gentle: { title: 'Gentle', line: 'Light and relaxed.' },
    balanced: { title: 'Balanced', line: 'Steady growth with room to spare.' },
    faster: { title: 'Faster', line: 'More new people each day.' },
  } satisfies Readonly<Record<PaceCardId, { title: string; line: string }>>,
  metric: 'About {n} a day',
  foot: 'Follows, unfollows and approvals together.',
  range: 'Most days land between {lo} and {hi}.',
  safety: 'Epo’s own work never uses more than {p}% of the lowest daily follow limit Instagram is known to apply.',
  custom: 'Your own mix',
  customLine: 'About {n} a day. Set in Advanced.',
  feasibility: 'Your schedule is too short for this pace. Epo can fit about {n} a day into your active hours at a safe speed. Pick a slower pace, or shorten your quiet hours.',
  atLimitTitle: 'Run at the fullest pace?',
  atLimit: 'This runs at the low end of what Instagram is known to allow in a day. Some accounts get temporarily restricted at this pace. Continue?',
  atLimitYes: 'Use it anyway',
  atLimitNo: 'Keep current',
} as const;

/** Advanced intent rows: the words, the numbers come from the view. */
export const ACTIVITY_COPY = {
  minimal: 'Very light', light: 'Light', moderate: 'Moderate', active: 'Active', aggressive: 'Maximum',
} as const satisfies Readonly<Record<ActivityLevel, string>>;
export const CAUTION_COPY = { cautious: 'Careful', standard: 'Standard', bold: 'Quicker' } as const satisfies Readonly<Record<Caution, string>>;
export const CONSISTENCY_COPY = { clockwork: 'Even', natural: 'Typical', erratic: 'Varied' } as const satisfies Readonly<Record<Consistency, string>>;
export const WEEKLY_COPY = {
  uniform: 'Every day the same', realistic: 'Typical week', weekdays: 'Mostly weekdays', weekends: 'Mostly weekends',
} as const satisfies Readonly<Record<WeeklyShape, string>>;
export const INTENT_ROW_COPY = {
  activity: 'Activity level', caution: 'Caution', consistency: 'Consistency', weeklyShape: 'Weekly shape',
  wordMatch: 'Keyword matching',
} as const;

export const SCHEDULE_COPY = {
  shapes: {
    balanced: 'Through the day', morning: 'Mornings', evening: 'Evenings', nightowl: 'Late nights', business: 'Work hours',
  } satisfies Readonly<Record<DayShape, string>>,
  quiet: 'Quiet hours',
  quietLine: '{start} – {end} · from your schedule',
  quietCustomLine: '{start} – {end} · set by you',
  quietNone: 'No quiet hours',
  change: 'Change',
  follow: 'Follow my schedule (recommended)',
  own: 'Set my own',
  from: 'From',
  to: 'To',
  none: 'No quiet hours',
  quietHint: 'Epo does nothing on Instagram during quiet hours. Anything you start yourself still runs.',
  daysOff: 'Days off',
  daysOffHint: 'Epo takes these days off completely (up to {max} days a week). Your daily limits don’t move to other days.',
  allOff: 'Seven days off would stop Epo. Use Stop in the left panel instead.',
  sessions: 'Session style',
  rhythm: {
    trickle: 'Many short visits', sessions: 'A few regular sessions', bursts: 'A couple of longer sessions',
  } satisfies Readonly<Record<Rhythm, string>>,
  rhythmLine: '{a}–{b} a day',
} as const;

export const AUDIENCE_COPY = {
  seed: 'Starting account',
  seedHelp: 'Epo finds people through this account’s followers. Pick one whose followers look like your audience.',
  size: 'Account size',
  sizes: {
    small: 'Smaller accounts', everyday: 'Everyday accounts', larger: 'Larger accounts',
  } satisfies Readonly<Record<AudienceSize, string>>,
  sizeLine: { small: 'Up to {max}', everyday: '{min}–{max}', larger: 'Up to {max}' } satisfies Readonly<Record<AudienceSize, string>>,
  sizeHint: 'Very large accounts rarely follow back.',
  prefer: 'Prefer',
  focus: {
    likely: 'People likely to follow you back', wide: 'Reach more people (fewer follow back)',
  } satisfies Readonly<Record<AudienceFocus, string>>,
  custom: 'Set in Advanced',
  private: 'Give private accounts a small edge',
  preferHint: 'Epo favours accounts that follow about as many people as follow them, and private accounts. They follow back most often.',
  requests: 'Follow requests',
  accept: 'Accept follow requests automatically',
  acceptHelp: 'Each accepted request counts toward your daily and hourly limits.',
  privatePill: 'Your account is private',
  publicPill: 'Your account is public',
} as const;

export const UNFOLLOW_COPY = {
  wait: 'If someone doesn’t follow back, unfollow them after',
  waits: { quick: '{n} days', normal: '{n} days', patient: '1 week' } satisfies Readonly<Record<Patience, string>>,
  mutuals: 'When someone follows you back',
  rotate: 'Unfollow them after {hold} days. Most keep following you, and your following count stays low.',
  keep: 'Keep following them. Your following count grows over time.',
  own: 'People you followed yourself',
  ownHelp: 'Accounts Epo didn’t follow for you.',
  cleanup: {
    off: 'Leave them alone', trickle: 'Prune those who don’t follow back, a few a day', steady: '…more each day',
  } satisfies Readonly<Record<CleanupLevel, string>>,
  confirmTitle: 'Prune people you followed yourself?',
  confirm: 'Epo found {n} accounts you follow that don’t follow you back (checked {ago}). {k} of them are protected and will be kept. Epo will unfollow the rest a few at a time, mixed into its normal sessions, inside your daily limits.',
  confirmNoCensus: 'Epo will first check who follows you back (reading only), then start slowly.',
  confirmYes: 'Turn on',
  confirmReview: 'Review the list',
  confirmNo: 'Cancel',
} as const;

export const APP_COPY = {
  practice: 'Practice mode',
  practiceHelp: 'Epo plans and works as usual but never presses Follow, Unfollow or Accept. It still opens profiles and lists to read them.',
  practiceOffTitle: 'Turn off practice mode?',
  practiceOff: 'Epo will start following and unfollowing for real the next time it runs.',
  practiceOffYes: 'Turn off',
  practiceOffNo: 'Keep practicing',
  replay: 'Replay the intro',
  reset: 'Reset to recommended',
  resetTitle: 'Reset to recommended?',
  resetBody: 'This changes: {lines}.',
  resetNothing: 'Everything already matches the recommendation.',
  resetKept: 'Your starting account, protection list ({a} accounts, {w} keywords), practice mode and Boost preferences stay as they are.',
  resetLoosens: '⚠ Epo will unfollow more',
  resetYes: 'Reset',
  resetNo: 'Keep mine',
  clear: 'Clear data & log out',
  clearHelp: 'Removes Epo’s data about your account and signs you out of Instagram. Your settings and protection list are kept.',
  clearTitle: 'Clear all data and log out?',
  clearBody: 'This permanently removes Epo’s data about your account and signs you out of Instagram. Your settings and protection list are kept. This cannot be undone.',
  clearYes: 'Clear & log out',
  startOver: 'Start over from the older version’s settings',
  startOverHelp: 'Replace these settings with the ones the older version of Epo saved.',
  startOverTitle: 'Start over from the older version’s settings?',
  startOverBody: 'This replaces your current settings with the ones the older version saved. Your protection list will need a review.',
  startOverYes: 'Start over',
  cancel: 'Cancel',
} as const;
