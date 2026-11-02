import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { FakeClock } from '@/governors/clock';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { ListPageWalker } from '@/rim/list-page-walker';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import { FakeActor, FakeSentinel, FakeTab, followersBody, followersUrl, mkResp } from '../kit/fakes';

const sentinel = () => new FakeSentinel() as unknown as Sentinel;

test('a malformed list page or failed profile visit cannot count as useful runtime progress', async () => {
  const tab = new FakeTab();
  tab.onEvaluate = () => ({ ok: true, status: 200, contentType: 'application/json', json: { unexpected: true } });
  const onProgress = jest.fn();
  const walker = new ListPageWalker({ tab, reader: new Reader(), onProgress, sleep: async () => {} });
  expect((await walker.walkAll({ pk: 'a', which: 'followers', sentinel: sentinel(), onObservation: () => {} })).reason)
    .toBe('shape-mismatch');
  const enricher = new AdapterBackedProfileEnricher({ onProgress, sentinel: sentinel(), paceMs: 0,
    store: { markEnrichmentFailed: () => {} }, visitor: { visit: async () => ({ ok: false, kind: 'walled', detail: {} }) },
  });
  await enricher.enrich(['a']);
  expect(onProgress).not.toHaveBeenCalled();
});

test('a validated list page signals progress only after its observations have been delivered', async () => {
  const tab = new FakeTab();
  tab.onEvaluate = () => ({ ok: true, status: 200, contentType: 'application/json', json: followersBody(['one'], 'C1', true) });
  const seen: string[] = [];
  const onProgress = jest.fn(() => expect(seen).toEqual(['one']));
  const walker = new ListPageWalker({ tab, reader: new Reader(), onProgress, sleep: async () => {} });
  await walker.walkAll({ pk: 'a', which: 'followers', sentinel: sentinel(), maxPages: 1, onObservation: (obs) => seen.push(obs.accountPk) });
  expect(onProgress).toHaveBeenCalledTimes(1);
});

test('passive parsed pages cannot keep a wedged dialog scroll driver healthy', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  let release!: () => void;
  const stalled = new Promise<boolean>((resolve) => { release = () => resolve(true); });
  let entered!: () => void;
  const inScroll = new Promise<void>((resolve) => { entered = resolve; });
  actor.scrollFollowers = async () => { entered(); return stalled; };
  const onProgress = jest.fn();
  const reader = new FollowersPageReader({ tab, actor, reader: new Reader(), clock: new FakeClock(1000),
    onProgress, sleep: async () => {} });
  const seen: string[] = [];
  const collecting = reader.collect({ targetUsername: 'a', sentinel: sentinel(), maxRounds: 1, noNewStop: 1,
    onObservation: (obs) => seen.push(obs.accountPk) });
  await inScroll;
  tab.emit(mkResp(followersUrl('999'), followersBody(['one'], 'C1', true)));
  await Promise.resolve();
  await Promise.resolve();
  expect(seen).toEqual(['one']);
  expect(onProgress).not.toHaveBeenCalled();
  release();
  await collecting;
  expect(onProgress).toHaveBeenCalledWith('dialog-page-ingested');
});
