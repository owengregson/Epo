/**
 * AdapterBackedProfileEnricher — enrichment by VISITING profiles.
 *
 * Since 2026-10-08 a profile is read by opening it (`rim/profile-visit.ts`):
 * the page's own GraphQL body carries the counts and the ProfileObserver
 * writes it to the store. The enricher owns the PASS — sentinel gating,
 * pacing, the wall streak, the permanent `gone` marker, progress — and is
 * tested here against a scripted visitor. The store write is the observer's,
 * tested in `profile-visit.test.ts`.
 */
import type { Sentinel } from '@/adapter/sentinel';
import { FakeClock } from '@/governors/clock';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import type { ProfileVisit, ProfileVisitor } from '@/rim/profile-visit-port';
import { toVeilInfo } from '@/shared/live-op';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RECOVERY } from '@/timing/config';
import { setLevel } from '@/utils/logger';
import { FakeSentinel } from '../kit/fakes';
import { openTestStore } from '../kit/store';

beforeAll(() => setLevel('error'));

const ok = (pk: string, username: string): ProfileVisit => ({
  ok: true,
  obs: { accountPk: pk, observedAt: 1, source: 'profile', fields: { username, followers: 10, following: 10 } },
  viewer: { following: false, requested: false, followsUs: false },
});
const fail = (kind: 'gone' | 'walled' | 'unanswered' | 'tab'): ProfileVisit => ({ ok: false, kind, detail: {} });

/** A visitor answering a scripted outcome per username (`unanswered` when unscripted). */
class ScriptedVisitor implements ProfileVisitor {
  visited: string[] = [];
  outcomes: Record<string, ProfileVisit> = {};
  async visit(username: string): Promise<ProfileVisit> {
    this.visited.push(username);
    return this.outcomes[username] ?? fail('unanswered');
  }
}

const clock = new FakeClock(5_000_000);
const noSleep = async (): Promise<void> => {};

let store: KnowledgeStore;
beforeEach(() => {
  store = openTestStore(':memory:');
});
afterEach(() => store.close());

type Report = { kind: string; label: string; count?: number; total?: number } | null;

const build = (opts?: { sentinel?: FakeSentinel; batchCap?: number; sleep?: (ms: number) => Promise<void> }) => {
  const visitor = new ScriptedVisitor();
  const activity: Report[] = [];
  const enricher = new AdapterBackedProfileEnricher({
    visitor,
    store,
    sentinel: (opts?.sentinel ?? new FakeSentinel()) as unknown as Sentinel,
    clock,
    batchCap: opts?.batchCap,
    sleep: opts?.sleep ?? noSleep,
    reporter: { report: (info) => activity.push(toVeilInfo(info)), clear: () => activity.push(null) },
  });
  return { enricher, visitor, activity };
};

test('visits each username and counts the profiles that answered', async () => {
  const { enricher, visitor } = build();
  visitor.outcomes = { alice: ok('101', 'alice'), bob: ok('102', 'bob') };

  expect(await enricher.enrich(['alice', 'bob'])).toBe(2);
  expect(visitor.visited).toEqual(['alice', 'bob']);
});

