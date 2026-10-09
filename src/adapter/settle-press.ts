/**
 * Settle-then-press — how a HOVER-REACTIVE control is pressed.
 *
 * Live 2026-10-08: Instagram's nav rail is a collapsed icon rail that
 * re-renders its nodes as the cursor arrives (the notifications control went
 * from a 48×56 link to a 214×16.5 one, and the node located before travel was
 * disconnected), and drawer controls rescale on hover (the close X
 * 16 → 16.8 px). A rect located BEFORE the cursor travelled names a node that
 * is no longer under it, so the click guard — which holds that node through
 * travel precisely so a replacement never inherits the press — refused every
 * rail press, and the notifications drawer never opened.
 *
 * So: rest the cursor on the control, let the page react, locate it AGAIN, and
 * press what is there now. The guard still protects the short final travel.
 */

import type { LocatedRect } from '@/adapter/ig-surface';

/** The two input moves a settled press needs (the Interactor satisfies it). */
export interface SettleInteractor {
  hover(target: LocatedRect): Promise<void>;
  click(target: LocatedRect): Promise<void>;
}

/**
 * Hover `located`, locate again, press the settled rect. Returns the settled
 * locate result — the one actually pressed — or `null`, pressing nothing, when
 * the control was never usable or is gone once the page has reacted.
 */
export async function settleAndPress<T extends { found: boolean; rect?: LocatedRect }>(
  interactor: SettleInteractor,
  located: T | null,
  locate: () => Promise<T | null>,
  usable: (rect: LocatedRect | undefined) => rect is LocatedRect,
): Promise<T | null> {
  if (!located?.found || !usable(located.rect)) return null;
  await interactor.hover(located.rect);
  const settled = await locate();
  if (!settled?.found || !usable(settled.rect)) return null;
  await interactor.click(settled.rect);
  return settled;
}
