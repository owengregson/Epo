/**
 * Profile VISIT + ProfileObserver, end to end over a real Reader and store.
 *
 * Live 2026-10-08: every REST profile read Epo composed was walled, while the
 * profile PAGE works and its own client fetches `PolarisProfilePageContentQuery`
 * (counts, bio, `friendship_status`). A visit navigates and reads THAT body.
 * Pinned here: one parse + one store write per body, the write lands BEFORE
 * the visit resolves, the viewer flags, and every typed non-ok outcome.
 */
import { ActionAbortedError, TabUnavailableError } from '@/adapter/errors';
import type { SentinelStatus } from '@/adapter/ig-surface';
import { Reader } from '@/adapter/reader';
import { FakeClock } from '@/governors/clock';
import { MOTION } from '@/kernel/motion-policy';
import { ProfileObserver } from '@/rim/profile-observer';
import { TabProfileVisitor } from '@/rim/profile-visit';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { clamp, logNormal } from '@/timing/distributions';
import { sample } from '@/timing/primitives';
import { setLevel } from '@/utils/logger';
import { openTestStore } from '../kit/store';
import { PROFILE_QUERY as PROFILE_REQUEST, readAs } from '../kit/surface';
import { marker, NetworkTab } from '../kit/tabs';

beforeAll(() => setLevel('error'));

const GRAPHQL = 'https://www.instagram.com/api/graphql';
const PROFILE_QUERY = { 'x-fb-friendly-name': 'PolarisProfilePageContentQuery' };

/** The GraphQL profile body as the page's client receives it. */
const profileBody = (pk: string, username: string, fs: Record<string, boolean> | null = null) => ({
  data: {
    user: {
      pk,
      id: pk,
      username,
      follower_count: 781,
      following_count: 796,
      mutual_followers_count: 35,
      is_private: false,
      is_verified: false,
      biography: 'hi',
      friendship_status: fs,
    },
  },
});

/** A tab whose navigation makes "the page" fetch what `pages` scripts for that URL. */
class PageTab extends NetworkTab {
  pages: Record<string, () => void> = {};
  gotoError: Error | null = null;
  override async goto(u: string): Promise<void> {
    if (this.gotoError) throw this.gotoError;
    await super.goto(u);
    this.pages[u]?.();
  }
}

const serve = (tab: PageTab, body: unknown, requestId = 'r1') =>
  tab.emit({
    requestId,
    url: GRAPHQL,
    status: 200,
    mimeType: 'text/javascript',
    requestHeaders: PROFILE_QUERY,
    body,
  });

let store: KnowledgeStore;
beforeEach(() => {
  store = openTestStore(':memory:');
});
afterEach(() => store.close());

const setup = (sentinel: SentinelStatus = 'ok', abortSignal?: () => AbortSignal | undefined) => {
  const tab = new PageTab();
  tab.on(marker('"control":"profile-unavailable"'), () => ({ found: false }));
  const observer = new ProfileObserver({ tab, reader: new Reader(), store, clock: new FakeClock(1_000) });
  const stop = observer.start();
  const visitor = new TabProfileVisitor({
    tab,
    observer,
    sentinel: { check: async () => sentinel },
    abortSignal,
    waitMs: 20,
    pollMs: 1,
  });
  return { tab, observer, visitor, stop };
};

