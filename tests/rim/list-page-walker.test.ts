/**
 * ListPageWalker: the prune scan's DIRECT paginated walk of a friendships list
 * — full-size API pages cursor to cursor, jittered per-page pacing, a long rest
 * every few pages, and honest end reasons. An end-of-list claim is VERIFIED by
 * probing one page past it (nothing new = `endConfirmed`; new rows = the claim
 * was false and the walk continues); a transient fetch failure is retried once;
 * `fetch-failed` (two consecutive failures) lets callers fall back to the
 * dialog-scroll scrape.
 */
import { ListPageWalker } from '@/rim/list-page-walker';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { FakeClock } from '@/governors/clock';
import { RIM } from '@/timing/config';
import { FakeTab, FakeSentinel, followersBody } from './fakes';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const reader = new Reader();
const clock = new FakeClock(3_000_000);

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
      report: (info) => activity.push(info),
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

test('walks cursor to cursor, then VERIFIES the end with a past-the-end probe', async () => {
  const { walker, sleeps, scripts } = harness([
    okEnv(followersBody(['a', 'b'], 'C1', true)),
    okEnv(followersBody(['c', 'd'], 'C2', true)),
    okEnv(followersBody(['e'], null, false)), // claims end, no cursor left
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

  expect([...result.pks].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(result.pages).toBe(4); // 3 data pages + the verification probe
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  expect(result.reason).toBe('no-more-pages');
  expect(seen.length).toBe(5);
  expect(progress).toEqual([2, 4, 5]);
  // The deterministic midpoint pace ran between pages AND before the probe.
  expect(sleeps).toEqual([2_000, 2_000, 2_000]);
  // Page 1 has no cursor; later pages resume from the previous page's cursor;
  // the probe (no cursor handed back) synthesizes the row-offset "5".
  expect(scripts[0]).toContain('/followers/?count=');
  expect(scripts[0]).not.toContain('max_id');
  expect(scripts[1]).toContain('"C1"');
  expect(scripts[2]).toContain('"C2"');
  expect(scripts[3]).toContain('"5"');
});

test('has_more:false with a leftover cursor is NOT an end — the walk follows the cursor', async () => {
  // The extractor infers more-pages from cursor presence, so a lying has_more
  // flag can never truncate the walk; the tail is fetched, then end-verified.
  const { walker, scripts } = harness([
    okEnv(followersBody(['a'], 'C9', false)), // has_more false but a cursor remains
    okEnv(followersBody(['b'], null, false)), // the tail the flag tried to hide
    okEnv(followersBody([], null, false)), // end probe
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['a', 'b']);
  expect(result.endConfirmed).toBe(true);
  expect(scripts[1]).toContain('"C9"');
});

test('a REJECTED past-the-end probe (400 past the limit) CONFIRMS the end — never a fallback', async () => {
  const { walker, sleeps } = harness([
    okEnv(followersBody(['a', 'b'], 'C1', true)),
    okEnv(followersBody(['c'], null, false)), // end claim
    failEnv(400), // IG rejects the past-the-limit offset — that IS the end
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['a', 'b', 'c']);
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  expect(result.reason).toBe('no-more-pages');
  // The rejection was NOT retried (no long-rest backoff draw was slept).
  expect(sleeps.every((ms) => ms !== 10_000)).toBe(true);
});

test('a FALSE end claim is caught by the probe and the walk continues', async () => {
  const { walker, scripts } = harness([
    okEnv(followersBody(['a', 'b'], null, false)), // premature end claim
    okEnv(followersBody(['c'], 'C3', true)), // the probe finds MORE — keep walking
    okEnv(followersBody([], null, false)), // next end claim…
    okEnv(followersBody([], null, false)), // …verified by its own probe
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['a', 'b', 'c']);
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  expect(scripts[1]).toContain('"2"'); // probe = rows fetched so far
  expect(scripts[2]).toContain('"C3"'); // continued from the recovered cursor
});

test('the FOLLOWING list pages the following endpoint', async () => {
  const { walker, scripts } = harness([
    okEnv(followersBody(['a'], null, false)),
    okEnv(followersBody([], null, false)),
  ]);

  const result = await walker.walkAll({ ...baseArgs, which: 'following' });

  expect(result.pks).toEqual(['a']);
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
  });
  // The retry backed off on a long-rest draw before the second attempt.
  expect(sleeps).toEqual([10_000]);
});

test('ONE transient failure is retried on the same cursor and the walk recovers', async () => {
  const { walker, scripts } = harness([
    okEnv(followersBody(['a'], 'C1', true)),
    failEnv(429), // transient blip fetching C1's page…
    okEnv(followersBody(['b'], null, false)), // …the retry lands it
    okEnv(followersBody([], null, false)), // end probe
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['a', 'b']);
  expect(result.complete).toBe(true);
  expect(result.endConfirmed).toBe(true);
  // The retry re-requested the SAME cursor.
  expect(scripts[1]).toContain('"C1"');
  expect(scripts[2]).toContain('"C1"');
});

test('a mid-walk double failure keeps the pages already parsed but is NOT complete', async () => {
  const { walker } = harness([
    okEnv(followersBody(['a', 'b'], 'C1', true)),
    failEnv(429),
    failEnv(429),
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['a', 'b']);
  expect(result.pages).toBe(1);
  expect(result.complete).toBe(false);
  expect(result.reason).toBe('fetch-failed');
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
    okEnv(followersBody(['a'], 'C1', true)),
    okEnv(followersBody(['b'], 'C2', true)),
  ]);
  let fetched = 0;
  const result = await walker.walkAll({
    ...baseArgs,
    onObservation: () => {
      fetched += 1;
    },
    shouldStop: () => fetched >= 1,
  });

  expect(result.pks).toEqual(['a']);
  expect(result.reason).toBe('stop-requested');
  expect(scripts.length).toBe(1); // page 2 was never requested
});

test('a non-ok sentinel at the top of a page halts the walk', async () => {
  const tabEnvs = [okEnv(followersBody(['a'], 'C1', true))];
  const { walker } = harness(tabEnvs);
  const result = await walker.walkAll({
    ...baseArgs,
    sentinel: new FakeSentinel(['ok', 'challenge']) as unknown as Sentinel,
  });

  expect(result.pks).toEqual(['a']);
  expect(result.reason).toBe('sentinel:challenge');
});


test('every Nth page draws a LONG jittered rest on top of the pace', async () => {
  const n = RIM.LIST_WALK_REST_EVERY;
  const envs = [
    ...Array.from({ length: n + 1 }, (_, i) =>
      okEnv(followersBody([`p${i}`], i === n ? null : `C${i}`, i !== n)),
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
  const dup = (): unknown => okEnv(followersBody(['a'], 'C1', true));
  const { walker } = harness([
    okEnv(followersBody(['a'], 'C1', true)),
    ...Array.from({ length: RIM.LIST_WALK_STAGNANT_STOP }, dup),
  ]);

  const result = await walker.walkAll(baseArgs);

  expect(result.pks).toEqual(['a']);
  expect(result.reason).toBe('stagnant');
  expect(result.complete).toBe(false);
  expect(result.pages).toBe(1 + RIM.LIST_WALK_STAGNANT_STOP);
});

test('a duplicate page mid-walk does NOT abort — fresh pages reset the counter', async () => {
  const { walker } = harness([
    okEnv(followersBody(['a'], 'C1', true)),
    okEnv(followersBody(['a'], 'C2', true)), // overlapping window: nothing new
    okEnv(followersBody(['b'], null, false)), // fresh data resumes
    okEnv(followersBody([], null, false)), // end probe
  ]);

  const result = await walker.walkAll(baseArgs);

  expect([...result.pks].sort()).toEqual(['a', 'b']);
  expect(result.complete).toBe(true);
  expect(result.reason).toBe('no-more-pages');
});

test('reports live API activity for the veil, with counts, then clears', async () => {
  const { walker, activity } = harness([
    okEnv(followersBody(['a', 'b'], 'C1', true)),
    okEnv(followersBody(['c'], null, false)),
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
    okEnv(followersBody(['a'], null, false)),
    okEnv(followersBody([], null, false)),
  ]);

  await walker.walkAll({ ...baseArgs, which: 'following' });

  expect(activity[0]).toMatchObject({ kind: 'api', label: 'Reading following list' });
});

test('a demand-bounded walk reports its total, so the overlay bar is determinate', async () => {
  const { walker, activity } = harness([
    okEnv(followersBody(['a', 'b'], 'C1', true)),
    okEnv(followersBody(['c', 'd'], 'C2', true)),
  ]);

  await walker.walkAll({ ...baseArgs, maxNewPks: 4 });

  const reports = activity.filter(Boolean) as Array<{ count?: number; total?: number }>;
  // Every report carries the real denominator the run is walking toward.
  expect(reports.every((r) => r.total === 4)).toBe(true);
  expect(reports.map((r) => r.count)).toEqual([0, 2, 4]);
});

test('an UNBOUNDED census reports no total (honest indeterminate progress)', async () => {
  const { walker, activity } = harness([
    okEnv(followersBody(['a'], null, false)),
    okEnv(followersBody([], null, false)),
  ]);

  await walker.walkAll(baseArgs); // no maxNewPks

  const reports = activity.filter(Boolean) as Array<{ total?: number }>;
  expect(reports.every((r) => r.total === undefined)).toBe(true);
});
