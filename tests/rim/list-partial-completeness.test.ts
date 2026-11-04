import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { ListPageWalker } from '@/rim/list-page-walker';
import { FakeSentinel, FakeTab, followersBody } from '../kit/fakes';

test('a GraphQL partial list keeps its rows but cannot certify absence through a later empty probe', async () => {
  const tab = new FakeTab();
  const first = { ...followersBody(['11'], null, false) as Record<string, unknown>, errors: [{ message: 'partial data' }] };
  const pages = [first, followersBody([], null, false)];
  let calls = 0;
  tab.onEvaluate = () => ({ ok: true, status: 200, contentType: 'application/json', json: pages[calls++] });
  const walker = new ListPageWalker({ tab, reader: new Reader(), sleep: async () => {} });
  const seen: string[] = [];
  const result = await walker.walkAll({ pk: '999', which: 'followers', maxPages: 2,
    sentinel: new FakeSentinel() as unknown as Sentinel, onObservation: (obs) => seen.push(obs.accountPk) });
  expect(seen).toEqual(['11']);
  expect(result).toMatchObject({ complete: false, reason: 'shape-mismatch', stopDetail: 'incomplete-stream' });
  expect(calls).toBe(1);
});
