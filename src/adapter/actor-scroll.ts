/**
 * The Actor's list-scroll rounds: one bounded wheel step toward the bottom of
 * the notifications drawer's list or of the followers dialog.
 */

import type { LocatedRect, LocateScrollResult } from '@/adapter/ig-surface';
import { SURFACE } from '@/adapter/ig-surface';
import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { MIN_SCROLL_STEP_PX } from '@/kernel/tempo-policy';
import * as logger from '@/utils/logger';
import type { ActorInteractor, AdapterTab } from './actor-types';

/** The slice of the Actor a scroll round drives. */
export interface ScrollDeps {
  readonly tab: AdapterTab;
  readonly interactor: ActorInteractor;
  /** The Actor's pressable-rect guard. */
  readonly rectUsable: (rect: LocatedRect | undefined) => rect is LocatedRect;
  /** Viewports per burst come from the tempo's depth axis, floored at MIN_SCROLL_STEP_PX (default: reference). */
  readonly tempo?: TempoSource;
}

/**
 * One wheel-scroll round of the notifications drawer's list (loads older
 * notification pages). `false` when nothing scrollable remains — the list
 * fits, is already bottomed, or the drawer is gone.
 */
export async function scrollNotificationsList(deps: ScrollDeps): Promise<boolean> {
  const res = await deps.tab.evaluate<LocateScrollResult>(
    SURFACE.locateNotificationsScrollScript(),
  );
  if (!res?.found || !deps.rectUsable(res.rect)) return false;
  const scrollTop = res.scrollTop ?? 0;
  const scrollHeight = res.scrollHeight ?? 0;
  const clientHeight = res.clientHeight ?? 0;
  const remaining = Math.max(0, scrollHeight - scrollTop - clientHeight);
  if (remaining <= 0) return false;
  await deps.interactor.scroll(
    res.rect,
    Math.min(remaining, Math.max(MIN_SCROLL_STEP_PX, clientHeight * tempoOrReference(deps.tempo).draw('scroll.depth.drawer'))),
  );
  return true;
}

/**
 * One interactor dialog-scroll round: locate the scroll container's rect +
 * metrics in-page, then wheel-scroll toward the bottom with real input
 * events. The per-round distance is the remaining scroll, capped at three
 * viewports — a few screens are covered at a time, and the collect loop's
 * rounds carry the walk onward anyway. Returns `false` (nothing to scroll)
 * when the container is absent or already bottomed. Best-effort by design: a
 * small list that fits in the modal has NO scrollable container, and the list
 * may not be hydrated on the first attempt — either way there is nothing to
 * scroll, so this returns `false` rather than throwing (a throw would abort
 * the whole collect and discard followers the initial page already loaded).
 */
export async function scrollFollowersDriven(deps: ScrollDeps): Promise<boolean> {
  const res = await deps.tab.evaluate<LocateScrollResult>(
    SURFACE.locateScrollContainerScript(),
  );
  if (!res?.found || !deps.rectUsable(res.rect)) {
    logger.debug('actor.scrollFollowers: no scroll container (list fits or not yet hydrated)');
    return false;
  }
  const scrollTop = res.scrollTop ?? 0;
  const scrollHeight = res.scrollHeight ?? 0;
  const clientHeight = res.clientHeight ?? 0;
  const remaining = Math.max(0, scrollHeight - scrollTop - clientHeight);
  if (remaining <= 0) {
    logger.debug('actor.scrollFollowers: container already at bottom');
    return false;
  }
  const delta = Math.min(remaining,
    Math.max(MIN_SCROLL_STEP_PX, clientHeight * tempoOrReference(deps.tempo).draw('scroll.depth.dialog')));
  // Rest the cursor on the hover-safe point the locate script found (off the
  // username/avatar/button hover triggers) so the wheel scrolls the list and
  // not an Instagram hover-preview card. Absent → the Interactor picks its own
  // interior entry point.
  await deps.interactor.scroll(res.rect, delta, res.safePoint);
  logger.debug('actor.scrollFollowers (interactor)', {
    scrollTop,
    scrollHeight,
    delta,
    safePoint: res.safePoint ?? null,
  });
  return true;
}
