/**
 * L-RECOVER-C2 on the walks (spec §10.6): only an ACQUISITION walk reads a source page whose rows moved
 * (C2), into the candidate pool, and then stops — its continuation is never recovered and its resume
 * cursor stays on the last page read canonically. A census, head or following walk never reads C2.
 */
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { ListPageWalker } from '@/rim/list-page-walker';
import { MemorySink } from '@/surface/sink';
import { setLevel } from '@/utils/logger';
import { FakeSentinel, FakeTab, followersBody } from '../kit/fakes';

beforeAll(() => setLevel('error'));

const sentinel = () => new FakeSentinel() as unknown as Sentinel;
const row = (pk: number) => ({ pk: String(pk), pk_id: String(pk), username: `user_${pk}`, is_private: false, is_verified: false });
/** Page one reads canonically; page two moved its rows under a renamed key (and still claims more). */
const PAGES = [followersBody(['11', '12'], '2', true), { items: Array.from({ length: 10 }, (_, i) => row(100 + i)), next_max_id: '4', has_more: true }];

function walker(sink: MemorySink): { walker: ListPageWalker; fetched: () => number } {
  const tab = new FakeTab();
  let page = 0;
  tab.onEvaluate = () => ({ ok: true, status: 200, contentType: 'application/json', json: PAGES[Math.min(page++, PAGES.length - 1)] });
  return { walker: new ListPageWalker({ tab, reader: new Reader({ sink }), sleep: async () => {} }), fetched: () => page };
}

test('an acquisition walk streams the moved rows into the pool, then stops on the page it could not continue', async () => {
  const sink = new MemorySink();
  const { walker: w, fetched } = walker(sink);
  const seen: string[] = [];
  const walk = await w.walkAll({ pk: '7', which: 'followers', arm: 'acquisition', sentinel: sentinel(), onObservation: (o) => seen.push(o.accountPk) });
  expect(seen).toEqual(['11', '12', ...Array.from({ length: 10 }, (_, i) => String(100 + i))]);
  expect(walk).toMatchObject({ complete: false, reason: 'shape-mismatch', recoveredRows: 10, cursor: '2' });
  expect(fetched()).toBe(2);
  expect(sink.snapshot().drift.map((d) => [d.signal.cls, d.signal.hint?.role ?? null])).toContainEqual(['recovered', 'source-rows']);
});

test.each([['a census', 'followers'], ['a following check', 'following']] as const)(
  '%s (no arm) never reads the moved rows: the walk stops with the canonical rows only', async (_n, which) => {
    const { walker: w } = walker(new MemorySink());
    const seen: string[] = [];
    const walk = await w.walkAll({ pk: '7', which, sentinel: sentinel(), onObservation: (o) => seen.push(o.accountPk) });
    expect(seen).toEqual(['11', '12']);
    expect(walk).toMatchObject({ complete: false, reason: 'shape-mismatch', cursor: '2' });
    expect(walk.recoveredRows).toBeUndefined();
  });
