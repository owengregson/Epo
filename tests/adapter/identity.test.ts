import { AdapterStaleError, TabUnavailableError, TabUnresponsiveError } from '@/adapter/errors';
import { type IdentityTab, resolveOwnUsername, usernameFromProfileUrl } from '@/adapter/identity';
import { FakeInteractor } from '../kit/tabs';

const profileRect = { x: 100, y: 200, width: 40, height: 40 };
/** The same rail link once the cursor has arrived and the rail has expanded. */
const settledRect = { x: 100, y: 214, width: 214, height: 17 };

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
 * - `hovered` reports whether the cursor has rested on the rail yet: the link
 *   locates at `profileRect` before, `settledRect` after (the rail re-renders).
 * - Any `current_user` request is answered as Instagram answers it since
 *   2026-10: a 200 HTML page at `/` — so a test that reached it would see it.
 */
function fakeTab(cfg: {
  href?: string | null;
  alt?: string | null;
  clickable?: boolean;
  evaluations?: string[];
  onLocate?: () => void;
  hovered?: () => boolean;
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
        out = { ok: false, status: 200, contentType: 'text/html', finalUrl: 'https://www.instagram.com/', textHead: '<!DOCTYPE html>' };
      } else if (s.includes('"control":"profile-link-click"')) {
        throw new Error('Synthetic identity click must never execute');
      } else if (s.includes('"control":"profile-link"')) {
        cfg.onLocate?.();
        out = cfg.clickable
          ? { found: true, rect: cfg.hovered?.() ? settledRect : profileRect }
          : { found: false };
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

  it('3) rests on the rail link, locates it again, presses it and reads the profile URL', async () => {
    const interactor = new FakeInteractor();
    const tab = fakeTab({
      href: null,
      alt: null,
      clickable: true,
      hovered: () => interactor.hovers.length > 0,
    });
    interactor.onClick = () => { void tab.goto('https://www.instagram.com/clickeduser/'); };
    expect(await resolveOwnUsername(tab, { ...opts, interactor })).toBe('clickeduser');
    expect(interactor.hovers).toEqual([profileRect]);
    expect(interactor.clicks).toEqual([settledRect]);
  });

  it('never asks the retired current_user endpoint (it answers HTML at / since 2026-10)', async () => {
    const evaluations: string[] = [];
    const tab = fakeTab({ href: null, alt: null, clickable: false, evaluations });
    expect(await resolveOwnUsername(tab, opts)).toBeUndefined();
    expect(evaluations.some((script) => script.includes('current_user'))).toBe(false);
  });

  it('returns undefined when nothing resolves', async () => {
    const tab = fakeTab({ href: null, alt: null, clickable: false });
    expect(await resolveOwnUsername(tab, opts)).toBeUndefined();
  });

  it('without native input skips the click strategy entirely', async () => {
    const evaluations: string[] = [];
    const tab = fakeTab({ clickable: true, evaluations });
    expect(await resolveOwnUsername(tab, opts)).toBeUndefined();
    expect(evaluations.some((script) => script.includes('"control":"profile-link-click"'))).toBe(false);
    expect(evaluations.some((script) => script.includes('"control":"profile-link"'))).toBe(false);
  });

  it('a guarded target miss is a miss, never a forced click', async () => {
    const tab = fakeTab({ clickable: true });
    const interactor = new FakeInteractor();
    interactor.onClick = () => { throw new AdapterStaleError('input.click', 'covered'); };
    expect(await resolveOwnUsername(tab, { ...opts, interactor })).toBeUndefined();
  });

  it('a post-click UNCERTAIN press is verified by the URL (in-page route change raced the ACK)', async () => {
    const interactor = new FakeInteractor();
    const tab = fakeTab({ href: null, alt: null, clickable: true });
    interactor.onClick = () => {
      void tab.goto('https://www.instagram.com/clickeduser/');
      throw new TabUnresponsiveError('input:document-changed-after-press', 15_000, 'post-click');
    };
    expect(await resolveOwnUsername(tab, { ...opts, interactor })).toBe('clickeduser');
  });

  it('a broken input transport stops resolution before further page work', async () => {
    const evaluations: string[] = [];
    const tab = fakeTab({ clickable: true, evaluations });
    const interactor = new FakeInteractor();
    interactor.onClick = () => { throw new TabUnavailableError('input'); };
    expect(await resolveOwnUsername(tab, { ...opts, interactor })).toBeUndefined();
    expect(evaluations.some((script) => script.includes('current_user'))).toBe(false);
  });

  it('aborting during locate prevents pressing', async () => {
    const controller = new AbortController();
    const evaluations: string[] = [];
    const tab = fakeTab({ clickable: true, evaluations, onLocate: () => controller.abort() });
    const interactor = new FakeInteractor();
    expect(await resolveOwnUsername(tab, { ...opts, interactor, signal: controller.signal })).toBeUndefined();
    expect(interactor.hovers).toEqual([]);
    expect(interactor.clicks).toEqual([]);
    expect(evaluations.some((script) => script.includes('current_user'))).toBe(false);
  });

  it('failed resolution attempts draw fresh bounded retry spacing', async () => {
    jest.useFakeTimers();
    const retries: number[] = [];
    const draws = [0, 1];
    let index = 0;
    try {
      const resolving = resolveOwnUsername(fakeTab({}), {
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

  it('aborting during navigation settle ends resolution', async () => {
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