test('paces even when the sentinel blocks, so a persistent block cannot spin', async () => {
  const sleeps: number[] = [];
  const { enricher, visitor } = build({
    sentinel: new FakeSentinel([], 'challenge'),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(await enricher.enrich(['a', 'b', 'c'])).toBe(0);
  expect(visitor.visited).toEqual([]); // blocked before any page load
  expect(sleeps).toHaveLength(2); // after the 1st and 2nd, none after the last
});

test('a non-ok sentinel skips that username and visits the rest', async () => {
  const { enricher, visitor } = build({ sentinel: new FakeSentinel(['challenge']) });
  visitor.outcomes = { alice: ok('101', 'alice'), bob: ok('102', 'bob') };

  expect(await enricher.enrich(['alice', 'bob'])).toBe(1);
  expect(visitor.visited).toEqual(['bob']);
});

test('`gone` marks the account permanently un-enrichable; `unanswered` does NOT', async () => {
  const { enricher, visitor } = build();
  for (const [pk, username] of [
    ['77', 'gone_forever'],
    ['88', 'blank_page'],
  ]) {
    store.observe({ accountPk: pk, observedAt: 1, source: 'followers-list', fields: { username } });
  }
  visitor.outcomes = { gone_forever: fail('gone') };

  expect(await enricher.enrich(['gone_forever', 'blank_page'])).toBe(0);
  expect(store.getAccount('77')?.enrichFailedAt).toBeDefined(); // the page says: not available
  expect(store.getAccount('88')?.enrichFailedAt).toBeUndefined(); // ambiguous → retryable
});

test('a WALL ends the pass: consecutive walled visits stop the batch instead of draining it', async () => {
  const { enricher, visitor } = build();
  const names = Array.from({ length: 12 }, (_, i) => `walled${i}`);
  for (const n of names) visitor.outcomes[n] = fail('walled');

  expect(await enricher.enrich(names)).toBe(0);
  expect(visitor.visited).toHaveLength(RECOVERY.BLOCKED_STREAK_ENTRY);
});

test('pages that never answer count toward the wall streak too', async () => {
  const { enricher, visitor } = build();
  const names = Array.from({ length: 12 }, (_, i) => `blank${i}`); // unscripted → unanswered

  expect(await enricher.enrich(names)).toBe(0);
  expect(visitor.visited).toHaveLength(RECOVERY.BLOCKED_STREAK_ENTRY);
});

test('an isolated walled visit does not end the pass', async () => {
  const { enricher, visitor } = build();
  visitor.outcomes = {
    w1: fail('walled'),
    ok1: ok('11', 'ok1'),
    w2: fail('walled'),
    ok2: ok('12', 'ok2'),
  };

  expect(await enricher.enrich(['w1', 'ok1', 'w2', 'ok2'])).toBe(2);
});

test('a tab that cannot navigate ends the pass at once (retrying cannot revive it)', async () => {
  const { enricher, visitor } = build();
  visitor.outcomes = { a: fail('tab'), b: ok('2', 'b') };

  expect(await enricher.enrich(['a', 'b'])).toBe(0);
  expect(visitor.visited).toEqual(['a']);
});

test('respects batchCap: only the first N usernames are visited', async () => {
  const { enricher, visitor } = build({ batchCap: 1 });
  visitor.outcomes = { alice: ok('101', 'alice'), bob: ok('102', 'bob') };

  expect(await enricher.enrich(['alice', 'bob'])).toBe(1);
  expect(visitor.visited).toEqual(['alice']);
});

test('an aborted driver signal ends the pass between usernames (nothing visited)', async () => {
  const visitor = new ScriptedVisitor();
  const ac = new AbortController();
  ac.abort();
  const enricher = new AdapterBackedProfileEnricher({
    visitor,
    store,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    clock,
    sleep: noSleep,
    abortSignal: () => ac.signal,
  });

  expect(await enricher.enrich(['alice', 'bob'])).toBe(0);
  expect(visitor.visited).toEqual([]);
});

test('reports determinate progress for the veil, advancing on SKIPS too, then clears', async () => {
  const { enricher, visitor, activity } = build();
  visitor.outcomes = { alice: ok('101', 'alice'), carol: ok('103', 'carol') };

  await enricher.enrich(['alice', 'bob', 'carol']);

  const reports = activity.filter(Boolean) as Array<Exclude<Report, null>>;
  expect(reports.every((r) => r.kind === 'page' && r.label === 'Visiting profiles')).toBe(true);
  expect(reports.every((r) => r.total === 3)).toBe(true);
  expect(reports.map((r) => r.count)).toEqual([0, 1, 2]);
  expect(activity[activity.length - 1]).toBeNull();
});

test('a later successful stats observation heals the enrich-failed marker', async () => {
  store.observe({ accountPk: '77', observedAt: 1, source: 'followers-list', fields: { username: 'x' } });
  store.markEnrichmentFailed('x', 2);
  expect(store.getAccount('77')?.enrichFailedAt).toBe(2);
  store.observe({ accountPk: '77', observedAt: 3, source: 'profile', fields: { followers: 10, following: 5 } });
  expect(store.getAccount('77')?.enrichFailedAt).toBeUndefined();
});