describe('a profile visit reads the body the page fetched', () => {
  test('ok: the counts are in the store when the visit resolves, with the viewer flags', async () => {
    const { tab, visitor } = setup();
    const writes = jest.spyOn(store, 'observe');
    tab.pages['https://www.instagram.com/user_007/'] = () =>
      serve(tab, profileBody('503', 'user_007', { following: true, outgoing_request: false, followed_by: true }));

    const visit = await visitor.visit('user_007');

    expect(visit.ok).toBe(true);
    if (!visit.ok) return;
    expect(visit.obs.accountPk).toBe('503');
    // `incoming_request` is absent from this body: unknown, never false.
    expect(visit.viewer).toEqual({ following: true, requested: false, followsUs: true, incomingRequest: null });
    const acc = store.getAccount('503');
    expect(acc?.followers).toBe(781);
    expect(acc?.following).toBe(796);
    expect(acc?.mutuals).toBe(35);
    expect(writes).toHaveBeenCalledTimes(1); // one parse, one write
  });

  test('our own profile carries no friendship_status: every flag reads null', async () => {
    const { tab, visitor } = setup();
    tab.pages['https://www.instagram.com/me/'] = () => serve(tab, profileBody('1', 'me'));

    const visit = await visitor.visit('me');

    expect(visit.ok && visit.viewer).toEqual({ following: null, requested: null, followsUs: null, incomingRequest: null });
  });

  test("another profile's body never answers the visit (it is still harvested)", async () => {
    const { tab, visitor } = setup();
    tab.pages['https://www.instagram.com/wanted/'] = () => serve(tab, profileBody('9', 'someone_else'));

    const visit = await visitor.visit('wanted');

    expect(visit).toMatchObject({ ok: false, kind: 'unanswered' });
    expect(store.getAccount('9')?.username).toBe('someone_else'); // facts stream regardless
  });

  test('the username match is case-insensitive', async () => {
    const { tab, visitor } = setup();
    tab.pages['https://www.instagram.com/User_008/'] = () => serve(tab, profileBody('5', 'user_008'));

    expect((await visitor.visit('User_008')).ok).toBe(true);
  });
});

describe('typed non-ok outcomes', () => {
  test('gone: the page renders "not available" and fetches no profile', async () => {
    const { tab, visitor } = setup();
    tab.scripts.length = 0;
    tab.on(marker('"control":"profile-unavailable"'), () => ({ found: true, rect: { x: 1, y: 1, width: 9, height: 9 } }));

    expect(await visitor.visit('nobody_here')).toMatchObject({ ok: false, kind: 'gone' });
  });

  test('walled: nothing answered and the sentinel names a wall', async () => {
    const { visitor } = setup('action-blocked');
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'walled', detail: { status: 'action-blocked' } });
  });

  test('unanswered: nothing answered, no wall, no unavailable page — drift until proven otherwise', async () => {
    const { visitor } = setup();
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'unanswered' });
  });

  test('tab: a tab that cannot navigate is a typed outcome, never a throw', async () => {
    const { tab, visitor } = setup();
    tab.gotoError = new TabUnavailableError('goto');
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'tab' });
  });

  test('a stopped driver aborts the wait instead of sitting it out', async () => {
    const ac = new AbortController();
    ac.abort();
    const { visitor } = setup('ok', () => ac.signal);
    await expect(visitor.visit('x')).rejects.toBeInstanceOf(ActionAbortedError);
  });
});

describe('outcome precedence: evidence decides, never a guess (spec §10.4, U10 F5)', () => {
  const unavailable = (tab: PageTab, found: boolean) => {
    tab.scripts.length = 0;
    tab.on(marker('"control":"profile-unavailable"'), () => (found ? { found: true, rect: { x: 1, y: 1, width: 9, height: 9 } } : { found: false }));
  };

  test('a throttle body answering the visit is walled by the body, never gone', async () => {
    const { tab, visitor } = setup();
    tab.pages['https://www.instagram.com/x/'] = () => serve(tab, { data: { user: null }, errors: [{ message: 'e', summary: 'Try Again Later' }] });
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'walled', detail: { via: 'body', family: 'rate-limited' } });
  });

  test('{data:{user:null}} with errors is a wall to wait out, never "gone"', async () => {
    const { tab, visitor } = setup();
    unavailable(tab, true);
    tab.pages['https://www.instagram.com/x/'] = () => serve(tab, { data: { user: null }, errors: [{ message: 'unknown' }] });
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'walled', detail: { via: 'body', family: 'server-error' } });
  });

  test('an HTTP wall on the profile query is walled by the response', async () => {
    const { tab, visitor } = setup();
    tab.pages['https://www.instagram.com/x/'] = () =>
      tab.emit({ requestId: 'w', url: GRAPHQL, status: 429, mimeType: 'text/html', requestHeaders: PROFILE_QUERY, body: '<html>' });
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'walled', detail: { via: 'body', family: 'rate-limited', status: 429 } });
  });

  test('a clean {data:{user:null}} is gone on the profile-absent evidence', async () => {
    const { tab, visitor } = setup();
    tab.pages['https://www.instagram.com/x/'] = () => serve(tab, { data: { user: null }, extensions: { is_final: true } });
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'gone', evidence: 'profile-absent' });
  });

  test('an unavailable page with no body is gone on page text only', async () => {
    const { tab, visitor } = setup();
    unavailable(tab, true);
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'gone', evidence: 'page-text' });
  });

  test('a drifted body outranks the page text: unanswered with the drift, never gone', async () => {
    const { tab, visitor } = setup();
    unavailable(tab, true);
    tab.pages['https://www.instagram.com/x/'] = () => serve(tab, { data: { profile_v2: { pk: '1' } } });
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'unanswered', detail: { drift: 'mismatch' } });
  });

  test('a stream that is not final never reads as gone', async () => {
    const { tab, visitor } = setup();
    tab.pages['https://www.instagram.com/x/'] = () => serve(tab, { data: { user: null }, extensions: { is_final: false } });
    expect(await visitor.visit('x')).toMatchObject({ ok: false, kind: 'unanswered', detail: { drift: 'incomplete-stream' } });
  });
});

