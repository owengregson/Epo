/**
 * Script builders for the DOM inspection harness.
 *
 * The in-page logic used to live here as hand-written ES5 strings — the last
 * un-typechecked page JavaScript in the repo. It is now a real page module
 * (`src/adapter/page/inspect.ts`), type-checked, linted and DOM-tested like
 * every other page script (ADR 0301); this file is what remains: the config
 * and the two `__epoPage` calls the harness evaluates.
 */

import type { InspectBannerCfg, InspectCfg } from '@/adapter/page';
import { pageCall as callPage } from '@/adapter/page-call';

export type { InspectAncestor, InspectRecord } from '@/adapter/page';

/** Element-id prefix for the harness's own UI — never captured, never intercepted. */
const PREFIX = '__epo_inspect_';

/**
 * The on-tab instruction banner. Verbatim wording the user reads while
 * clicking, per the harness spec.
 */
export const INSPECT_BANNER_TEXT =
  'EPO INSPECT — click any element to capture it for the developer. ' +
  'Default RECORD-ONLY: the click is intercepted, nothing happens (safe). ' +
  'Toggle PASS-THROUGH (bottom-right) only when you must open a menu/dialog first. ' +
  "Please click, in RECORD-ONLY: (1) the 'followers' count on a profile, " +
  '(2) a Follow button, (3) a Following button, ' +
  "(4) 'Unfollow' inside the confirm menu (open the menu in PASS-THROUGH first). " +
  'Saved to docs/adapter/inspect/clicks.jsonl.';

/**
 * A lightweight, pre-login banner (`pointer-events:none`, no click
 * interception). Used before the instrumentation is installed so the user can
 * still log in.
 */
export function buildPreLoginBannerScript(text: string): string {
  const cfg: InspectBannerCfg = { banner: `Epo inspect: ${text}`, prefix: PREFIX };
  return callPage('inspectBanner', cfg);
}

/**
 * The per-tick script: install instrumentation if absent, refresh the injected
 * UI, then splice-and-return the buffered records. One evaluate per poll.
 */
export function buildInspectTickScript(bannerText: string): string {
  const cfg: InspectCfg = {
    banner: bannerText,
    prefix: PREFIX,
    maxDepth: 8,
    maxText: 120,
    maxHtml: 400,
  };
  return callPage('inspectTick', cfg);
}
