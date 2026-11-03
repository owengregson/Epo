/**
 * Advanced mode's words (spec §6.5, Appendix B.10): the row anatomy, today's plan in detail, the kept
 * table, the read-only catalogs and Diagnostics. `{name}` slots come from the view, the status projection
 * or the basis rows; no number lives here.
 */
import type { ApplyWhen } from '@/shared/settings-params';
import type { BasisRow } from '@/shared/settings-view';

export const ROW_COPY = {
  recommended: 'Recommended {v}',
  why: 'Why this number?',
  hideWhy: 'Hide',
  setByYou: 'Set by you',
  useRecommended: 'Use recommended',
  range: 'Safe range {span}',
  less: 'Less',
  more: 'More',
  min: 'From',
  max: 'To',
  today: 'Today: {v}',
  clampedMax: 'You asked for {x}; Epo uses {y}, the safe maximum.',
  clampedMin: 'You asked for {x}; Epo uses {y}, the safe minimum.',
  stale: 'Set to {x} when Epo recommended {b}; it now recommends {r}.',
  conflict: 'You set {label} yourself ({x}). The new choice would use {r}.',
  useIt: 'Use {r}',
  keep: 'Keep {x}',
  inactiveMutuals: 'Not used — you keep people who follow you back.',
  inactiveCleanup: 'Not used — pruning is off.',
  fineTune: 'Fine-tune',
  sectionRecommended: 'Use recommended for this section',
  curvePoints: ['Hard low', 'Band low', 'Peak low', 'Peak high', 'Band high', 'Hard high'],
  curveLabel: 'Follow-back curve: score by how many people an account follows per follower',
} as const;

export const APPLIES_COPY = {
  now: 'Applies now',
  replan: 'Updates today’s remaining plan',
  'next-day': 'From tomorrow’s plan',
  'next-start': 'After Epo restarts',
} as const satisfies Readonly<Record<ApplyWhen, string>>;

export const PROVENANCE_COPY = {
  choice: '{v} ({k})',
  param: '{k} = {v}',
  policy: '{k} = {v}',
  fundamental: '{k} = {v} {unit} (measured, {rev})',
  times: '×',
  divide: '÷',
  round: 'rounded',
  ceil: 'rounded up',
  min: 'the smaller',
  max: 'the larger',
} as const;

export const INTENT_ROWS_COPY = {
  activityChip: '{label} · about {n}',
  cautionChip: '{label} ≤ {n}/h',
  consistencyChip: '{label}',
  activityHelp: 'How many actions a typical day holds; the number is a typical day at your consistency.',
  cautionHelp: 'The most actions Epo takes in any hour.',
  consistencyHelp: 'How much one day differs from the next.',
  weeklyHelp: 'How the week’s days differ from each other.',
  matchHelp: 'Whole words only matches “art” in “art teacher” but not in “artist”.',
} as const;

export const PLAN_DETAIL_COPY = {
  title: 'Today’s plan in detail',
  readOnly: 'Read only',
  notBuilt: 'Today’s plan appears here once Epo has opened your account and planned the day.',
  day: 'Plan-day',
  resets: 'Resets at',
  automaticMax: 'Epo’s own maximum',
  hardStop: 'Hard stop',
  hourly: 'At most an hour',
  unfollowHourly: 'Unfollows an hour',
  probationHourly: 'While easing back in',
  accepts: 'Approvals per check',
  session: 'Session',
  time: 'Time',
  follows: 'Follows',
  unfollows: 'Unfollows',
  approvals: 'Approvals',
  pace: 'Pace',
  average: 'Average pause',
  median: 'Typical pause',
  shortest: 'Shortest',
  longest: 'Longest',
  motion: 'Pointer pace',
  depth: 'Scroll depth',
  profiles: 'Profiles',
  pages: 'List pages',
  checks: 'Checks',
  tempoTitle: 'Each session’s tempo and reading',
  sessionLine: 'Session {i} · {start}–{end} · {f} · {u} · {a} · {pace} pace · average pause {t} · shortest {s}',
  tempoLine: 'Typical pause {m} · longest {l} · pointer pace ×{mo} · scroll depth ×{d} · reads {p} profiles, {g} pages, {c} checks',
  paceWords: { relaxed: 'relaxed', normal: 'normal', quick: 'quick' },
} as const;

export const KEPT_COPY = {
  title: 'Currently kept',
  loading: 'Loading the kept list…',
  empty: 'No one is being kept right now.',
  unavailable: 'The kept list appears once Epo has opened your account.',
  account: 'Account',
  why: 'Why',
  match: 'Matched',
  since: 'Kept',
  next: 'Checks again',
  never: '—',
  previous: 'Previous',
  nextPage: 'Next',
  range: '{from}–{to} of {total}',
  reasons: {
    account: 'In your protection list', verified: 'Verified', 'bio-word': 'Bio keyword', source: 'An account Epo explores through',
    'unreadable-bio': 'Bio couldn’t be read yet', 'unreadable-verified': 'Badge couldn’t be read yet',
  } as Readonly<Record<string, string>>,
} as const;

export const BASIS_COPY = {
  loading: 'Loading the catalog…',
  unavailable: 'The catalog couldn’t be loaded.',
  retry: 'Try again',
  filter: 'Filter by name',
  none: 'Nothing matches “{q}”.',
  count: '{n} entries',
  name: 'Name',
  value: 'Value',
  tier: 'Kind',
  source: 'Source',
  why: 'Why',
  groups: {
    fundamental: 'Measured limits', policy: 'Policy dials', bound: 'Bounds', derived: 'Derived from the others',
    registry: 'The plan’s registry', motion: 'Pointer and scroll motion',
  } satisfies Readonly<Record<BasisRow['group'], string>>,
} as const;

export const LIMITS_COPY = {
  reads: 'What Epo reads in a plan-day',
  profiles: 'Profiles',
  listPages: 'List pages',
  withExploring: '{n} · {e} of them while finding new people',
  notifications: 'Notification checks',
  backstop: 'Counted per plan-day, with a rolling 24-hour backstop.',
  day: 'A day',
  automaticMax: 'Epo’s own maximum',
  ceiling: 'Hard stop, including your own actions',
  hourly: 'Most actions in an hour',
  risk: 'Where this sits',
  risks: {
    low: 'Well inside Instagram’s known limits', standard: 'Inside Instagram’s known limits',
    elevated: 'Closer to Instagram’s known limits', 'at-limit': 'At the low end of what Instagram is known to allow',
  },
  walls: 'Instagram’s known limits',
  envelope: 'The most any setting can ask for',
  policy: 'Policy dials behind these numbers',
} as const;

export const EXPLORE_COPY = {
  policy: 'How Epo weighs sources (read only)',
} as const;

export const DIAGNOSTICS_COPY = {
  log: 'Activity log',
  logPending: 'The activity log appears here.',
} as const;
