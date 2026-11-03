/**
 * The intro tour's script (spec Appendix C.15.7, B.10): ordered coach-mark
 * steps keyed on stages. Each step shows its stage before it points, so the tour
 * walks the REAL, live UI. Targets are `data-tour` tokens resolved at display
 * time; a step with no target renders as a centered dialog.
 *
 * Steps about the console column park the stage on Graph, so the whole window
 * belongs to this renderer and the dim covers it (on Live the Instagram page
 * floats above anything drawn here). The stage-bar step keeps Live up on
 * purpose: the page IS what it introduces, and its card docks over the column.
 */

import type { StageMode } from '@/shared/stage-mode';

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** `data-tour` token of the element to spotlight; centered dialog when absent. */
  target?: string;
  /** The stage to show for this step. */
  stage: StageMode;
  /** Where the tip card sits relative to the target ('inside' for huge targets). */
  side?: 'right' | 'left' | 'above' | 'below' | 'inside';
}

/** Platform modifier for shortcut mentions in the copy. */
const MOD = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Epo',
    body:
      'Epo grows your Instagram audience a little every day, following a plan it makes for you. ' +
      'Here’s a one-minute tour.',
    stage: 'graph',
  },
  {
    id: 'now',
    title: 'What Epo is doing',
    body: 'This always says what Epo is doing and why: the step happening now, what’s next, and when.',
    target: 'now',
    stage: 'graph',
    side: 'right',
  },
  {
    id: 'today',
    title: 'Today’s plan',
    body:
      'Each day Epo plans a few sessions. The strip shows them; the bright one is now. Boost puts the ' +
      'rest of today into finding new people.',
    target: 'today',
    stage: 'graph',
    side: 'right',
  },
  {
    id: 'results',
    title: 'Results',
    body: 'Your results: followers gained today, your follower count, and who followed back.',
    target: 'results',
    stage: 'graph',
    side: 'right',
  },
  {
    id: 'feed',
    title: 'Activity',
    body: 'Everything Epo did, including what happened while you were away.',
    target: 'feed',
    stage: 'graph',
    side: 'right',
  },
  {
    id: 'stages',
    title: 'Pages',
    body:
      'Live shows Instagram as Epo uses it; sign in there first. People, Graph and Prune show who Epo ' +
      `works with. Settings is where you choose how Epo works. ${MOD}1–${MOD}5 switch pages.`,
    target: 'stageseg',
    stage: 'tab',
    side: 'left',
  },
  {
    id: 'settings',
    title: 'Make it yours',
    body:
      'Settings has an Easy view for the essentials and an Advanced view for every detail. Start by ' +
      'choosing a starting account whose followers look like your audience. Every change saves as you make it.',
    target: 'seed',
    stage: 'settings',
    side: 'below',
  },
  {
    id: 'done',
    title: 'Ready when you are',
    body:
      'Sign in on the Live tab, choose a starting account in Settings, and press Start. You can replay ' +
      'this tour from Settings → Practice & app.',
    stage: 'graph',
  },
];

/** The short "new look" tour shown once after an update (spec C.15.7, owner Q30): what moved. */
export const NEW_LOOK_STEPS: readonly TourStep[] = TOUR_STEPS.filter((s) =>
  ['now', 'today', 'feed', 'stages'].includes(s.id),
);
