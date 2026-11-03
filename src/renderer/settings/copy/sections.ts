/**
 * The Settings copy deck (Appendix B.10, with the recorded answer that the cleanup feature reads "Prune").
 * `{name}` marks a value filled from the view, the facts or the plan: no number lives in copy. Neutral
 * wording throughout; risk is a share of Instagram's known limits, never a warning label.
 */
import type { SectionId } from '@/shared/settings-params';

export interface SectionCopy {
  readonly title: string;
  /** The one-sentence question or lead under the title. */
  readonly question?: string;
  /** The rail glyph. */
  readonly icon: string;
}

export const SECTION_COPY = {
  pace: { title: 'Growth pace', question: 'How quickly should Epo grow your account?', icon: 'gauge-high' },
  schedule: { title: 'When Epo works', question: 'When should Epo be active?', icon: 'moon' },
  audience: { title: 'Who to follow', icon: 'bullseye' },
  unfollow: {
    title: 'Unfollowing',
    question: 'Epo unfollows people it followed who didn’t follow back, so your following count stays healthy. Everyone in Protection is always kept.',
    icon: 'user-minus',
  },
  protection: {
    title: 'Protection',
    question: 'Epo never unfollows anyone protected here — not in its daily cycle, not when pruning, not during Boost — whether or not they follow you back.',
    icon: 'shield-halved',
  },
  boost: { title: 'Boost', icon: 'bolt' },
  app: { title: 'Practice & app', icon: 'circle-play' },
  timing: { title: 'Timing', question: 'Every wait Epo uses comes from today’s plan. These rows only make it slower.', icon: 'stopwatch' },
  explore: { title: 'Finding new people', icon: 'magnifying-glass-chart' },
  limits: { title: 'Limits & reading', question: 'What Epo reads in a day and the limits it works inside. Read only.', icon: 'lock' },
  technical: { title: 'Under the hood', question: 'Every number Epo’s plan is built from, where it comes from, and why it is what it is.', icon: 'sliders' },
  diagnostics: { title: 'Diagnostics', icon: 'wave-square' },
} as const satisfies Readonly<Record<SectionId, SectionCopy>>;

export const STAGE_COPY = {
  title: 'Settings',
  easy: 'Easy',
  advanced: 'Advanced',
  modeHelp: 'Advanced shows every number Epo uses and lets you set any of them yourself.',
  advancedRail: 'Advanced',
  search: 'Search settings',
  searchEmpty: 'Nothing matches “{q}”.',
  searchInAdvanced: 'In Advanced → {section}',
  searchCount: '{n} found',
  searchKey: 'Press / to search',
  show: 'Show',
  loadFailed: 'Couldn’t load your settings.',
  retry: 'Retry',
  loading: 'Loading your settings…',
  summary: 'Today: about {n} actions in {s} sessions',
  summaryNext: 'next session at {time}',
  summaryNotBuilt: 'Today’s plan appears once Epo has opened your account.',
  fineTuned: 'Fine-tuned in Advanced ({n})',
  review: 'Review',
  useRecommended: 'Use recommended',
  fineTune: 'Fine-tune',
  sectionRecommended: 'Use recommended for this section',
  setByYou: '{n} set by you',
} as const;

export const SAVE_COPY = {
  idle: 'All changes saved',
  saving: 'Saving…',
  saved: 'Saved',
  undo: 'Undo',
  adjusted: 'Saved — {n} adjusted to stay in the safe range',
  failed: 'Couldn’t save — nothing was changed.',
  tryAgain: 'Try again',
  inline: 'Not saved. Nothing was changed.',
} as const;

export const EXPECT_COPY = {
  title: 'What to expect',
  today: 'Today',
  todayLine: 'About {n} actions in {s} sessions',
  todayNotBuilt: 'Not known yet — Epo plans today once it has opened your account.',
  week: 'The week ahead',
  weekNotBuilt: 'The week ahead appears once Epo plans your days.',
  dayOff: '{day}: day off',
  dayLine: '{day}: about {n} actions',
  limits: 'Limits',
  limitsLine: 'At most {h} an hour · hard stop {m} a day',
  ifPicked: 'With {choice}: about {n} a day',
} as const;
