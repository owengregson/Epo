/**
 * ListPageWalker: the prune scan's DIRECT paginated walk of a friendships list
 * — full-size API pages cursor to cursor, jittered per-page pacing, a long rest
 * every few pages, and honest end reasons. An end-of-list claim is VERIFIED by
 * probing one page past it (nothing new = `endConfirmed`; new rows = the claim
 * was false and the walk continues); a transient fetch failure is retried once;
 * `fetch-failed` (two consecutive failures) lets callers fall back to the
 * dialog-scroll scrape.
 */

import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { FakeClock } from '@/governors/clock';
import { referenceTempoSource } from '@/kernel/tempo';
import { ListPageWalker } from '@/rim/list-page-walker';
import { toVeilInfo } from '@/shared/live-op';
import { ADAPTER, RIM } from '@/timing/config';
import { nextRestStride } from '@/timing/noise';
import { setLevel } from '@/utils/logger';
import { FakeSentinel, FakeTab, followersBody } from '../kit/fakes';

beforeAll(() => setLevel('error'));

const reader = new Reader();
const clock = new FakeClock(3_000_000);
const tempo = referenceTempoSource();
/** The retry wait at the harness's pinned rng: `pause.retry` around the walk's rest. */
const RETRY_MS = tempo.policy('pause.retry', { baseMs: tempo.base('walk.rest'), pollMs: ADAPTER.NAV_SETTLE_MS })
  .sample(() => 0.5);

/** A 2xx JSON FetchEnvelope around a followers-list body. */
const okEnv = (body: unknown): unknown => ({
  ok: true,
  status: 200,
  contentType: 'application/json',
  json: body,
});
const failEnv = (status: number): unknown => ({
  ok: false,
  status,
  contentType: 'text/html',
  textHead: '<html>wall</html>',
});
/** The SPECIFIC past-the-limit rejection: a 400 with a JSON error body. */
const rejectEnv = (status: number): unknown => ({
  ok: false,
  status,
  contentType: 'application/json; charset=utf-8',
  textHead: '{"message":"Unable to fetch followers"}',
});

interface Harness {
  walker: ListPageWalker;
  tab: FakeTab;
  sleeps: number[];
  scripts: string[];
  activity: Array<{ kind: string; label: string; count?: number } | null>;
}

/** Walker over a FakeTab that replays `envelopes` in evaluate order. */
const harness = (envelopes: unknown[]): Harness => {
  const tab = new FakeTab();
  const sleeps: number[] = [];
  const scripts: string[] = [];
  let i = 0;
  tab.onEvaluate = (script) => {
    scripts.push(script);
    return envelopes[i++];
  };
  const activity: Array<{ kind: string; label: string; count?: number } | null> = [];
  const walker = new ListPageWalker({
    tab,
    reader,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    rng: () => 0.5,
    reporter: {
      report: (info) => activity.push(toVeilInfo(info)),
      clear: () => activity.push(null),
    },
  });
  return { walker, tab, sleeps, scripts, activity };
};

const baseArgs = {
  pk: 'ME',
  which: 'followers' as const,
  sentinel: new FakeSentinel() as unknown as Sentinel,
  onObservation: (): void => {},
};