describe('the observer alone (passive harvest, PRINCIPLES §1)', () => {
  test('every profile body the tab loads is written, armed or not', async () => {
    const { tab } = setup();
    serve(tab, profileBody('42', 'passerby'));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getAccount('42')?.followers).toBe(781);
  });

  test('a stopped observer writes nothing', async () => {
    const { tab, stop } = setup();
    stop();
    serve(tab, profileBody('43', 'late'));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getAccount('43')).toBeNull();
  });
});

describe('visits are paced like a person browsing (live 2026-11-02: ten back to back in ~25 s)', () => {
  const paced = (now: () => number, waits: number[], rng = () => 0.5, abortSignal?: () => AbortSignal | undefined) => {
    const tab = new PageTab();
    tab.on(marker('"control":"profile-unavailable"'), () => ({ found: false }));
    const observer = new ProfileObserver({ tab, reader: new Reader(), store, clock: new FakeClock(1_000) });
    observer.start();
    for (const name of ['a', 'b', 'c']) {
      tab.pages[`https://www.instagram.com/${name}/`] = () => serve(tab, profileBody(name, name));
    }
    const visitor = new TabProfileVisitor({
      tab, observer, sentinel: { check: async () => 'ok' }, waitMs: 20, pollMs: 1, abortSignal, now, rng,
      sleep: async (ms) => { waits.push(ms); },
    });
    return visitor;
  };

  test('the first visit waits nothing; the next rests the drawn dwell from the END of the last', async () => {
    let t = 50_000;
    const waits: number[] = [];
    const visitor = paced(() => t, waits);
    await visitor.visit('a');
    expect(waits).toEqual([]);
    t += 2_000; // two seconds already spent since that visit ended
    await visitor.visit('b');
    expect(waits).toHaveLength(1);
    // The policy's own draw (same rng), less the 2 s already elapsed.
    const [min, max] = MOTION.profileDwellMs;
    const drawn = sample(clamp(logNormal(MOTION.profileDwellMedianMs, MOTION.profileDwellSigma), min, max), () => 0.5);
    expect(waits[0]).toBe(drawn - 2_000);
  });

  test('every dwell stays inside the policy bounds, whatever the draw', async () => {
    for (const r of [0.0001, 0.2, 0.8, 0.9999]) {
      const t = 0;
      const waits: number[] = [];
      const visitor = paced(() => t, waits, () => r);
      await visitor.visit('a');
      await visitor.visit('b');
      expect(waits[0]).toBeGreaterThanOrEqual(MOTION.profileDwellMs[0]);
      expect(waits[0]).toBeLessThanOrEqual(MOTION.profileDwellMs[1]);
    }
  });

  test('a visit long after the last one waits nothing', async () => {
    let t = 0;
    const waits: number[] = [];
    const visitor = paced(() => t, waits);
    await visitor.visit('a');
    t += MOTION.profileDwellMs[1] + 1;
    await visitor.visit('b');
    expect(waits).toEqual([]);
  });

  test('a stop during the dwell ends the visit before any navigation', async () => {
    const t = 0;
    const ac = new AbortController();
    const waits: number[] = [];
    const visitor = paced(() => t, waits, () => 0.5, () => ac.signal);
    await visitor.visit('a');
    ac.abort();
    await expect(visitor.visit('b')).rejects.toBeInstanceOf(ActionAbortedError);
  });
});

