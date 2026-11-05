/**
 * The walker's caller hooks (F2a step 4): `stopAfterPage` ends a walk with
 * reason `caller-stop` once the page's rows are written and before any pacing
 * sleep; `readUse` tags the page's read debit. Unused, the walk is unchanged.
 */
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { FakeClock } from '@/governors/clock';
import { ReadBudget } from '@/governors/read-budget';
import { ListPageWalker } from '@/rim/list-page-walker';
import type { Observation } from '@/store/types';
import { setLevel } from '@/utils/logger';
import { FakeSentinel, FakeTab, followersBody } from '../kit/fakes';
import { readLimits } from '../kit/read-limits';

beforeAll(() => setLevel('error'));

const okEnv = (body: unknown): unknown => ({ ok: true, status: 200, contentType: 'application/json', json: body });

const walkerOver = (envelopes: unknown[], readBudget?: ReadBudget) => {
  const tab = new FakeTab();
  let i = 0;
  tab.onEvaluate = () => envelopes[i++];
  const sleeps: number[] = [];
  const walker = new ListPageWalker({ tab, reader: new Reader(), clock: new FakeClock(3_000_000), readBudget,
    sleep: async (ms) => { sleeps.push(ms); }, rng: () => 0.5 });
  return { walker, sleeps, fetches: () => i };
};

const base = { pk: 'ME', which: 'followers' as const, sentinel: new FakeSentinel() as unknown as Sentinel };

describe('stopAfterPage', () => {
  test('true after the first page ends the walk there: rows written, no pacing sleep, reason caller-stop', async () => {
    const { walker, sleeps, fetches } = walkerOver([okEnv(followersBody(['11', '12'], 'C1', true)),
      okEnv(followersBody(['13'], null, false))]);
    const seen: string[] = [];
    const pages: Array<readonly Observation[]> = [];
    const result = await walker.walkAll({ ...base, onObservation: (obs) => seen.push(obs.accountPk),
      stopAfterPage: (page) => { pages.push(page); return true; } });
    expect(result).toMatchObject({ reason: 'caller-stop', complete: false, endConfirmed: false, pages: 1 });
    expect(seen).toEqual(['11', '12']);
    expect(pages.map((p) => p.map((o) => o.accountPk))).toEqual([['11', '12']]);
    expect(sleeps).toEqual([]);
    expect(fetches()).toBe(1);
    expect(result.cursor).toBe('C1');
  });

  test('false on every page leaves the walk exactly as without the hook', async () => {
    const pages = [okEnv(followersBody(['11', '12'], 'C1', true)), okEnv(followersBody(['13'], null, false)),
      okEnv(followersBody([], null, false))];
    const plain = walkerOver(pages);
    const hooked = walkerOver(pages);
    const a = await plain.walker.walkAll({ ...base, onObservation: () => {} });
    const b = await hooked.walker.walkAll({ ...base, onObservation: () => {}, stopAfterPage: () => false });
    expect(b).toEqual(a);
    expect(hooked.sleeps).toEqual(plain.sleeps);
  });
});

describe('readUse', () => {
  const store = (): { getReadBudgetState(): string | null; setReadBudgetState(raw: string | null): void } => {
    let raw: string | null = null;
    return { getReadBudgetState: () => raw, setReadBudgetState: (r) => { raw = r; } };
  };

  test('tags every page debit of the walk with its use', async () => {
    const budget = new ReadBudget({ store: store(), clock: new FakeClock(1_000), limits: readLimits({ listPages: 10 }) });
    const { walker } = walkerOver([okEnv(followersBody(['11'], null, false)), okEnv(followersBody([], null, false))], budget);
    await walker.walkAll({ ...base, onObservation: () => {}, readUse: 'check' });
    const debits = budget.snapshot().debits;
    expect(debits.length).toBeGreaterThan(0);
    expect(debits.every((d) => d.use === 'check' && d.kind === 'list-page')).toBe(true);
  });

  test('without a use, a debit carries no use field (the v1 shape, unchanged)', async () => {
    const budget = new ReadBudget({ store: store(), clock: new FakeClock(1_000), limits: readLimits({ listPages: 10 }) });
    const { walker } = walkerOver([okEnv(followersBody(['11'], null, false)), okEnv(followersBody([], null, false))], budget);
    await walker.walkAll({ ...base, onObservation: () => {} });
    expect(budget.snapshot().debits.every((d) => !('use' in d))).toBe(true);
  });

  test('a v1 snapshot without use still parses, and a tagged one round-trips', () => {
    const s = store();
    s.setReadBudgetState(JSON.stringify({ version: 1, debits: [{ at: 900, kind: 'profile', purpose: 'reconciliation', count: 1 }] }));
    const budget = new ReadBudget({ store: s, clock: new FakeClock(1_000), limits: readLimits({ profiles: 5 }) });
    expect(budget.consume('profile', 'reconciliation', 1, 'verify').allowed).toBe(true);
    expect(budget.snapshot().debits.map((d) => d.use ?? null)).toEqual([null, 'verify']);
  });
});