test('walks offset cursor to cursor, then VERIFIES the end with a past-the-end probe', async () => {
  const { walker, sleeps, scripts } = harness([
    okEnv(followersBody(['11', '12'], '2', true)),
    okEnv(followersBody(['13', '14'], '4', true)),
    okEnv(followersBody(['15'], null, false)), // claims end, no cursor left
    okEnv(followersBody([], null, false)), // the probe: nothing past the end
  ]);
  const seen: string[] = [];
  const progress: number[] = [];

  const result = await walker.walkAll({
    ...baseArgs,
    onObservation: (obs) => seen.push(obs.accountPk),
    onProgress: (n) => progress.push(n),
    pageMinMs: 1_000,
    pageMaxMs: 3_000,
  });

  expect([...result.pks].sort()).toEqual(['11', '12', '13', '14', '15']);
  expect(result.pages).toBe(4); // 3 data pages + the verification probe
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  expect(result.endEvidence).toBe('probe');
  expect(result.quarantined).toBe(0);
  expect(result.reason).toBe('no-more-pages');
  expect(seen.length).toBe(5);
  expect(progress).toEqual([2, 4, 5]);
  // The deterministic midpoint pace ran between pages AND before the probe.
  expect(sleeps).toEqual([2_000, 2_000, 2_000]);
  // Page 1 has no cursor; later pages resume from the previous page's cursor;
  // the probe (no cursor handed back) synthesizes the row-offset "5".
  expect(scripts[0]).toContain('/followers/?count=');
  expect(scripts[0]).not.toContain('max_id');
  expect(scripts[1]).toContain('"2"');
  expect(scripts[2]).toContain('"4"');
  expect(scripts[3]).toContain('"5"');
});

describe('an OPAQUE cursor space is never probed with a synthesized offset', () => {
  const opaque = (last: unknown): unknown[] => [
    okEnv(followersBody(['11', '12'], 'QVFE1', true)),
    okEnv(followersBody(['13'], 'QVFE2', true)),
    okEnv(last),
  ];

  test("the server's own false flags end the walk: complete, no probe, endConfirmed false", async () => {
    const { walker, scripts } = harness(opaque(followersBody(['14'], null, false)));
    const result = await walker.walkAll(baseArgs);
    expect(result).toMatchObject({ complete: true, endConfirmed: false, endEvidence: 'server-flags', reason: 'no-more-pages' });
    expect(scripts).toHaveLength(3);
  });

  test('an end with no flags at all stops: no continuation evidence, rows kept', async () => {
    const { walker, scripts } = harness(opaque({ users: [{ pk: '14', username: 'ud' }] }));
    const result = await walker.walkAll(baseArgs);
    expect(result).toMatchObject({ complete: false, reason: 'shape-mismatch', stopDetail: 'no-continuation-evidence' });
    expect([...result.pks].sort()).toEqual(['11', '12', '13', '14']);
    expect(scripts).toHaveLength(3);
  });

  test('an end beside an unexplained cursor-like key stops on the veto', async () => {
    const { walker } = harness(opaque({ ...(followersBody(['14'], null, false) as object), next_cursor: 'QVFE3' }));
    const result = await walker.walkAll(baseArgs);
    expect(result).toMatchObject({ complete: false, reason: 'shape-mismatch', stopDetail: 'cursor-veto' });
  });

  test('a resumed opaque start cursor makes the walk opaque from its first page', async () => {
    const { walker, scripts } = harness([okEnv(followersBody(['11'], null, false))]);
    const result = await walker.walkAll({ ...baseArgs, startCursor: 'QVFE0' });
    expect(result).toMatchObject({ complete: true, endEvidence: 'server-flags' });
    expect(scripts).toHaveLength(1);
  });
});

test('a more-flag without a cursor is drift: the walk stops with its rows kept', async () => {
  const { walker } = harness([okEnv(followersBody(['11'], '1', true)), okEnv({ users: [{ pk: '12' }], has_more: true })]);
  const result = await walker.walkAll(baseArgs);
  expect(result).toMatchObject({ complete: false, reason: 'shape-mismatch', stopDetail: 'more-without-cursor' });
  expect([...result.pks].sort()).toEqual(['11', '12']);
});

test('unreadable rows are quarantined and counted; a mostly unreadable page stops the walk', async () => {
  const rows = [...Array.from({ length: 10 }, (_, i) => ({ pk: `${i + 1}` })), { id: 'x' }];
  const some = harness([okEnv({ users: rows, has_more: false }), okEnv(followersBody([], null, false))]);
  expect(await some.walker.walkAll(baseArgs)).toMatchObject({ complete: true, quarantined: 1 });
  const most = harness([okEnv({ users: [{ pk: '11' }, { id: 'x' }, { id: 'y' }], has_more: false })]);
  expect(await most.walker.walkAll(baseArgs)).toMatchObject({ complete: false, stopDetail: 'rows-unreadable', quarantined: 2 });
});

