/**
 * Resolve the logged-in user's OWN username — robustly.
 *
 * The private `current_user` JSON endpoint is unreliable in the embedded tab
 * (it answers "useragent mismatch" in practice), which was a long-standing cause
 * of the username never resolving. The reliable signal is the profile itself:
 * the nav profile-avatar link's `href` IS `/<username>/`, and navigating to our
 * own profile lands the URL on the profile path. We lead with those and keep
 * the JSON endpoint only as a last resort.
 *
 * This file is version-agnostic: every in-page script and every piece of
 * Instagram DOM/URL knowledge (profile-path shape, avatar alt format, reserved
 * routes) comes from the active `SURFACE` version module.
 */

import * as logger from '@/utils/logger';
import { SURFACE, asFetchEnvelope } from '@/adapter/ig-surface';

/** The narrow tab surface this resolver needs; `InstagramTab` satisfies it. */
export interface IdentityTab {
  goto(url: string): Promise<void>;
  evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T>;
  currentUrl(): string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    const msg = String(e);
    // A destroyed/absent tab won't recover across retries — let the resolver
    // abort at once instead of logging the same failure for every script.
    if (msg.includes('webContents unavailable')) throw e;
    logger.warn('identity: evaluate failed', { label, error: msg });
    return null;
  }
}

/**
 * Resolve the logged-in user's own username, or `undefined` if not resolvable.
 *
 * Strategy order (most to least reliable, non-destructive first):
 *   1. nav profile-link href → `/<username>/`  (no navigation)
 *   2. the avatar's alt text (parsed by the surface's alt-format knowledge)
 *   3. click the profile link → read the resulting profile URL
 *   4. `current_user` JSON endpoint (last resort; envelope-checked, never throws
 *      on an HTML/error body)
 *
 * The whole thing is retried a few times so a not-yet-hydrated page recovers.
 */
export async function resolveOwnUsername(
  tab: IdentityTab,
  opts: { attempts?: number; retryMs?: number } = {},
): Promise<string | undefined> {
  const attempts = opts.attempts ?? 4;
  const retryMs = opts.retryMs ?? 1200;
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

    // 3) click through to our profile and read the URL.
    const clicked = await tryEvaluate<boolean>(
      tab, SURFACE.clickProfileLinkScript(), 'click-profile',
    );
    if (clicked) {
      for (let i = 0; i < 15; i++) {
        await sleep(300);
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

    // 4) last resort: private JSON endpoint (FetchEnvelope; an HTML/error body
    //    is a typed miss, never a throw).
    const raw = await tryEvaluate<unknown>(tab, SURFACE.currentUserScript(), 'current-user');
    const env = asFetchEnvelope(raw);
    if (env !== null && !env.ok) {
      logger.warn('identity: current_user endpoint answered non-JSON/non-ok', {
        status: env.status,
        contentType: env.contentType,
      });
    }
    const fromApi = env?.ok ? SURFACE.extractCurrentUsername(env.json) : null;
    if (fromApi && SURFACE.usernameFromProfileUrl(`/${fromApi}/`)) {
      logger.info('identity: resolved via current_user', { username: fromApi });
      return fromApi;
    }

    if (attempt < attempts - 1) await sleep(retryMs);
   }
  } catch (e) {
    // The tab's webContents was destroyed/absent (a hard load failure or a
    // teardown race). Retrying can't recover it — abort with one clear line.
    logger.warn('identity: tab unavailable, aborting username resolution', { error: String(e) });
    return undefined;
  }

  logger.warn('identity: could not resolve own username by any method');
  return undefined;
}
