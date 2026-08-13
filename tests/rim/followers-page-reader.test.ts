import { FollowersPageReader } from '@/rim/followers-page-reader';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { RequestBudget } from '@/governors/request-budget';
import { FakeClock } from '@/governors/clock';
import type { Observation } from '@/store/types';
import type { TabResponse } from '@/types';
import {
  FakeTab,
  FakeBudget,
  FakeSentinel,
  FakeActor,
  followersUrl,
  followersBody,
  mkResp,
} from './fakes';

const reader = new Reader();
const clock = new FakeClock(1_000_000);

const makeReader = (tab: FakeTab, actor: FakeActor): FollowersPageReader =>
  new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });

test('collects observed pks, the URL-derived target pk, and the final cursor', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();

  // Scripted followers pages: one on open, then one per scroll.
  const pages: TabResponse[] = [
    mkResp(followersUrl('999'), followersBody(['a', 'b'], 'C1', true)), // on open
    mkResp(followersUrl('999', 'C1'), followersBody(['c', 'd'], 'C2', true)), // scroll 1
    mkResp(followersUrl('999', 'C2'), followersBody([], 'C2', true)), // scroll 2: no new
    mkResp(followersUrl('999', 'C2'), followersBody([], 'C2', true)), // scroll 3: no new → stop
  ];
  let i = 0;
  actor.onOpen = () => tab.emit(pages[i++]);
  actor.onScroll = () => {
    if (i < pages.length) tab.emit(pages[i++]);
  };

  const seen: Observation[] = [];
  const result = await makeReader(tab, actor).collect({
    targetUsername: 'target',
    onObservation: (obs) => seen.push(obs),
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    maxRounds: 5,
    noNewStop: 2,
  });

  expect([...result.observedPks].sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(result.targetPk).toBe('999'); // R1: derived from the followers URL
  expect(result.cursor).toBe('C2'); // R4: the last page's next_max_id
  expect(seen.map((o) => o.accountPk).sort()).toEqual(['a', 'b', 'c', 'd']);
});

test('R3: a non-ok sentinel at the top of round 2 stops the scroll loop', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();

  // Every page has fresh pks so nothing else would stop the loop.
  let n = 0;
  actor.onOpen = () => tab.emit(mkResp(followersUrl('999'), followersBody(['a'], 'C', true)));
  actor.onScroll = () => {
    n += 1;
    tab.emit(mkResp(followersUrl('999', `C${n}`), followersBody([`s${n}`], `C${n}`, true)));
  };

  // ok, ok, then action-blocked at the 3rd check (round index 2).
  const sentinel = new FakeSentinel(['ok', 'ok', 'action-blocked']);
  const result = await makeReader(tab, actor).collect({
    targetUsername: 'target',
    onObservation: () => {},
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: sentinel as unknown as Sentinel,
    maxRounds: 10,
    noNewStop: 5,
  });

  // Rounds 0 and 1 scrolled; round 2's sentinel check broke before scrolling.
  expect(actor.scrollCalls).toBe(2);
  expect(sentinel.checks).toBe(3);
  expect(result.targetPk).toBe('999');
});

test('R2: an exhausted budget stops the scroll loop before scrolling', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  actor.onOpen = () => tab.emit(mkResp(followersUrl('999'), followersBody(['a', 'b'], 'C1', true)));

  const result = await makeReader(tab, actor).collect({
    targetUsername: 'target',
    onObservation: () => {},
    budget: new FakeBudget(false) as unknown as RequestBudget, // canSpend() === false
    sentinel: new FakeSentinel() as unknown as Sentinel,
    maxRounds: 10,
    noNewStop: 2,
  });

  expect(actor.scrollCalls).toBe(0); // budget gate closed before the first scroll
  // The page captured on open is still observed and its pk resolved.
  expect([...result.observedPks].sort()).toEqual(['a', 'b']);
  expect(result.targetPk).toBe('999');
});

// --- Scan pacing + cooperative stop (Phase 5 prune scan) ---------------------------

/** A reader with an injected sleep recorder + deterministic rng (no real timers). */
const makePacedReader = (
  tab: FakeTab,
  actor: FakeActor,
  opts: { sleeps: number[]; rng: () => number; scrollWaitMs?: number },
): FollowersPageReader =>
  new FollowersPageReader({
    tab,
    reader,
    actor,
    clock,
    scrollWaitMs: opts.scrollWaitMs ?? 1,
    sleep: async (ms) => {
      opts.sleeps.push(ms);
    },
    rng: opts.rng,
  });

/** Script fresh-pk pages so only pacing/stop args can end the loop early. */
const scriptEndlessPages = (tab: FakeTab, actor: FakeActor): void => {
  let n = 0;
  actor.onOpen = () => tab.emit(mkResp(followersUrl('999'), followersBody(['a'], 'C', true)));
  actor.onScroll = () => {
    n += 1;
    tab.emit(mkResp(followersUrl('999', `C${n}`), followersBody([`s${n}`], `C${n}`, true)));
  };
};

