/**
 * "Why?" (spec Appendix C.15.3): the popover behind a posture's next line, in plain words. Counts and times
 * come from the plan and the status; a clause whose number is not known is left out.
 */
import { BOOST_COPY } from '@/renderer/copy/boost';
import { clock } from '@/renderer/sidebar/format';
import type { ExplainTopic } from '@/shared/posture';
import type { CatchUpStepId, StepState } from '@/shared/reopen-view';

/** The catch-up's checklist under its "Why?" (spec Appendix E.2): each step's label, done or running. */
export function catchUpChecklist(
  steps: readonly { readonly id: CatchUpStepId; readonly step: StepState }[],
  since: number | null,
): { readonly label: string; readonly done: boolean; readonly now: boolean }[] {
  const label = (id: CatchUpStepId): string =>
    id === 'profile'
      ? 'Your profile numbers'
      : id === 'followers-head'
        ? 'Newest followers'
        : since === null
          ? 'Notifications'
          : `Notifications since ${clock(since)}`;
  return steps.map(({ id, step }) => ({ label: label(id), done: step.state === 'done', now: step.state === 'running' }));
}

export interface ExplainFacts {
  /** Today's planned sessions, when a plan exists. */
  readonly sessions: number | null;
  /** When the paused profile visits come back (the park's end). */
  readonly visitsAt: number | null;
  readonly attempt: { readonly n: number; readonly max: number } | null;
  /** The day opened after its sessions, or a light day planned nothing. */
  readonly lateOrLight: boolean;
}

export function explainText(topic: ExplainTopic, f: ExplainFacts): string {
  switch (topic) {
    case 'resting': {
      const n = f.sessions === null ? '' : ` Today’s plan has ${f.sessions}.`;
      return `Epo works in a few sessions spread across the day instead of all at once.${n} Their times and sizes change from day to day.`;
    }
    case 'pacing-hour':
      return 'Epo keeps an even pace within each hour and continues as soon as the hour has room again.';
    case 'pacing-visits': {
      const at = f.visitsAt === null ? '' : ` More become available at ${clock(f.visitsAt)}.`;
      return `Epo looks at a limited number of profiles each day to stay within safe limits.${at}`;
    }
    case 'retrying':
      return 'A read didn’t work just now. Epo waits a little and tries again.';
    case 'taking-a-break': {
      const of = f.attempt === null ? '' : ` (attempt ${f.attempt.n} of ${f.attempt.max})`;
      return `Instagram declined recent actions. Epo waits before trying again, a little longer each time${of}. If it still can’t act after the last attempt, it stops and tells you.`;
    }
    case 'done-for-today':
      return f.lateOrLight
        ? 'When Epo opens after today’s sessions have passed, or on a light day with nothing planned, it rests until tomorrow’s first session. Missed sessions are not made up later.'
        : 'Each day has a plan. When it’s done, Epo rests until tomorrow’s first session.';
    case 'day-off':
      return 'You chose to keep today free. Epo does no automatic work on your days off and picks up tomorrow.';
    case 'catching-up':
      return 'Things changed while Epo was closed. It checks only what changed since it last ran: your profile, your notifications and your newest followers.';
    case 'boost':
      return BOOST_COPY.explain;
    case 'practice':
      return 'Practice mode: follows and unfollows are simulated, so nothing changes on your account. Epo still reads Instagram.';
  }
}
