/**
 * What Settings search knows (spec §6.5): every section and row with the words the page shows, the
 * words people use for them, and every older-version setting name — each mapped to the row that holds it
 * now, or to the row that explains why it is gone. Data only; matching lives in `search.ts`.
 */
import type { SectionId } from '@/shared/settings-params';

export interface SearchTarget {
  readonly section: SectionId;
  /** The `data-row` anchor inside the section; the section itself when absent. */
  readonly row?: string;
}

/** Rows that are not parameters, with the extra words that find them. */
export const ROWS: ReadonlyArray<SearchTarget & { readonly title: string; readonly words: string }> = [
  { section: 'pace', row: 'pace.cards', title: 'Growth pace', words: 'gentle balanced faster speed how fast actions a day daily volume' },
  { section: 'schedule', row: 'schedule.shape', title: 'When Epo works', words: 'through the day mornings evenings late nights work hours day shape schedule' },
  { section: 'schedule', row: 'quietHours', title: 'Quiet hours', words: 'sleep night overnight active hours off hours' },
  { section: 'schedule', row: 'daysOff', title: 'Days off', words: 'weekend day off rest days' },
  { section: 'schedule', row: 'schedule.rhythm', title: 'Session style', words: 'short visits regular sessions longer sessions rhythm' },
  { section: 'audience', row: 'seed', title: 'Starting account', words: 'seed source target account followers of' },
  { section: 'audience', row: 'audience.size', title: 'Account size', words: 'smaller everyday larger follower count' },
  { section: 'audience', row: 'audience.focus', title: 'Prefer', words: 'likely to follow back reach more people audience focus' },
  { section: 'audience', row: 'preferPrivate', title: 'Give private accounts a small edge', words: 'private accounts edge boost' },
  { section: 'audience', row: 'acceptRequests', title: 'Accept follow requests automatically', words: 'follow requests approve approvals private account' },
  { section: 'unfollow', row: 'patience', title: 'If someone doesn’t follow back', words: 'wait follow back days patience' },
  { section: 'unfollow', row: 'unfollow.mutuals', title: 'When someone follows you back', words: 'mutuals keep following rotate hold' },
  { section: 'unfollow', row: 'unfollow.cleanup', title: 'Prune people you followed yourself', words: 'prune pruning cleanup clean up own follows non followers' },
  { section: 'protection', row: 'protection.people', title: 'Never unfollow these accounts', words: 'protect protected keep list friends family brands' },
  { section: 'protection', row: 'protection.words', title: 'Bio keywords', words: 'keywords keep words bio words phrase' },
  { section: 'protection', row: 'protection.verified', title: 'Keep verified accounts', words: 'verified badge blue check creators brands' },
  { section: 'protection', row: 'protect:wordMatch', title: 'Keyword matching', words: 'whole words anywhere match' },
  { section: 'protection', row: 'protection.state', title: 'Protection list', words: 'review restored protection state' },
  { section: 'boost', row: 'boost.hours', title: 'Boost length', words: 'boost default length hours' },
  { section: 'boost', row: 'boost.acceptRequests', title: 'Keep accepting follow requests during Boost', words: 'boost requests' },
  { section: 'app', row: 'practice', title: 'Practice mode', words: 'practice dry run test simulate' },
  { section: 'app', row: 'updates', title: 'Updates', words: 'update version release download' },
  { section: 'app', row: 'replayTour', title: 'Replay the intro', words: 'tour intro help walkthrough' },
  { section: 'app', row: 'reset', title: 'Reset to recommended', words: 'reset defaults recommended' },
  { section: 'app', row: 'clearData', title: 'Clear data & log out', words: 'log out logout sign out clear data wipe' },
  { section: 'app', row: 'startOver', title: 'Start over from the older version’s settings', words: 'older version migrate import previous settings' },
  { section: 'timing', row: 'plan.detail', title: 'Today’s plan in detail', words: 'plan today sessions pauses gaps caps' },
  { section: 'limits', title: 'Limits & reading', words: 'limits reads reading allowance walls envelope risk' },
  { section: 'technical', title: 'Under the hood', words: 'catalog kernel policy fundamentals registry motion numbers' },
  { section: 'diagnostics', title: 'Diagnostics', words: 'log logs compatibility instagram changes report' },
];

