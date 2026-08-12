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
