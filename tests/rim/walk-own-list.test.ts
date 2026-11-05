import type { Sentinel } from '@/adapter/sentinel';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import type { ListPageWalker } from '@/rim/list-page-walker';
import type { WalkArgs, WalkResult } from '@/rim/list-walk-types';
import { walkOwnList } from '@/rim/walk-own-list';
import { setLevel } from '@/utils/logger';
import { FakeSentinel } from '../kit/fakes';

beforeAll(() => setLevel('error'));

const result = (over: Partial<WalkResult> = {}): WalkResult => ({ pks: ['a', 'b', 'c'], pages: 2, complete: true,
  endConfirmed: true, endEvidence: 'probe', quarantined: 0, reason: 'no-more-pages', cursor: null, ...over });

function run(walk: WalkResult, census?: { pages: number; walkMax: number }) {
  const calls: WalkArgs[] = [];
  const walker = { walkAll: async (a: WalkArgs) => { calls.push(a); return walk; } } as unknown as ListPageWalker;
  const fetch = walkOwnList({ which: 'followers', label: 'test', ownUsername: 'me', sentinel: new FakeSentinel() as unknown as Sentinel,
    pageReader: {} as FollowersPageReader, walker, ownPk: 'ME', bounds: { maxRounds: 1, noNewStop: 1 }, onRow: () => {},
    ...(census === undefined ? {} : { census }) });
  return { calls, fetch };
}

test('a census longer than the host session can walk is refused before any page', async () => {
  const { calls, fetch } = run(result(), { pages: 12, walkMax: 11 });
  expect(await fetch).toEqual({ pks: [], complete: false, reason: 'too-large' });
  expect(calls).toHaveLength(0);
});

test('a sized census walks at most its header-relative pages, tagged as a census read', async () => {
  const { calls, fetch } = run(result(), { pages: 7, walkMax: 50 });
  await fetch;
  expect(calls[0]).toMatchObject({ maxPages: 7, readUse: 'census' });
});

test('the walk forwards its quarantined rows, its end evidence and what it measured', async () => {
  const { fetch } = run(result({ quarantined: 2, reason: 'no-more-pages' }));
  expect(await fetch).toMatchObject({ complete: true, quarantined: 2, rows: 3, pages: 2, endEvidence: 'probe' });
});
