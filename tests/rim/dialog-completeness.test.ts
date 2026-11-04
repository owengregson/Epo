import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { walkOwnList } from '@/rim/walk-own-list';
import type { TabResponse } from '@/types';
import { FakeActor, FakeSentinel, FakeTab, followersBody, followersUrl, mkResp } from '../kit/fakes';

const pks = Array.from({ length: 10 }, (_, i) => String(i + 11));
const good = followersBody(pks, null, false) as Record<string, unknown>;

async function census(first: TabResponse, last?: TabResponse, maxRounds = 1) {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const facts: string[] = [];
  actor.onOpen = () => tab.emit(first);
  actor.onScroll = () => { if (last !== undefined) tab.emit(last); };
  const pageReader = new FollowersPageReader({ tab, actor, reader: new Reader(), scrollWaitMs: 0,
    sleep: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); } });
  const result = await walkOwnList({ which: 'followers', label: 'test', ownUsername: 'own', pageReader,
    sentinel: new FakeSentinel() as unknown as Sentinel, bounds: { maxRounds, noNewStop: 2 },
    onRow: (obs) => facts.push(obs.accountPk) });
  return { result, facts };
}

test.each([
  ['partial stream', { ...good, extensions: { is_final: false } }],
  ['quarantined row', { ...good, users: [...good.users as unknown[], { broken: true }] }],
  ['more without cursor', { ...good, has_more: true }],
  ['novel cursor veto', { ...good, future_cursor: 'opaque' }],
  ['missing end flags', { users: good.users }],
])('dialog census preserves facts but never calls %s complete', async (_label, body) => {
  const { result, facts } = await census(mkResp(followersUrl('999'), body));
  expect(facts).toEqual(pks);
  expect(result).toMatchObject({ complete: false, reason: 'shape-mismatch' });
});

test('a failed body read before a final page poisons dialog completeness', async () => {
  const first = { ...mkResp(followersUrl('999'), good), getBody: async () => { throw new Error('body gone'); } };
  const { result } = await census(first, mkResp(followersUrl('999'), good));
  expect(result).toMatchObject({ complete: false, reason: 'shape-mismatch' });
});

test('a wall arriving in the final scroll cannot leave a previous final page complete', async () => {
  const { result, facts } = await census(mkResp(followersUrl('999'), good),
    { ...mkResp(followersUrl('999'), {}), status: 429 });
  expect(facts).toEqual(pks);
  expect(result).toMatchObject({ complete: false, reason: 'blocked-response' });
});

test('a canonical complete final page still proves the dialog census complete', async () => {
  const { result, facts } = await census(mkResp(followersUrl('999'), good));
  expect(facts).toEqual(pks);
  expect(result).toMatchObject({ complete: true, reason: 'no-more-pages' });
});


test('a complete first page needs no scroll allowance to prove completion', async () => {
  expect((await census(mkResp(followersUrl('999'), good), undefined, 0)).result)
    .toMatchObject({ complete: true, reason: 'no-more-pages' });
});