test('has_more:false with a leftover cursor is NOT an end — the walk follows the cursor', async () => {
  // The extractor infers more-pages from cursor presence, so a lying has_more
  // flag can never truncate the walk; the tail is fetched, then end-verified.
  const { walker, scripts } = harness([
    okEnv(followersBody(['11'], '9', false)), // has_more false but a cursor remains
    okEnv(followersBody(['12'], null, false)), // the tail the flag tried to hide
    okEnv(followersBody([], null, false)), // end probe
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['11', '12']);
  expect(result.endConfirmed).toBe(true);
  expect(scripts[1]).toContain('"9"');
});

test('a REJECTED past-the-end probe (JSON 400 past the limit) CONFIRMS the end — never a fallback', async () => {
  const { walker, sleeps } = harness([
    okEnv(followersBody(['11', '12'], '2', true)),
    okEnv(followersBody(['13'], null, false)), // end claim
    rejectEnv(400), // IG rejects the past-the-limit offset — that IS the end
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['11', '12', '13']);
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  expect(result.reason).toBe('no-more-pages');
  expect(result.endEvidence).toBe('probe-rejected');
  // The rejection was NOT retried (no retry wait was slept).
  expect(sleeps).not.toContain(RETRY_MS);
});

test('a 429 on the past-the-end probe is a FETCH FAILURE, never an end confirmation', async () => {
  // Getting throttled while verifying the end must not read as "the list is
  // complete" — that would fabricate a verified-complete census downstream.
  const { walker } = harness([
    okEnv(followersBody(['11', '12'], '2', true)),
    okEnv(followersBody(['13'], null, false)), // end claim
    failEnv(429), // throttled probe — retried once…
    failEnv(429), // …still throttled
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['11', '12', '13']);
  expect(result.complete).toBe(false);
  expect(result.endConfirmed).toBe(false);
  expect(result.reason).toBe('fetch-failed');
});

test('a transiently throttled probe recovers on retry and still verifies honestly', async () => {
  const { walker } = harness([
    okEnv(followersBody(['11'], null, false)), // end claim
    failEnv(429), // probe throttled once…
    okEnv(followersBody([], null, false)), // …the retried probe confirms
  ]);

  const result = await walker.walkAll(baseArgs);

  expect(result.pks).toEqual(['11']);
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  expect(result.reason).toBe('no-more-pages');
});

test('an HTML-wall 400 on the probe is a wall, not a past-the-limit rejection', async () => {
  // `classifyEnvelope` reads an HTML body on an API URL as a soft wall
  // (rate-limited) — only the JSON past-the-limit 400 confirms an end.
  const { walker } = harness([
    okEnv(followersBody(['11'], null, false)), // end claim
    failEnv(400), // 400 but text/html — a wall, retried…
    failEnv(400), // …persistently walled
  ]);

  const result = await walker.walkAll(baseArgs);

  expect(result.complete).toBe(false);
  expect(result.endConfirmed).toBe(false);
  expect(result.reason).toBe('fetch-failed');
});

test('a FALSE end claim is caught by the probe and the walk continues', async () => {
  const { walker, scripts } = harness([
    okEnv(followersBody(['11', '12'], null, false)), // premature end claim
    okEnv(followersBody(['13'], '3', true)), // the probe finds MORE — keep walking
    okEnv(followersBody([], null, false)), // next end claim…
    okEnv(followersBody([], null, false)), // …verified by its own probe
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['11', '12', '13']);
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  expect(scripts[1]).toContain('"2"'); // probe = rows fetched so far
  expect(scripts[2]).toContain('"3"'); // continued from the server's cursor
});

test('new rows past a claimed end with no server cursor stop the walk — never a second synthesized offset', async () => {
  const { walker, scripts } = harness([
    okEnv(followersBody(['11', '12'], null, false)), // end claim
    okEnv(followersBody(['13'], null, false)), // the probe finds MORE, but hands back no cursor
    okEnv(followersBody([], null, false)), // never requested
  ]);
  const result = await walker.walkAll(baseArgs);
  expect(result).toMatchObject({ complete: false, reason: 'shape-mismatch', stopDetail: 'end-claim-false' });
  expect([...result.pks].sort()).toEqual(['11', '12', '13']);
  expect(scripts).toHaveLength(2);
});

test('the FOLLOWING list pages the following endpoint', async () => {
  const { walker, scripts } = harness([
    okEnv(followersBody(['11'], null, false)),
    okEnv(followersBody([], null, false)),
  ]);

  const result = await walker.walkAll({ ...baseArgs, which: 'following' });

  expect(result.pks).toEqual(['11']);
  expect(scripts[0]).toContain('/following/?count=');
});

test('TWO consecutive failures on the first page end the walk as fetch-failed (fallback signal)', async () => {
  const { walker, sleeps } = harness([failEnv(429), failEnv(429)]);

  const result = await walker.walkAll(baseArgs);

  expect(result).toEqual({
    pks: [],
    pages: 0,
    complete: false,
    endConfirmed: false,
    reason: 'fetch-failed',
    cursor: null,
    quarantined: 0,
  });
  // The retry waited one `pause.retry` draw before the second attempt.
  expect(sleeps).toEqual([RETRY_MS]);
});

test('ONE transient failure is retried on the same cursor and the walk recovers', async () => {
  const { walker, scripts } = harness([
    okEnv(followersBody(['11'], '1', true)),
    failEnv(429), // transient blip fetching page 2…
    okEnv(followersBody(['12'], null, false)), // …the retry lands it
    okEnv(followersBody([], null, false)), // end probe
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['11', '12']);
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  // The retry re-requested the SAME cursor.
  expect(scripts[1]).toContain('"1"');
  expect(scripts[2]).toContain('"1"');
});

test('a mid-walk double failure keeps the pages already parsed but is NOT complete', async () => {
  const { walker } = harness([
    okEnv(followersBody(['11', '12'], 'C1', true)),
    failEnv(429),
    failEnv(429),
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['11', '12']);
  expect(result.pages).toBe(1);
  expect(result.complete).toBe(false);
  expect(result.reason).toBe('fetch-failed');
});

test('a SHAPE_MISMATCH page ends the walk shape-mismatch, incomplete — never a typed-empty end', async () => {
  const { walker } = harness([
    okEnv(followersBody(['11', '12'], 'C1', true)),
    okEnv({ unexpected_new_shape: true }), // IG shipped a list-shape change
  ]);

  const result = await walker.walkAll(baseArgs);

  // The rows already parsed are kept; the drifted page adds NOTHING and the
  // walk ends as the failure it is — a drifted extractor must never turn into
  // a verified-complete empty walk (the fabricated-census laundering).
  expect([...result.pks].sort()).toEqual(['11', '12']);
  expect(result.complete).toBe(false);
  expect(result.endConfirmed).toBe(false);
  expect(result.reason).toBe('shape-mismatch');
  // The resume point stays at the last well-formed page, so a fixed adapter
  // picks up exactly where the drift stopped this walk.
  expect(result.cursor).toBe('C1');
});

test('a drifted FIRST page ends the walk immediately — no fabricated empty census', async () => {
  const { walker } = harness([okEnv({ unexpected_new_shape: true })]);

  const result = await walker.walkAll(baseArgs);

  expect(result.pks).toEqual([]);
  expect(result.complete).toBe(false);
  expect(result.endConfirmed).toBe(false);
  expect(result.reason).toBe('shape-mismatch');
});

test('a drifted past-the-end PROBE page never confirms the end claim', async () => {
  const { walker } = harness([
    okEnv(followersBody(['11'], null, false)), // end claim…
    okEnv({ unexpected_new_shape: true }), // …but the probe no longer parses
  ]);

  const result = await walker.walkAll(baseArgs);

  expect(result.pks).toEqual(['11']);
  expect(result.complete).toBe(false);
  expect(result.endConfirmed).toBe(false);
  expect(result.reason).toBe('shape-mismatch');
});

test('a drifted FOLLOWING page fails the same way (shared strict parse)', async () => {
  const { walker } = harness([okEnv({ unexpected_new_shape: true })]);

  const result = await walker.walkAll({ ...baseArgs, which: 'following' });

  expect(result.complete).toBe(false);
  expect(result.reason).toBe('shape-mismatch');
});

test('persistent evaluate throws are fetch-failed, never an unhandled rejection', async () => {
  const { walker, tab } = harness([]);
  tab.onEvaluate = () => {
    throw new Error('render frame disposed');
  };

  const result = await walker.walkAll(baseArgs);
  expect(result.reason).toBe('fetch-failed');
  expect(result.pks).toEqual([]);
});

test('cooperative stop ends the walk before the next page fetch', async () => {
  const { walker, scripts } = harness([
    okEnv(followersBody(['11'], 'C1', true)),
    okEnv(followersBody(['12'], 'C2', true)),
  ]);
  let fetched = 0;
  const result = await walker.walkAll({
    ...baseArgs,
    onObservation: () => {
      fetched += 1;
    },
    shouldStop: () => fetched >= 1,
  });

  expect(result.pks).toEqual(['11']);
  expect(result.reason).toBe('stop-requested');
  expect(scripts.length).toBe(1); // page 2 was never requested
});

test('a non-ok sentinel at the top of a page halts the walk', async () => {
  const tabEnvs = [okEnv(followersBody(['11'], 'C1', true))];
  const { walker } = harness(tabEnvs);
  const result = await walker.walkAll({
    ...baseArgs,
    sentinel: new FakeSentinel(['ok', 'challenge']) as unknown as Sentinel,
  });

  expect(result.pks).toEqual(['11']);
  expect(result.reason).toBe('sentinel:challenge');
});


test('the drawn rest stride triggers a LONG jittered rest on top of the pace', async () => {
  // The stride is DRAWN (timing-noise layer), not fixed: the harness rng is
  // pinned at 0.5, so this is exactly the stride the walker draws at start.
  const n = nextRestStride(() => 0.5);
  const envs = [
    ...Array.from({ length: n + 1 }, (_, i) =>
      okEnv(followersBody([`${100 + i}`], i === n ? null : String(i + 1), i !== n)),
    ),
    okEnv(followersBody([], null, false)), // the end probe
  ];
  const { walker, sleeps } = harness(envs);

  const result = await walker.walkAll({ ...baseArgs, pageMinMs: 100, pageMaxMs: 200 });

  expect(result.pages).toBe(n + 2); // n+1 data pages + the verification probe
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  // Pages 1..n each pace at the midpoint (150); after page n the long rest
  // fires at ITS midpoint; page n+1 claims the end and paces once more before
  // the probe; the probe confirms and ends the walk with no further sleep.
  const restMid = (RIM.LIST_WALK_REST_MIN_MS + RIM.LIST_WALK_REST_MAX_MS) / 2;
  expect(sleeps).toEqual([...Array.from({ length: n }, () => 150), restMid, 150].flat());
});

test('stagnation tolerates duplicate-window pages, then stops after the cap (never loops)', async () => {
  const dup = (): unknown => okEnv(followersBody(['11'], 'C1', true));
  const { walker } = harness([
    okEnv(followersBody(['11'], 'C1', true)),
    ...Array.from({ length: RIM.LIST_WALK_STAGNANT_STOP }, dup),
  ]);

  const result = await walker.walkAll(baseArgs);

  expect(result.pks).toEqual(['11']);
  expect(result.reason).toBe('stagnant');
  expect(result.complete).toBe(false);
  expect(result.pages).toBe(1 + RIM.LIST_WALK_STAGNANT_STOP);
});

test('a duplicate page mid-walk does NOT abort — fresh pages reset the counter', async () => {
  const { walker } = harness([
    okEnv(followersBody(['11'], 'C1', true)),
    okEnv(followersBody(['11'], 'C2', true)), // overlapping window: nothing new
    okEnv(followersBody(['12'], null, false)), // fresh data resumes
    okEnv(followersBody([], null, false)), // end probe
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['11', '12']);
  expect(result.complete).toBe(true);
  expect(result.reason).toBe('no-more-pages');
});

test('reports live API activity for the veil, with counts, then clears', async () => {
  const { walker, activity } = harness([
    okEnv(followersBody(['11', '12'], 'C1', true)),
    okEnv(followersBody(['13'], null, false)),
    okEnv(followersBody([], null, false)), // end probe
  ]);

  await walker.walkAll(baseArgs);

  // The direct walk is API traffic, never page driving.
  expect(activity.filter(Boolean).every((a) => a!.kind === 'api')).toBe(true);
  expect(activity[0]).toEqual({ kind: 'api', label: 'Reading follower list', count: 0 });
  // Counts climb as pages land (2 then 3), and the phase clears at the end.
  expect(activity.filter(Boolean).map((a) => a!.count)).toEqual([0, 2, 3]);
  expect(activity[activity.length - 1]).toBeNull();
});

test('a FOLLOWING walk labels its activity accordingly', async () => {
  const { walker, activity } = harness([
    okEnv(followersBody(['11'], null, false)),
    okEnv(followersBody([], null, false)),
  ]);

  await walker.walkAll({ ...baseArgs, which: 'following' });

  expect(activity[0]).toMatchObject({ kind: 'api', label: 'Reading following list' });
});

test('a demand-bounded walk reports its total, so the overlay bar is determinate', async () => {
  const { walker, activity } = harness([
    okEnv(followersBody(['11', '12'], 'C1', true)),
    okEnv(followersBody(['13', '14'], 'C2', true)),
  ]);

  await walker.walkAll({ ...baseArgs, maxNewPks: 4 });

  const reports = activity.filter(Boolean) as Array<{ count?: number; total?: number }>;
  // Every report carries the real denominator the run is walking toward.
  expect(reports.every((r) => r.total === 4)).toBe(true);
  expect(reports.map((r) => r.count)).toEqual([0, 2, 4]);
});

test('an UNBOUNDED census reports no total (honest indeterminate progress)', async () => {
  const { walker, activity } = harness([
    okEnv(followersBody(['11'], null, false)),
    okEnv(followersBody([], null, false)),
  ]);

  await walker.walkAll(baseArgs); // no maxNewPks

  const reports = activity.filter(Boolean) as Array<{ total?: number }>;
  expect(reports.every((r) => r.total === undefined)).toBe(true);
});

test('the FOLLOWING walk asks for the deterministic order; its end probe asks in the plain form', async () => {
  // Live 2026-09-20: the default following order is re-ranked per request (each
  // page carries a fresh `follow_ranking_token`), so offset paging repeated 405
  // of 3,447 rows and never returned 404 accounts. `order=date_followed_earliest`
  // answers the WHOLE list at once, ignoring `max_id` — so the past-the-end
  // probe must NOT carry it, or it re-downloads the entire list to learn nothing.
  const h = harness([
    okEnv(followersBody(['11', '12', '13'], null, false)),
    okEnv(followersBody([], null, false)),
  ]);
  const result = await h.walker.walkAll({
    pk: '42',
    which: 'following',
    onObservation: () => {},
    sentinel: new FakeSentinel() as unknown as Sentinel,
  });
  expect(result).toMatchObject({ complete: true, endConfirmed: true, pks: ['11', '12', '13'] });
  expect(h.scripts[0]).toContain('order=date_followed_earliest');
  expect(h.scripts[1]).not.toContain('order=');
  expect(h.scripts[1]).toContain('max_id');
});

test('the FOLLOWERS walk carries no order parameter', async () => {
  const h = harness([okEnv(followersBody(['11'], null, false)), okEnv(followersBody([], null, false))]);
  await h.walker.walkAll({
    pk: '42',
    which: 'followers',
    onObservation: () => {},
    sentinel: new FakeSentinel() as unknown as Sentinel,
  });
  expect(h.scripts.join('\n')).not.toContain('order=');
});
