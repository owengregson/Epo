/**
 * Resolve the logged-in user's OWN username — robustly.
 *
 * The private `current_user` JSON endpoint is unreliable in the embedded tab
 * (it answers "useragent mismatch" in practice), which was a long-standing cause
 * of the username never resolving. The reliable signal is the profile itself:
 * the nav profile-avatar link's `href` IS `/<username>/`, and navigating to our
 * own profile lands the URL on `instagram.com/<username>/`. We lead with those
 * and keep the JSON endpoint only as a last resort.
 */

import * as logger from '@/utils/logger';

/** The narrow tab surface this resolver needs; `InstagramTab` satisfies it. */
export interface IdentityTab {
  goto(url: string): Promise<void>;
  evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T>;
  currentUrl(): string;
}

const IG_HOME = 'https://www.instagram.com/';
const IG_APP_ID = '936619743392459';

/** Non-username first path segments that must never be taken as a username. */
const RESERVED = new Set([
  'explore', 'reels', 'reel', 'direct', 'stories', 'p', 'tv', 'accounts', 'about',
  'legal', 'privacy', 'terms', 'api', 'directory', 'your_activity', 'emails',
  'session', 'challenge', 'oauth', 'developer', 'ads', 'business', 'help',
]);

const USERNAME_RE = /^[A-Za-z0-9._]+$/;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Extract a username from a profile URL/path like `https://instagram.com/foo/`
 * or `/foo/`. Returns null for the home page, nested paths, or reserved routes.
 */
export function usernameFromProfileUrl(url: string): string | null {
  let path = url;
  try {
    path = new URL(url, IG_HOME).pathname;
  } catch {
    // treat `url` as already a path
  }
  const m = path.match(/^\/([^/]+)\/?$/);
  if (!m) return null;
  const candidate = m[1];
  if (!USERNAME_RE.test(candidate) || RESERVED.has(candidate.toLowerCase())) return null;
  return candidate;
}

// In-page script: read the nav profile-avatar link's href (`/<username>/`).
// The profile link is the anchor whose href is a bare profile path AND that
// contains the avatar <img>; prefer ones inside a <nav>/[role=navigation].
const READ_PROFILE_HREF = `(() => {
  const isProfilePath = (h) => /^\\/[A-Za-z0-9._]+\\/$/.test(h || '');
  const scopes = Array.prototype.slice.call(document.querySelectorAll('nav, [role="navigation"]'));
  scopes.push(document.body);
  for (const scope of scopes) {
    const anchors = scope.querySelectorAll('a[href]');
    for (const a of anchors) {
      const h = a.getAttribute('href');
      if (isProfilePath(h) && a.querySelector('img')) return h;
    }
  }
  return null;
})()`;

// In-page script: click the nav profile-avatar link (to navigate to our profile).
const CLICK_PROFILE_LINK = `(() => {
  const isProfilePath = (h) => /^\\/[A-Za-z0-9._]+\\/$/.test(h || '');
  const scopes = Array.prototype.slice.call(document.querySelectorAll('nav, [role="navigation"]'));
  for (const scope of scopes) {
    const anchors = scope.querySelectorAll('a[href]');
    for (const a of anchors) {
      const h = a.getAttribute('href');
      if (isProfilePath(h) && a.querySelector('img')) { a.click(); return true; }
    }
  }
  return false;
})()`;

// In-page script: avatar alt text like "username's profile picture".
const READ_AVATAR_ALT = `(() => {
  const img = document.querySelector('img[alt*="profile picture"], img[alt*="profile photo"]');
  if (!img) return null;
  const alt = img.getAttribute('alt') || '';
  const m = alt.match(/^([A-Za-z0-9._]+)['\\u2019]s profile/);
  return m ? m[1] : null;
})()`;

// In-page script: last-resort private JSON endpoint.
const FETCH_CURRENT_USER = `fetch('/api/v1/accounts/current_user/', { headers: { 'x-ig-app-id': '${IG_APP_ID}' }, credentials: 'include' })
  .then(function(r){ return r.ok ? r.json() : null; })
  .then(function(j){ return (j && j.user && j.user.username) ? j.user.username : null; })
  .catch(function(){ return null; })`;

async function tryEvaluate<T>(tab: IdentityTab, script: string, label: string): Promise<T | null> {
  try {
    return await tab.evaluate<T>(script);
  } catch (e) {
    logger.warn('identity: evaluate failed', { label, error: String(e) });
    return null;
  }
}

/**
 * Resolve the logged-in user's own username, or `undefined` if not resolvable.
 *
 * Strategy order (most to least reliable, non-destructive first):
 *   1. nav profile-link href → `/<username>/`  (no navigation)
 *   2. avatar alt text "username's profile picture"
 *   3. click the profile link → read the resulting profile URL
 *   4. `current_user` JSON endpoint (last resort)
 *
 * The whole thing is retried a few times so a not-yet-hydrated page recovers.
 */
export async function resolveOwnUsername(
  tab: IdentityTab,
  opts: { attempts?: number; retryMs?: number } = {},
): Promise<string | undefined> {
  const attempts = opts.attempts ?? 4;
  const retryMs = opts.retryMs ?? 1200;

  // Ensure we're on instagram.com so the nav is present.
  try {
    if (!tab.currentUrl().includes('instagram.com')) await tab.goto(IG_HOME);
  } catch (e) {
    logger.warn('identity: could not ensure instagram.com', { error: String(e) });
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    // 1) nav profile-link href — the primary, non-destructive path.
    const href = await tryEvaluate<string | null>(tab, READ_PROFILE_HREF, 'profile-href');
    const fromHref = href ? usernameFromProfileUrl(href) : null;
    if (fromHref) {
      logger.info('identity: resolved via nav profile link', { username: fromHref });
      return fromHref;
    }

    // 2) avatar alt text.
    const fromAlt = await tryEvaluate<string | null>(tab, READ_AVATAR_ALT, 'avatar-alt');
    if (fromAlt && usernameFromProfileUrl('/' + fromAlt + '/')) {
      logger.info('identity: resolved via avatar alt', { username: fromAlt });
      return fromAlt;
    }

    // 3) click through to our profile and read the URL.
    const clicked = await tryEvaluate<boolean>(tab, CLICK_PROFILE_LINK, 'click-profile');
    if (clicked) {
      for (let i = 0; i < 15; i++) {
        await sleep(300);
        let url = '';
        try {
          url = tab.currentUrl();
        } catch {
          /* transient during nav */
        }
        const fromUrl = usernameFromProfileUrl(url);
        if (fromUrl) {
          logger.info('identity: resolved via profile navigation', { username: fromUrl });
          return fromUrl;
        }
      }
    }

    // 4) last resort: private JSON endpoint.
    const fromApi = await tryEvaluate<string | null>(tab, FETCH_CURRENT_USER, 'current-user');
    if (fromApi && usernameFromProfileUrl('/' + fromApi + '/')) {
      logger.info('identity: resolved via current_user', { username: fromApi });
      return fromApi;
    }

    if (attempt < attempts - 1) await sleep(retryMs);
  }

  logger.warn('identity: could not resolve own username by any method');
  return undefined;
}
