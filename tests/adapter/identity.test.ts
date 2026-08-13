import { resolveOwnUsername, usernameFromProfileUrl, type IdentityTab } from '@/adapter/identity';

describe('usernameFromProfileUrl', () => {
  it('extracts the username from a bare profile path', () => {
    expect(usernameFromProfileUrl('/myuser/')).toBe('myuser');
    expect(usernameFromProfileUrl('/my.user_1/')).toBe('my.user_1');
  });
  it('extracts from a full profile URL', () => {
    expect(usernameFromProfileUrl('https://www.instagram.com/myuser/')).toBe('myuser');
  });
  it('rejects the home page, nested paths, and reserved routes', () => {
    expect(usernameFromProfileUrl('https://www.instagram.com/')).toBeNull();
    expect(usernameFromProfileUrl('/foo/bar/')).toBeNull();
    expect(usernameFromProfileUrl('/explore/')).toBeNull();
    expect(usernameFromProfileUrl('/p/')).toBeNull();
    expect(usernameFromProfileUrl('/accounts/')).toBeNull();
  });
});

/**
 * A fake tab that returns a scripted value per resolution strategy.
 *
 * - `alt` is the RAW avatar alt text (e.g. "altuser's profile picture") — the
 *   extraction now happens main-process side via the surface.
 * - `api` is the username the `current_user` endpoint reports; the fake wraps
 *   it in the FetchEnvelope the surface's fetch script resolves to. `apiWall`
 *   simulates an HTML/error wall (typed non-ok envelope, never a throw).
 */
function fakeTab(cfg: {
  href?: string | null;
  alt?: string | null;
  clickable?: boolean;
  profileUrlAfterClick?: string;
  api?: string | null;
  apiWall?: boolean;
}): IdentityTab {
  let url = 'https://www.instagram.com/';
  return {
    async goto(u: string) {
      url = u;
    },
    currentUrl() {
      return url;
    },
    async evaluate<T>(script: string | (() => unknown)): Promise<T> {
      const s = String(script);
      let out: unknown = null;
      if (s.includes('current_user')) {
        out = cfg.apiWall
          ? { ok: false, status: 429, contentType: 'text/html', textHead: '<!DOCTYPE html>' }
          : cfg.api
            ? {
                ok: true,
                status: 200,
                contentType: 'application/json',
                json: { user: { username: cfg.api } },
              }
            : { ok: false, status: 404, contentType: 'application/json', textHead: '' };
      } else if (s.includes('a.click()')) {
        out = cfg.clickable ?? false;
        if (cfg.clickable && cfg.profileUrlAfterClick) url = cfg.profileUrlAfterClick;
      } else if (s.includes('profile picture')) out = cfg.alt ?? null;
      else out = cfg.href ?? null; // readProfileHrefScript
      return out as T;
    },
  };
}

const opts = { attempts: 1, retryMs: 1 };

describe('resolveOwnUsername strategy precedence', () => {
  it('1) resolves from the nav profile-link href (no navigation)', async () => {
    expect(await resolveOwnUsername(fakeTab({ href: '/myuser/' }), opts)).toBe('myuser');
  });

  it('2) falls back to the avatar alt text', async () => {
    expect(
      await resolveOwnUsername(
        fakeTab({ href: null, alt: "altuser's profile picture" }),
        opts,
      ),
    ).toBe('altuser');
  });

  it('3) clicks through and reads the resulting profile URL', async () => {
    const tab = fakeTab({
      href: null,
      alt: null,
      clickable: true,
      profileUrlAfterClick: 'https://www.instagram.com/clickeduser/',
    });
    expect(await resolveOwnUsername(tab, opts)).toBe('clickeduser');
  });

  it('4) last resort: current_user endpoint', async () => {
    const tab = fakeTab({ href: null, alt: null, clickable: false, api: 'apiuser' });
    expect(await resolveOwnUsername(tab, opts)).toBe('apiuser');
  });

  it('returns undefined when nothing resolves', async () => {
    const tab = fakeTab({ href: null, alt: null, clickable: false, api: null });
    expect(await resolveOwnUsername(tab, opts)).toBeUndefined();
  });

  it('an HTML/error wall from current_user is a typed miss (no throw)', async () => {
    const tab = fakeTab({ href: null, alt: null, clickable: false, apiWall: true });
    await expect(resolveOwnUsername(tab, opts)).resolves.toBeUndefined();
  });
});