test('scrollMinMs/scrollMaxMs: every wait is a fresh jittered draw within [min,max]', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  scriptEndlessPages(tab, actor);

  // A cycling rng proves each wait is re-drawn, not computed once and reused.
  const draws = [0, 1, 0.25, 0.5];
  let i = 0;
  const sleeps: number[] = [];
  await makePacedReader(tab, actor, { sleeps, rng: () => draws[i++ % draws.length] }).collect({
    targetUsername: 'target',
    onObservation: () => {},
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    maxRounds: 3,
    noNewStop: 5,
    scrollMinMs: 1_000,
    scrollMaxMs: 3_000,
  });

  // Initial post-open wait + one wait per scroll round, each min + draw·span.
  expect(sleeps).toEqual([1_000, 3_000, 1_500, 2_000]);
  for (const ms of sleeps) {
    expect(ms).toBeGreaterThanOrEqual(1_000);
    expect(ms).toBeLessThanOrEqual(3_000);
  }
});

test('an inverted min/max pair is clamped so the wait never falls below the min', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  scriptEndlessPages(tab, actor);

  const sleeps: number[] = [];
  await makePacedReader(tab, actor, { sleeps, rng: () => 1 }).collect({
    targetUsername: 'target',
    onObservation: () => {},
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    maxRounds: 1,
    noNewStop: 5,
    scrollMinMs: 4_000,
    scrollMaxMs: 2_000, // below min → clamped up to min
  });

  expect(sleeps).toEqual([4_000, 4_000]);
});

test('shouldStop flipping true breaks the scroll loop early (fewer rounds than maxRounds)', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  let stop = false;
  let n = 0;
  actor.onOpen = () => tab.emit(mkResp(followersUrl('999'), followersBody(['a'], 'C', true)));
  actor.onScroll = () => {
    n += 1;
    tab.emit(mkResp(followersUrl('999', `C${n}`), followersBody([`s${n}`], `C${n}`, true)));
    if (n === 2) stop = true; // request the stop after the second scroll lands
  };

  const result = await makeReader(tab, actor).collect({
    targetUsername: 'target',
    onObservation: () => {},
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    maxRounds: 10,
    noNewStop: 5,
    shouldStop: () => stop,
  });

  // Rounds 0 and 1 scrolled; round 2's top-of-round check broke the loop.
  expect(actor.scrollCalls).toBe(2);
  // Everything captured up to the stop is still drained and returned.
  expect([...result.observedPks].sort()).toEqual(['a', 's1', 's2']);
});

test('shouldStop true from the start skips the initial post-open wait and all scrolling', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  actor.onOpen = () => tab.emit(mkResp(followersUrl('999'), followersBody(['a', 'b'], null, false)));

  const sleeps: number[] = [];
  const result = await makePacedReader(tab, actor, { sleeps, rng: () => 0.5 }).collect({
    targetUsername: 'target',
    onObservation: () => {},
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    maxRounds: 10,
    noNewStop: 5,
    shouldStop: () => true,
  });

  expect(sleeps).toEqual([]); // not even the post-open wait ran
  expect(actor.scrollCalls).toBe(0);
  // The page captured on open is still drained and returned (nothing lost).
  expect([...result.observedPks].sort()).toEqual(['a', 'b']);
});

test('default path (no min/max/shouldStop) keeps the fixed scrollWaitMs pacing', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  scriptEndlessPages(tab, actor);

  const sleeps: number[] = [];
  await makePacedReader(tab, actor, {
    sleeps,
    rng: () => {
      throw new Error('rng must not be consulted on the fixed-pacing path');
    },
    scrollWaitMs: 7,
  }).collect({
    targetUsername: 'target',
    onObservation: () => {},
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    maxRounds: 2,
    noNewStop: 5,
  });

  expect(sleeps).toEqual([7, 7, 7]); // post-open + one per round, all fixed
});

test('R5: drain awaits a response that lands during teardown', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();

  // A late second response, delivered to the (already-unsubscribed) handler while
  // the first response's body is still resolving during the drain.
  const late = mkResp(followersUrl('999', 'C1'), followersBody(['late'], 'C2', false));

  const first: TabResponse = {
    requestId: 'first',
    url: followersUrl('999'),
    status: 200,
    mimeType: 'application/json',
    getBody: () =>
      new Promise<string>((resolve) => {
        setTimeout(() => {
          // Lands during teardown → pushes a new in-flight parse the drain must catch.
          tab.emitRaw(late);
          resolve(JSON.stringify(followersBody(['early'], 'C1', true)));
        }, 5);
      }),
  };
  actor.onOpen = () => tab.emit(first);

  const result = await makeReader(tab, actor).collect({
    targetUsername: 'target',
    onObservation: () => {},
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    maxRounds: 0, // skip scrolling; exercise open + drain only
    noNewStop: 1,
  });

  // Both the early body and the late-landing body were fully drained before return.
  expect([...result.observedPks].sort()).toEqual(['early', 'late']);
});