/** Where a setting from the older version lives now (spec §6.10): a row, by its anchor. */
export const V1_HOMES: Readonly<Record<string, SearchTarget>> = {
  seed: { section: 'audience', row: 'seed' },
  bandLow: { section: 'audience', row: 'audience.ratioCurve' },
  bandHigh: { section: 'audience', row: 'audience.ratioCurve' },
  peakLow: { section: 'audience', row: 'audience.ratioCurve' },
  peakHigh: { section: 'audience', row: 'audience.ratioCurve' },
  hardLow: { section: 'audience', row: 'audience.ratioCurve' },
  hardHigh: { section: 'audience', row: 'audience.ratioCurve' },
  minFollowers: { section: 'audience', row: 'audience.followerRange' },
  maxFollowers: { section: 'audience', row: 'audience.followerRange' },
  privateBoost: { section: 'audience', row: 'audience.privateBoost' },
  maxWaitForFollowbackDays: { section: 'unfollow', row: 'unfollow.waitDays' },
  holdAfterFollowbackDays: { section: 'unfollow', row: 'unfollow.holdDays' },
  maxRetries: { section: 'unfollow', row: 'unfollow.attempts' },
  dailyHardCeiling: { section: 'pace', row: 'pace.dailyCeiling' },
  dailyOperatingRate: { section: 'pace', row: 'pace.dailyVolume' },
  activeHoursStart: { section: 'schedule', row: 'quietHours' },
  activeHoursEnd: { section: 'schedule', row: 'quietHours' },
  followbackSweepHours: { section: 'unfollow', row: 'checks.everyHours' },
  autoAcceptFollowRequests: { section: 'audience', row: 'acceptRequests' },
  dailyPlanSize: { section: 'pace', row: 'pace.candidateBuffer' },
  lowWaterCandidates: { section: 'explore', row: 'explore.refillBelow' },
  minFollowBackRate: { section: 'explore', row: 'explore.moveOnRate' },
  minPoolSize: { section: 'explore', row: 'explore.moveOnPool' },
  dryRun: { section: 'app', row: 'practice' },
  pruneWhitelist: { section: 'protection', row: 'protection.people' },
  pruneBioFilterWords: { section: 'protection', row: 'protection.words' },
  pruneDailyLimit: { section: 'unfollow', row: 'unfollow.cleanupPerDay' },
  pruneScheduleDays: { section: 'unfollow', row: 'unfollow.cleanup' },
  pruneScanMinSeconds: { section: 'timing', row: 'tempo.walk.page' },
  pruneScanMaxSeconds: { section: 'timing', row: 'tempo.walk.page' },
  dailyVolumeVariancePct: { section: 'pace', row: 'pace.dayVariation' },
  restDayChancePct: { section: 'pace', row: 'pace.restDayChance' },
  sessionsPerDayMin: { section: 'schedule', row: 'sessions.perDayMin' },
  sessionsPerDayMax: { section: 'schedule', row: 'sessions.perDayMax' },
  gapMedianSeconds: { section: 'timing', row: 'sessions.gapTypical' },
  gapFloorSeconds: { section: 'timing', row: 'sessions.gapMinimum' },
  hourlyVelocityCap: { section: 'pace', row: 'pace.hourlyCap' },
  weaveEnabled: { section: 'unfollow', row: 'unfollow.cleanup' },
  maxUnfollowFractionPerSession: { section: 'unfollow', row: 'unfollow.cleanupShare' },
};

/**
 * Older-version settings that are gone, each with why and the row that now covers the idea. Search finds
 * them by their old names and lands on that row.
 */
export const V1_RETIRED: Readonly<Record<string, SearchTarget & { readonly why: string }>> = {
  minDelayMinutes: { section: 'timing', row: 'sessions.gapTypical', why: 'Steady intervals is retired: every pause comes from the day plan.' },
  maxDelayMinutes: { section: 'timing', row: 'sessions.gapTypical', why: 'Steady intervals is retired: every pause comes from the day plan.' },
  jitterPercent: { section: 'timing', row: 'sessions.gapTypical', why: 'Steady intervals is retired: each session draws its own pauses.' },
  pacingModel: { section: 'pace', row: 'intent:consistency', why: 'There is one pacing now: the day plan. Consistency sets how even the days are.' },
  sweepLastRunAt: { section: 'unfollow', row: 'checks.everyHours', why: 'Bookkeeping, not a setting: the last check is kept with your account.' },
  sweepIntervalFactor: { section: 'unfollow', row: 'checks.everyHours', why: 'Retired: the check spacing comes from the plan.' },
  pruneLastRunAt: { section: 'unfollow', row: 'unfollow.cleanup', why: 'The weekly bulk prune is retired; pruning happens gradually inside sessions.' },
  persona: { section: 'pace', row: 'pace.cards', why: 'A persona was a set of choices; those choices are the pace, schedule and unfollowing sections now.' },
  pattern: { section: 'pace', row: 'pace.cards', why: 'The older pattern became the plain choices on this page.' },
  tourCompletedAt: { section: 'app', row: 'replayTour', why: 'Not a setting: replay the intro here.' },
};

/** Everyday words for older names (old labels people remember). */
export const SYNONYMS: ReadonlyArray<readonly [string, SearchTarget]> = [
  ['whitelist', { section: 'protection', row: 'protection.people' }],
  ['bio keep-words', { section: 'protection', row: 'protection.words' }],
  ['bio filter', { section: 'protection', row: 'protection.words' }],
  ['dry run', { section: 'app', row: 'practice' }],
  ['seed', { section: 'audience', row: 'seed' }],
  ['active hours', { section: 'schedule', row: 'quietHours' }],
  ['pacing', { section: 'pace', row: 'pace.cards' }],
  ['jitter', { section: 'timing', row: 'sessions.gapTypical' }],
  ['delay', { section: 'timing', row: 'sessions.gapTypical' }],
  ['persona', { section: 'pace', row: 'pace.cards' }],
  ['velocity', { section: 'pace', row: 'pace.hourlyCap' }],
  ['ceiling', { section: 'pace', row: 'pace.dailyCeiling' }],
  ['hard stop', { section: 'pace', row: 'pace.dailyCeiling' }],
  ['operating rate', { section: 'pace', row: 'pace.dailyVolume' }],
  ['auto-prune', { section: 'unfollow', row: 'unfollow.cleanup' }],
  ['cleanup', { section: 'unfollow', row: 'unfollow.cleanup' }],
  ['follow-back sweep', { section: 'unfollow', row: 'checks.everyHours' }],
  ['retries', { section: 'unfollow', row: 'unfollow.attempts' }],
];
