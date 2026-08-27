/**
 * The intro tour's script — an ordered list of coach-mark steps. Each step can
 * drive the shell (switch the sidebar view and/or the stage) before it points,
 * so the tour walks the REAL, live UI. Targets are `data-tour` keys resolved
 * at display time; a step with no target renders as a centered dialog
 * (welcome / finish).
 *
 * Steps about console elements park the stage on 'graph' so the whole window
 * belongs to this renderer and the spotlight dim covers it — in 'tab' mode the
 * native Instagram view floats above anything we draw. The stage step alone
 * keeps 'tab' up on purpose: the live page IS the thing being introduced (its
 * tip card docks over the console column, which the native view never covers).
 */

import type { StageMode } from '@/types';
import type { ViewKey } from '../hooks/useView';

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** `data-tour` key of the element to spotlight; centered dialog when absent. */
  target?: string;
  /** Sidebar view to show for this step. */
  view?: ViewKey;
  /** Stage mode to show for this step. */
  stage?: StageMode;
  /** Where the tip card sits relative to the target ('inside' for huge targets). */
  side?: 'right' | 'left' | 'above' | 'below' | 'inside';
}

/** Platform modifier for shortcut mentions in the copy. */
const MOD =
  typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Epo',
    body:
      'Epo is a growth console for your Instagram account: pick a seed audience, set the ' +
      'pace, and it follows, watches for follow-backs, and tidies up — all from this ' +
      'window. This one-minute tour points out the controls.',
    stage: 'graph',
    view: 'overview',
  },
  {
    id: 'stage',
    title: 'The stage',
    body:
      'This selector swaps what fills the big pane: the live Instagram tab, the network ' +
      'graph, and the prune console. Log in on the Instagram tab first — the session ' +
      'persists, and the page keeps working even while another stage covers it.',
    target: 'stageseg',
    stage: 'tab',
    side: 'left',
  },
  {
    id: 'transport',
    title: 'Transport',
    body:
      'Start, pause, and cancel the engine here. The lit button is always the natural ' +
      'next action for the current state, and the ring around the brand mark breathes ' +
      'while a session is running.',
    target: 'transport',
    stage: 'graph',
    side: 'right',
  },
  {
    id: 'consoles',
    title: 'Four consoles',
    body:
      'Overview shows live status and growth, Chain the lineage of targets, Queues every ' +
      `account in the pipeline, Settings the tuning knobs. ${MOD}1–${MOD}4 jump between ` +
      'them, and the ticker at the bottom streams the engine log.',
    target: 'nav',
    stage: 'graph',
    side: 'right',
  },
  {
    id: 'graph',
    title: 'The graph',
    body:
      'Every account Epo knows lands here the moment it is observed — clustered around ' +
      'the target that surfaced it, colored by status. Scroll to zoom, drag to pan, ' +
      'hover for details, and click legend rows to filter.',
    target: 'stagebody',
    stage: 'graph',
    side: 'inside',
  },
  {
    id: 'prune',
    title: 'Prune',
    body:
      'The prune console takes a census of who follows you back, lists the candidates ' +
      'for review, and unfollows non-reciprocating accounts at a safe pace. Whitelisted ' +
      'accounts and protected bio words are never touched.',
    target: 'prune-census',
    stage: 'prune',
    side: 'below',
  },
  {
    id: 'settings',
    title: 'Make it yours',
    body:
      'Start with a seed account whose followers look like your audience — Epo checks it ' +
      'as you type. Below it, the Behavior personas set pace and rhythm in plain words, ' +
      'and every change saves the moment you make it.',
    target: 'seed',
    view: 'settings',
    stage: 'graph',
    side: 'right',
  },
  {
    id: 'done',
    title: 'Ready when you are',
    body:
      'Log in on the Instagram tab, set a seed, and press Start. You can replay this ' +
      'tour anytime from Settings → Data & session.',
    stage: 'graph',
    view: 'overview',
  },
];
