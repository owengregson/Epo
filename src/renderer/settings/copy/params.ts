/**
 * Every Advanced row's label and one-line help (spec §6.5, Appendix B.10), exhaustive over the parameter
 * keys, plus the words for the intent keys a reset or a conflict names. `{p}` slots are filled from the view.
 * The cleanup feature reads "Prune"; timing rows can only be made slower.
 */
import type { IntentKey } from '@/shared/settings-intent';
import type { ParamKey } from '@/shared/settings-params';

export interface ParamCopy {
  readonly label: string;
  readonly help: string;
}

const SLOWER = 'You can only make it longer. The lowest value is the plan’s own pace.';
const tempo = (label: string, help = SLOWER): ParamCopy => ({ label, help });

export const PARAM_COPY = {
  'pace.dailyVolume': { label: 'Daily action target', help: 'Epo’s days vary below it and stay under about {p}% of it on their own.' },
  'pace.dailyCeiling': { label: 'Most actions in a day, including your own', help: 'The hard stop. It never raises Epo’s automatic day.' },
  'pace.hourlyCap': { label: 'Most actions in an hour', help: 'Epo spreads each hour’s actions out and never goes past this.' },
  'pace.dayVariation': { label: 'Day-to-day variation', help: 'How much one day differs from the next.' },
  'pace.restDayChance': { label: 'Chance of a lighter day', help: 'How often a day is drawn lighter than usual.' },
  'pace.candidateBuffer': { label: 'People prepared per day', help: 'How many people Epo lines up ahead of each day.' },
  'sessions.perDayMin': { label: 'Fewest sessions in a day', help: 'Epo spreads the day over at least this many sessions.' },
  'sessions.perDayMax': { label: 'Most sessions in a day', help: 'Epo never splits a day into more sessions than this.' },
  'sessions.gapTypical': { label: 'Average pause between actions', help: 'Epo’s typical wait between actions at a normal-pace session. You can only make it longer.' },
  'sessions.gapMinimum': { label: 'Shortest pause between actions', help: 'The shortest wait Epo allows. You can only make it longer.' },
  'unfollow.waitDays': { label: 'Days to wait for a follow-back', help: 'How long someone has to follow you back before Epo unfollows them.' },
  'unfollow.holdDays': { label: 'Days to keep someone who followed back', help: 'How long Epo keeps following someone after they follow you back.' },
  'unfollow.cleanupShare': { label: 'Most of a session spent pruning', help: 'The largest share of a session that goes to pruning people you followed yourself.' },
  'unfollow.cleanupPerDay': { label: 'Most prune unfollows in a day', help: 'You can only lower it below what the plan allows.' },
  'unfollow.censusEveryDays': { label: 'Re-check who follows you back every', help: 'How often Epo reads your lists again before pruning.' },
  'unfollow.attempts': { label: 'Attempts before skipping an account', help: 'For follows and unfollows alike.' },
  'checks.everyHours': { label: 'Check for new followers every', help: 'Epo checks less often than this if the day’s reading needs it.' },
  'audience.followerRange': { label: 'Follower range', help: 'Epo follows accounts whose follower count is inside this range.' },
  'audience.ratioCurve': { label: 'Follow-back curve', help: 'How Epo scores an account by how many people it follows compared with its followers.' },
  'audience.privateBoost': { label: 'Edge for private accounts', help: 'Private accounts follow back more often; this is how much extra they score.' },
  'audience.mutualWeight': { label: 'Weight of followers you share', help: 'How much a follower you have in common adds to an account’s score.' },
  'audience.mutualCap': { label: 'Most shared followers counted', help: 'Shared followers beyond this add nothing more.' },
  'audience.bandEdgeScore': { label: 'Score at the edge of the curve', help: 'What an account scores at the outer edge of the follow-back curve.' },
  'explore.moveOnRate': { label: 'Move on from a source below this follow-back rate', help: 'Epo stops finding people through an account whose followers rarely follow back.' },
  'explore.moveOnPool': { label: '…or when fewer people are left than', help: 'Epo moves on when an account has few followers left to look at.' },
  'explore.refillBelow': { label: 'Find more people when fewer than this are waiting', help: 'Epo looks for more people when its list runs this low.' },
  'tempo.gap.accept': tempo('Pause between accepted requests'),
  'tempo.dwell.visit': tempo('Time spent on each profile'),
  'tempo.dwell.before-press': tempo('Look before pressing Follow or Unfollow'),
  'tempo.ui.step-pause': tempo('Pause between the steps of an action'),
  'tempo.drawer.close-settle': tempo('Settle after closing a list'),
  'tempo.scroll.wait.drawer': tempo('Wait between scrolls in a list'),
  'tempo.scroll.wait.dialog': tempo('Wait between scrolls in a dialog'),
  'tempo.scroll.wait.acquire': tempo('Wait between scrolls while finding people'),
  'tempo.scroll.depth.drawer': tempo('Scroll length in a list'),
  'tempo.scroll.depth.dialog': tempo('Scroll length in a dialog'),
  'tempo.walk.page': tempo('Time on each page of a list'),
  'tempo.walk.rest': tempo('Rest during long list reads'),
  'tempo.walk.rest-every': tempo('Pages between rests'),
  'tempo.pause.retry': tempo('Wait before trying again'),
  'tempo.pause.wake-settle': tempo('Settle after the computer wakes'),
  'tempo.pause.after-task': tempo('Pause after each task'),
  'tempo.park.blocked': tempo('Wait after Instagram says no'),
  'tempo.backoff.walled': tempo('Back off after reaching a limit'),
  'tempo.beat.transient': tempo('Wait after a brief hiccup'),
  'tempo.motion.travel': tempo('Pointer travel time'),
  'tempo.motion.press': tempo('Length of a press'),
  'tempo.motion.pre-press': tempo('Pause before a press'),
  'tempo.motion.hover-settle': tempo('Settle after the pointer arrives'),
  'tempo.wheel.tick-pause': tempo('Pause between scroll-wheel ticks'),
  'tempo.wheel.micro-pause': tempo('Short pauses while scrolling'),
  'tempo.wheel.correction-pause': tempo('Pause before a scroll correction'),
} as const satisfies Readonly<Record<ParamKey, ParamCopy>>;

/** The intent keys as a reset or a conflict names them. */
export const INTENT_LABEL = {
  activity: 'Activity level', caution: 'Caution', rhythm: 'Session style', consistency: 'Consistency',
  dayShape: 'When Epo works', weeklyShape: 'Weekly shape', quietHours: 'Quiet hours', daysOff: 'Days off',
  patience: 'Wait for a follow-back', mutuals: 'When someone follows you back', cleanup: 'Prune people you followed yourself',
  audienceFocus: 'Prefer', audienceSize: 'Account size', preferPrivate: 'Edge for private accounts',
} as const satisfies Readonly<Record<IntentKey, string>>;

export const OTHER_LABEL = { seed: 'Starting account', 'prefs.practice': 'Practice mode' } as const;
