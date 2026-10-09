import { AdapterStaleError, TabUnavailableError, TabUnresponsiveError } from '@/adapter/errors';
import { type IdentityTab, resolveOwnUsername, usernameFromProfileUrl } from '@/adapter/identity';
import { FakeInteractor } from '../kit/tabs';

const profileRect = { x: 100, y: 200, width: 40, height: 40 };

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
  evaluations?: string[];
  onLocate?: () => void;
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
      cfg.evaluations?.push(s);
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
      } else if (s.includes('"control":"profile-link-click"')) {
        throw new Error('Synthetic identity click must never execute');
      } else if (s.includes('"control":"profile-link"')) {
        cfg.onLocate?.();
        out = cfg.clickable ? { found: true, rect: profileRect } : { found: false };
      } else if (s.includes('"control":"avatar-alt"')) out = cfg.alt ?? null;
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
    });
    const interactor = new FakeInteractor();
    interactor.onClick = () => { void tab.goto('https://www.instagram.com/clickeduser/'); };
    expect(await resolveOwnUsername(tab, { ...opts, interactor })).toBe('clickeduser');
    expect(interactor.clicks).toEqual([profileRect]);
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

  it('without native input skips the click fallback and resolves from API', async () => {
    const evaluations: string[] = [];
    const tab = fakeTab({ clickable: true, api: 'apiuser', evaluations });
    expect(await resolveOwnUsername(tab, opts)).toBe('apiuser');
    expect(evaluations.some((script) => script.includes('"control":"profile-link-click"'))).toBe(false);
    expect(evaluations.some((script) => script.includes('"control":"profile-link"'))).toBe(false);
  });

  it('a guarded target miss falls through to API without forcing a click', async () => {
    const tab = fakeTab({ clickable: true, api: 'apiuser' });
    const interactor = new FakeInteractor();
    interactor.onClick = () => { throw new AdapterStaleError('input.click', 'covered'); };
    expect(await resolveOwnUsername(tab, { ...opts, interactor })).toBe('apiuser');
  });

  it('a broken input transport stops resolution before further API work', async () => {
    const evaluations: string[] = [];
    const tab = fakeTab({ clickable: true, api: 'apiuser', evaluations });
    const interactor = new FakeInteractor();
    interactor.onClick = () => { throw new TabUnavailableError('input'); };
    expect(await resolveOwnUsername(tab, { ...opts, interactor })).toBeUndefined();
    expect(evaluations.some((script) => script.includes('current_user'))).toBe(false);
  });

  it('aborting during locate prevents both pressing and the API fallback', async () => {
    const controller = new AbortController();
    const evaluations: string[] = [];
    const tab = fakeTab({ clickable: true, evaluations, onLocate: () => controller.abort() });
    const interactor = new FakeInteractor();
    expect(await resolveOwnUsername(tab, { ...opts, interactor, signal: controller.signal })).toBeUndefined();
    expect(interactor.clicks).toEqual([]);
    expect(evaluations.some((script) => script.includes('current_user'))).toBe(false);
  });

  it('failed resolution attempts draw fresh bounded retry spacing', async () => {
    jest.useFakeTimers();
    const retries: number[] = [];
    const draws = [0, 1];
    let index = 0;
    try {
      const resolving = resolveOwnUsername(fakeTab({ api: null }), {
        attempts: 3, retryMs: 2_000,
        rng: () => { retries.push(Date.now()); return draws[index++]; },
      });
      await jest.runAllTimersAsync();
      expect(await resolving).toBeUndefined();
      expect(retries).toHaveLength(2);
      expect(retries[1] - retries[0]).toBe(1_400);
      expect(Date.now() - retries[1]).toBe(2_900);
    } finally { jest.useRealTimers(); }
  });

  it('aborting during navigation settle prevents the API fallback', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const evaluations: string[] = [];
    const interactor = new FakeInteractor();
    try {
      const resolving = resolveOwnUsername(fakeTab({ clickable: true, evaluations }), {
        ...opts, interactor, signal: controller.signal,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(interactor.clicks).toHaveLength(1);
      controller.abort();
      expect(await resolving).toBeUndefined();
      expect(evaluations.some((script) => script.includes('current_user'))).toBe(false);
    } finally { jest.useRealTimers(); }
  });

  it('a stalled tab stops before attempting further page scripts', async () => {
    const tab = fakeTab({});
    const evaluate = jest.spyOn(tab, 'evaluate').mockRejectedValue(new TabUnresponsiveError('evaluate', 100));
    expect(await resolveOwnUsername(tab, opts)).toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
