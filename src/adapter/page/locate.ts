/**
 * `locate(descriptor)` / `probe(descriptor)` — ONE entry point for every control.
 *
 * A control used to be a bespoke `locate*Script` member on `IgSurface` (14 of
 * them) whose config shape only its own page function understood. Here a
 * control is DATA: a descriptor naming one of six strategies plus that
 * strategy's config, and this module is the interpreter.
 *
 * | strategy               | what it finds                                   |
 * |------------------------|-------------------------------------------------|
 * | `leading-text`         | the profile action button, by its leading state  |
 * | `smallest-text`        | drawer entries, the filter chip, the header stats|
 * | `aria-label`           | icon controls that carry no text                 |
 * | `role-then-deep-text`  | the unfollow / cancel-request confirm row        |
 * | `largest-scrollable`   | the list modal's and the drawer's scrollers      |
 * | `row-with-profile-link`| the follow-requests panel's first Confirm        |
 * | `escape`               | the tier of LAST RESORT — requires an ADR        |
 *
 * The mechanics are unchanged: each branch calls the same implementation the
 * version module called directly before, so behaviour is identical by
 * construction and the existing `tests/page/**` suites keep testing the real
 * thing. What changes is that the control is now describable — which is what
 * lets the surface document own it, the contract tests read it, and a new
 * capture edit data instead of adding a method.
 *
 * Zero Instagram literals here, as everywhere under `src/adapter/page/`
 * (ADR 0301): every selector, regex and scope arrives in the descriptor.
 */

import {
  type ActionButtonCfg,
  type LocateActionResult,
  locateActionButton,
  type ProbeStateResult,
  probeActionButton,
} from './action-button';
import { type ConfirmCfg, locateConfirm } from './confirm';
import type { LocateRect, LocateScroll, RegexLit } from './dom';
import {
  type ConfirmRequestCfg,
  type LabeledCfg,
  type LocateConfirmRequestResult,
  locateConfirmRequest,
  locateLabeled,
  locateTextEntry,
  type TextEntryCfg,
} from './drawer';
import {
  type AvatarAltCfg,
  clickProfileLink,
  locateProfileLink,
  type ProfileLinkCfg,
  readAvatarAlt,
  readProfileHref,
} from './identity';
import {
  type DrawerScrollCfg,
  type ListScrollCfg,
  locateDrawerScroll,
  locateScrollContainer,
} from './scroll';
import { locateStat, type StatCfg } from './stat';

/** The strategies the interpreter understands. */
export type Strategy =
  | 'leading-text'
  | 'smallest-text'
  | 'aria-label'
  | 'role-then-deep-text'
  | 'largest-scrollable'
  | 'row-with-profile-link'
  | 'escape';

/** Every result shape a control can report. */
export type LocateResult =
  | LocateRect
  | LocateActionResult
  | LocateScroll
  | LocateConfirmRequestResult
  | { found: false }
  | string
  | boolean
  | null;

/**
 * A control descriptor as it arrives from the surface document, plus the
 * control id (for the logs and the test matchers) and any per-call argument.
 * Deliberately loose: the strategy branch below is what narrows it, and the
 * page bundle must not carry a copy of the document's types.
 */
export interface Descriptor {
  control: string;
  strategy: Strategy;
  [key: string]: unknown;
}

/** `leading-text`: ordered state matchers, as the document declares them. */
interface LeadingTextDescriptor extends Descriptor {
  sel: string;
  states: Array<[string, RegexLit]>;
  op?: 'follow' | 'unfollow';
}

const actionCfg = (d: LeadingTextDescriptor): ActionButtonCfg => ({
  sel: d.sel,
  // ORDER is load-bearing (`follow back` and `following` before the bare
  // `follow` regex, which would claim their leading word) — and it is the
  // document's array order, not a constant re-typed here.
  rx: Object.fromEntries(d.states) as ActionButtonCfg['rx'],
});

/**
 * Find the control `d` describes. Returns the strategy's own result shape; the
 * Actor types each call site, exactly as it did with the per-control scripts.
 */
export function locate(d: Descriptor): LocateResult {
  switch (d.strategy) {
    case 'leading-text': {
      const cfg = d as LeadingTextDescriptor;
      return locateActionButton({ ...actionCfg(cfg), op: cfg.op ?? 'follow' });
    }
    case 'smallest-text':
      // Two shapes share this strategy. With `exclude` the control is named by
      // matching ONE word and not the other (the header stats, where
      // `\bfollowers?\b` must not answer for "following"); without it, by the
      // smallest node whose own text matches (drawer entries, filter chips).
      return d.exclude === true
        ? locateStat(d as unknown as StatCfg)
        : locateTextEntry(d as unknown as TextEntryCfg);
    case 'aria-label':
      return locateLabeled(d as unknown as LabeledCfg);
    case 'role-then-deep-text':
      return locateConfirm(d as unknown as ConfirmCfg);
    case 'largest-scrollable':
      // The list modal names a single root; the drawer names a scope list.
      return typeof d.rootSel === 'string'
        ? locateScrollContainer(d as unknown as ListScrollCfg)
        : locateDrawerScroll(d as unknown as DrawerScrollCfg);
    case 'row-with-profile-link':
      return locateConfirmRequest(d as unknown as ConfirmRequestCfg);
    case 'escape':
      return escapeHatch(d);
  }
}

/** Read the action button's current state — the Actor's post-click check. */
export function probe(d: Descriptor): ProbeStateResult {
  return probeActionButton(actionCfg(d as LeadingTextDescriptor));
}

/**
 * The ESCAPE tier. Its payload names a page function directly instead of a
 * strategy, and the surface document refuses an escape control that does not
 * cite the ADR authorising it. Everything here is the identity resolver, which
 * runs BEFORE any Interactor exists (ADR 0305).
 */
function escapeHatch(d: Descriptor): LocateResult {
  const cfg = (d.cfg ?? {}) as Record<string, unknown>;
  switch (d.fn) {
    case 'locateProfileLink':
      return locateProfileLink(cfg as unknown as ProfileLinkCfg);
    case 'clickProfileLink':
      return clickProfileLink(cfg as unknown as ProfileLinkCfg);
    case 'readProfileHref':
      return readProfileHref(cfg as unknown as ProfileLinkCfg);
    case 'readAvatarAlt':
      return readAvatarAlt(cfg as unknown as AvatarAltCfg);
    default:
      // An unknown escape is NOT a silent not-found: the caller's stale
      // escalation is the correct, loud outcome.
      return { found: false };
  }
}
