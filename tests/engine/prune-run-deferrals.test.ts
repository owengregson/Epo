/**
 * Cleanup consumption (spec §9.7): only a post-visit verdict marks a candidate visited. A refusal before
 * the visit is served exactly (deadline, hourly cap), passes a journal-blocked candidate over for a later
 * pass, or ends the run with its typed reason — and never sweeps the unvisited rest as visited.
 */
import type { ChurnActionOutcome } from '@/engine/churn-scheduler';
import { pruneDeferral } from '@/engine/prune-candidate';
import { makePruneHarness as build, OWN_PK, T0 } from '../kit/engine-harness';

const deferred = (reason: string, until: number | null): ChurnActionOutcome =>
  ({ status: 'blocked', cause: 'local-policy', verdict: { kind: 'deferred', reason, until } });

/** Scripted outcomes per username, consumed in order; then a verified ok. */
const script = (h: ReturnType<typeof build>, plan: Record<string, ChurnActionOutcome[]>): void => {
  h.churn.unfollow = async (username: string) => {
    h.churn.unfollows.push(username);
    return plan[username]?.shift() ?? { status: 'ok' };
  };
};
const remaining = (h: ReturnType<typeof build>) => h.store.getPruneScan()?.remaining.map((c) => c.pk);

test('a deadline and an hourly-cap refusal mid-run are served exactly, and leave every unvisited candidate unvisited', async () => {
  const h = build({ following: [OWN_PK, '1', '2', '3', '4'], followers: [] });
  const seenAtRefusal: (string[] | undefined)[] = [];
  script(h, { u2: [deferred('deadline', T0 + 40_000)], u3: [deferred('hourly-cap', T0 + 90_000)] });
  const original = h.churn.unfollow.bind(h.churn);
  h.churn.unfollow = async (username: string) => {
    const out = await original(username);
    if (out.status === 'blocked') seenAtRefusal.push(remaining(h));
    return out;
  };
  await h.engine.run();
  expect(h.churn.unfollows).toEqual(['u1', 'u2', 'u2', 'u3', 'u3', 'u4']);
  // At each refusal the refused candidate and everything after it were still unvisited.
  expect(seenAtRefusal).toEqual([['2', '3', '4'], ['3', '4']]);
  expect(h.sleeps).toEqual(expect.arrayContaining([40_000, 90_000]));
  expect(h.store.pruneCountSince(0)).toBe(4);
  expect(h.engine.status().state).toBe('done');
  h.store.close();
});

test.each(['day-done', 'ceiling', 'read-budget', 'session-closed', 'surface-paused'])(
  'a %s refusal ends the run with its reason, every unvisited candidate still runnable', async (reason) => {
    const h = build({ following: [OWN_PK, '1', '2', '3'], followers: [] });
    script(h, { u2: [deferred(reason, null)] });
    await h.engine.run();
    expect(h.churn.unfollows).toEqual(['u1', 'u2']);
    expect(remaining(h)).toEqual(['2', '3']);
    expect(h.engine.status().state).toBe('done');
    expect(h.completedAt).toEqual([]);
    h.store.close();
  });

test('a journal-blocked candidate is passed over, never marked visited, and handed back for a later pass', async () => {
  const h = build({ following: [OWN_PK, '1', '2', '3'], followers: [] });
  script(h, { u2: [deferred('journal', null)] });
  await h.engine.run();
  expect(h.churn.unfollows).toEqual(['u1', 'u2', 'u3']);
  expect(remaining(h)).toEqual(['2']);
  expect(h.completedAt).toEqual([]);
  h.store.close();
});

test('the classifier: wait out a known instant, pass over the journal, end on the rest, leave anything else alone', () => {
  expect(pruneDeferral({ kind: 'deferred', reason: 'deadline', until: 5 })).toEqual({ do: 'wait', until: 5 });
  expect(pruneDeferral({ kind: 'deferred', reason: 'hourly-cap', until: null })).toEqual({ do: 'end', reason: 'hourly-cap' });
  expect(pruneDeferral({ kind: 'deferred', reason: 'journal', until: null })).toEqual({ do: 'pass' });
  expect(pruneDeferral({ kind: 'deferred', reason: 'walled', until: null })).toBeNull();
  expect(pruneDeferral({ kind: 'deferred', reason: 'shared mutation delay still owed', until: null })).toBeNull();
  expect(pruneDeferral({ kind: 'reheld' })).toBeNull();
  expect(pruneDeferral(undefined)).toBeNull();
});