describe('the read behind a visit: presence, the count pair, our own counts (spec §10.3, §10.4)', () => {
  test('a visit carries which decision-bearing fields the body held, and how it was read', async () => {
    const { tab, visitor } = setup();
    tab.pages['https://www.instagram.com/user_8/'] = () =>
      serve(tab, profileBody('8', 'user_8', { following: false, outgoing_request: false, followed_by: false }));
    const visit = await visitor.visit('user_8');
    expect(visit.ok && { presence: visit.presence, tier: visit.tier, partial: visit.partial }).toEqual({
      presence: { counts: 'read', bio: 'read', isPrivate: 'read', isVerified: 'read', relationship: 'read' },
      tier: 'canonical',
      partial: false,
    });
  });

  test('a partial count pair stores the profile without any count (I5)', async () => {
    const { tab, visitor } = setup();
    const { following_count: _drop, ...user } = profileBody('9', 'user_9').data.user;
    tab.pages['https://www.instagram.com/user_9/'] = () => serve(tab, { data: { user } });
    const visit = await visitor.visit('user_9');
    expect(visit.ok && visit.presence?.counts).toBe('partial');
    expect(store.getAccount('9')).toMatchObject({ username: 'user_9' });
    expect(store.getAccount('9')?.followers ?? null).toBeNull();
    expect(store.getAccount('9')?.following ?? null).toBeNull();
  });

  test('our own counts come only from a canonical or normalized, complete read', () => {
    const reader = new Reader({}, { viewerPk: '1' });
    const own = profileBody('1', 'me');
    const seen = (body: unknown, final: boolean | null = null) =>
      reader.profileSeen(readAs(reader, 'profile-graphql', body, { at: 5 }, PROFILE_REQUEST, final))?.obs.fields;
    expect(seen(own)).toMatchObject({ followers: 781, following: 796 });
    const framed = reader.read('profile-graphql', { text: `for (;;);${JSON.stringify(own)}` },
      { at: 5, route: reader.route(PROFILE_REQUEST) ?? undefined });
    expect(framed).toMatchObject({ tier: 'normalized', partial: false });
    expect(reader.profileSeen(framed)?.obs.fields.followers).toBe(781);
    expect(seen(own, false)).toMatchObject({ followers: undefined, following: undefined, mutuals: undefined });
    expect(seen({ ...own, errors: [{ message: 'x' }] })?.followers).toBeUndefined();
    // Another account's counts are additive: a partial read keeps them.
    expect(seen(profileBody('2', 'other'), false)?.followers).toBe(781);
  });

  test("a null relationship reads as the viewer's own only on our own record (I10)", async () => {
    const tab = new PageTab();
    tab.on(marker('"control":"profile-unavailable"'), () => ({ found: false }));
    const observer = new ProfileObserver({ tab, reader: new Reader({}, { viewerPk: '1' }), store, clock: new FakeClock(1_000),
      ownPk: '1' });
    observer.start();
    const visitor = new TabProfileVisitor({ tab, observer, sentinel: { check: async () => 'ok' }, waitMs: 20, pollMs: 1,
      sleep: async () => {} });
    tab.pages['https://www.instagram.com/me/'] = () => serve(tab, profileBody('1', 'me'));
    tab.pages['https://www.instagram.com/other/'] = () => serve(tab, profileBody('2', 'other'));
    const self = await visitor.visit('me');
    const other = await visitor.visit('other');
    expect(self.ok && self.presence?.relationship).toBe('self');
    expect(other.ok && other.presence?.relationship).toBe('null');
  });
});
