/**
 * Resolve the logged-in user's OWN username — robustly.
 *
 * The reliable signal is the profile itself: the nav profile-avatar link's
 * `href` IS `/<username>/`, and navigating to our own profile lands the URL on
 * the profile path. The private `current_user` JSON endpoint used to be the
 * last resort; Instagram retired it for the web (live 2026-10-08 it answers a
 * 200 HTML page redirected to `/`), so it is no longer asked at all — a dead
 * request that only ever returned a wall, which the envelope classifier reads
 * as a rate limit.
 *
 * This file is version-agnostic: every in-page script and every piece of
 * Instagram DOM/URL knowledge (profile-path shape, avatar alt format, reserved
 * routes) comes from the active `SURFACE` version module.
 */

import type { ActorInteractor } from '@/adapter/actor';
import { ActionAbortedError, AdapterStaleError, TabUnavailableError, TabUnresponsiveError } from '@/adapter/errors';
import { type LocatedRect, type LocateRectResult, SURFACE } from '@/adapter/ig-surface';
import { settleAndPress } from '@/adapter/settle-press';
import type { Navigable } from '@/adapter/tab-ports';
import { ADAPTER } from '@/timing/config';
import { pauseBeforePageRetry } from '@/timing/page-pacing';
import { type Rng, sleep } from '@/timing/primitives';
import * as logger from '@/utils/logger';

/** The narrow tab surface this resolver needs; `InstagramTab` satisfies it. */
export type IdentityTab = Navigable;

export interface IdentityOptions {
  attempts?: number;
  retryMs?: number;
  signal?: AbortSignal;
  rng?: Rng;
  /** Production supplies the guarded CDP interactor even before the graph exists. */
  interactor?: Pick<ActorInteractor, 'click' | 'hover'>;
}

/**
 * Extract a username from a profile URL/path (a full profile URL or a bare
 * `/foo/` path). Returns null for the home page, nested paths, or reserved
 * routes. (Delegates to the version module; re-exported here for existing
 * callers.)
 */
export function usernameFromProfileUrl(url: string): string | null {
  return SURFACE.usernameFromProfileUrl(url);
}

async function tryEvaluate<T>(tab: IdentityTab, script: string, label: string): Promise<T | null> {
  try {
    return await tab.evaluate<T>(script);
  } catch (e) {
    // A destroyed/absent tab won't recover across retries — let the resolver
    // abort at once instead of logging the same failure for every script.
    if (e instanceof TabUnavailableError || e instanceof TabUnresponsiveError) throw e;
    logger.warn('identity: evaluate failed', { label, error: String(e) });
    return null;
  }
}

/** A located rect a press can land on: finite and not degenerate. */
const pressable = (rect: LocatedRect | undefined): rect is LocatedRect =>
  rect !== undefined && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
  && rect.width >= 2 && rect.height >= 2;

/** The nav rail re-renders as the cursor arrives: settle, locate again, press. */
async function clickProfile(tab: IdentityTab, opts: IdentityOptions): Promise<boolean> {
  const interactor = opts.interactor;
  if (!interactor || opts.signal?.aborted) return false;
  const locate = (): Promise<LocateRectResult | null> =>
    opts.signal?.aborted
      ? Promise.resolve(null)
      : tryEvaluate<LocateRectResult>(tab, SURFACE.locateProfileLinkScript(), 'locate-profile');
  try {
    const first = await locate();
    if (opts.signal?.aborted) return false;
    return (await settleAndPress(interactor, first, locate, pressable)) !== null;
  } catch (error) {
    // The link navigates in-page; a route change racing the release's ACK is
    // post-click UNCERTAINTY, not failure — the caller verifies by the URL.
    if (error instanceof TabUnresponsiveError && error.phase === 'post-click') return true;
    if (!(error instanceof AdapterStaleError)) throw error;
    logger.debug('identity: profile control changed before click', { error: String(error) });
    return false;
  }
}

/**
 * Resolve the logged-in user's own username, or `undefined` if not resolvable.
 *
 * Strategy order (most to least reliable, non-destructive first):
 *   1. nav profile-link href → `/<username>/`  (no navigation)
 *   2. the avatar's alt text (parsed by the surface's alt-format knowledge)
   *   3. guarded native settle-then-press of the profile link → read the
 *      resulting profile URL
 *
 * The whole thing is retried a few times so a not-yet-hydrated page recovers.
 */
export async function resolveOwnUsername(
  tab: IdentityTab,
  opts: IdentityOptions = {},
): Promise<string | undefined> {
  const attempts = opts.attempts ?? ADAPTER.IDENTITY_ATTEMPTS;
  const retryMs = opts.retryMs ?? ADAPTER.IDENTITY_RETRY_MS;
  if (opts.signal?.aborted) return undefined;
  const home = `${SURFACE.origin}/`;

  // Ensure we're on the Instagram origin so the nav is present. The base
  // domain is derived from the surface origin (any subdomain counts).
  const baseDomain = new URL(home).hostname.replace(/^www\./, '');
  try {
    if (!tab.currentUrl().includes(baseDomain)) await tab.goto(home);
  } catch (e) {
    logger.warn('identity: could not ensure instagram origin', { error: String(e) });
  }

  try {
   for (let attempt = 0; attempt < attempts; attempt++) {
    // A shutdown (or driver stop) must not sit out the retry loop.
    if (opts.signal?.aborted) return undefined;
    // 1) nav profile-link href — the primary, non-destructive path.
    const href = await tryEvaluate<string | null>(
      tab, SURFACE.readProfileHrefScript(), 'profile-href',
    );
    const fromHref = href ? SURFACE.usernameFromProfileUrl(href) : null;
    if (fromHref) {
      logger.info('identity: resolved via nav profile link', { username: fromHref });
      return fromHref;
    }

    // 2) avatar alt text — parsed here (via the surface), not in-page.
    const alt = await tryEvaluate<string | null>(
      tab, SURFACE.readAvatarAltScript(), 'avatar-alt',
    );
    const fromAlt = alt ? SURFACE.usernameFromAvatarAlt(alt) : null;
    if (fromAlt && SURFACE.usernameFromProfileUrl(`/${fromAlt}/`)) {
      logger.info('identity: resolved via avatar alt', { username: fromAlt });
      return fromAlt;
    }

    // 3) Locate only in-page; every press uses the guarded input transport.
    const clicked = await clickProfile(tab, opts);
    if (opts.signal?.aborted) return undefined;
    if (clicked) {
      for (let i = 0; i < ADAPTER.NAV_SETTLE_ROUNDS; i++) {
        if (opts.signal?.aborted) return undefined;
        await sleep(ADAPTER.NAV_SETTLE_MS, opts.signal);
        if (opts.signal?.aborted) return undefined;
        let url = '';
        try {
          url = tab.currentUrl();
        } catch {
          /* transient during nav */
        }
        const fromUrl = SURFACE.usernameFromProfileUrl(url);
        if (fromUrl) {
          logger.info('identity: resolved via profile navigation', { username: fromUrl });
          return fromUrl;
        }
      }
    }

    if (attempt < attempts - 1) await pauseBeforePageRetry(retryMs, opts.signal, opts.rng);
   }
  } catch (e) {
    if (e instanceof ActionAbortedError || opts.signal?.aborted) return undefined;
    // The tab's webContents was destroyed/absent (a hard load failure or a
    // teardown race). Retrying can't recover it — abort with one clear line.
    logger.warn('identity: input or tab failed, aborting username resolution', { error: String(e) });
    return undefined;
  }

  logger.warn('identity: could not resolve own username by any method');
  return undefined;
}
