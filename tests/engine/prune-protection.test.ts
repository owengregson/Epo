/**
 * Protection on the cleanup paths (spec §7.4): P5/P6 the run and P7 the woven feed judge each
 * candidate's stored facts as they stand NOW. Protected rows are skipped (no actionable slot spent),
 * a paused index stops a run and yields the feed, and the candidates read is annotated.
 */
import { PruneEngine } from '@/engine/prune-engine';
import { FakeClock } from '@/governors/clock';
import type { ClickVerdict } from '@/shared/click-verdict';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { FakeListSource, FakePruneActions, FakeSentinel, kitStore, OWN_PK, PRUNE_CFG, T0 } from '../kit/engine-harness';
import { ProtectionRig } from '../kit/harness-journal';

function build(following: string[], followers: string[] = []) {
  const store = kitStore();
  store.setOwnPk(OWN_PK);
  const clock = new FakeClock(T0);
  const churn = new FakePruneActions();
  const rig = new ProtectionRig(clock);
  for (const pk of following) {
    if (pk !== OWN_PK) store.observe({ accountPk: pk, observedAt: T0, source: 'followers-list', fields: { username: `u${pk}` } });
  }
  const engine = new PruneEngine({ store, clock, ownPk: OWN_PK, ownFollowing: new FakeListSource(following),
    ownFollowers: new FakeListSource(followers), churnActions: churn, sentinel: new FakeSentinel(), cfg: PRUNE_CFG,
    sleep: async () => {}, rng: () => 0.5, protection: rig.port });
  return { store, clock, churn, rig, engine };
}

const bio = (store: KnowledgeStore, pk: string, text: string): void =>
  store.observe({ accountPk: pk, observedAt: T0, source: 'profile', fields: { bio: text } });

describe('P5/P6 — the run', () => {
  test('the census stays raw; the counts and the run skip what a rule protects', async () => {
    const { store, churn, rig, engine } = build([OWN_PK, '1', '2', '3', '4'], ['2']);
    rig.account('4', 'u4').words('cafe');
    bio(store, '3', 'Cafe Noir');
    const scan = await engine.scan();
    expect(scan.candidates.map((c) => c.pk)).toEqual(['1', '3', '4']);
    expect(engine.status()).toMatchObject({ candidates: 1, remaining: 1, rawRemaining: 3 });
    await engine.run();
    expect(churn.unfollows).toEqual(['u1']);
  });

  test('bio words shield a prune candidate now, whether or not they follow back', async () => {
    const { store, churn, rig, engine } = build([OWN_PK, '1', '2']);
    rig.words('dog');
    bio(store, '1', 'Dog mom \u{1F436}');
    bio(store, '2', 'photographer');
    await engine.run();
    expect(churn.unfollows).toEqual(['u2']);
  });

  test('a rule added mid-run is honoured from that moment on; the protected row is consumed', async () => {
    const { store, churn, rig, engine } = build([OWN_PK, '1', '2', '3']);
    await engine.scan();
    churn.unfollow = async (username: string) => {
      churn.unfollows.push(username);
      if (username === 'u1') rig.account('2', 'u2');
      return { status: 'ok' };
    };
    await engine.run();
    expect(churn.unfollows).toEqual(['u1', 'u3']);
    expect(store.getPruneScan()?.remaining.map((c) => c.pk) ?? []).not.toContain('2');
  });

  test('a paused index stops the run with every unvisited candidate still runnable', async () => {
    const { churn, rig, engine, store } = build([OWN_PK, '1', '2']);
    await engine.scan();
    rig.pause('needs-review');
    await engine.run();
    expect(churn.unfollows).toEqual([]);
    expect(engine.status()).toMatchObject({ state: 'done', scanReady: true });
    expect(store.getPruneScan()?.remaining.map((c) => c.pk)).toEqual(['1', '2']);
  });

  test('a protection edit re-derives the cached scan live (no re-lock, no re-scan)', async () => {
    const { rig, engine } = build([OWN_PK, '1', '2']);
    await engine.scan();
    expect(engine.status().candidates).toBe(2);
    rig.account('1', 'u1');
    expect(engine.status()).toMatchObject({ candidates: 1, remaining: 1, scanReady: true });
    rig.settings = { ...rig.settings, accounts: [] };
    rig.rev += 1;
    expect(engine.status().candidates).toBe(2);
  });

  test('a restart derives the restored counts against the CURRENT rules', async () => {
    const first = build([OWN_PK, '1', '2']);
    await first.engine.scan();
    first.rig.account('1', 'u1');
    const restarted = new PruneEngine({ store: first.store, clock: first.clock, ownPk: OWN_PK,
      ownFollowing: new FakeListSource([OWN_PK, '1', '2']), ownFollowers: new FakeListSource([]),
      churnActions: first.churn, sentinel: new FakeSentinel(), cfg: PRUNE_CFG, sleep: async () => {}, rng: () => 0.5,
      protection: first.rig.port });
    expect(restarted.status().remaining).toBe(1);
    await restarted.run();
    expect(first.churn.unfollows).toEqual(['u2']);
  });
});

describe('P7 — the woven feed', () => {
  test('a protected row is skipped and consumed without spending an actionable slot', async () => {
    const { store, rig, engine, clock } = build(['a', 'b']);
    rig.account('a', 'ua');
    await engine.scan();
    expect(engine.status().remaining).toBe(1);
    expect(engine.nextCandidate(clock.now())).toEqual({ pk: 'b', username: 'ub' });
    expect(engine.status().remaining).toBe(1);
    expect(store.getPruneScan()?.remaining.map((c) => c.pk)).not.toContain('a');
  });

  test('a paused index yields the feed to follows without consuming anything', async () => {
    const { store, rig, engine, clock } = build(['a', 'b']);
    await engine.scan();
    rig.pause('unavailable');
    expect(engine.nextCandidate(clock.now())).toBeNull();
    expect(store.getPruneScan()?.remaining.map((c) => c.pk)).toEqual(['a', 'b']);
  });
});

describe('P5–P7 at the click — the review consumes, never parks', () => {
  const reviewOn = (churn: FakePruneActions, by: Record<string, ClickVerdict>): void => {
    churn.unfollow = async (username: string) => {
      churn.unfollows.push(username);
      const verdict = by[username];
      return verdict === undefined ? { status: 'ok' } : { status: 'reviewed', verdict };
    };
  };

  test('protected or unreadable at the click: skipped and marked visited, no ledger row, no park', async () => {
    const { store, churn, engine } = build([OWN_PK, '1', '2', '3']);
    reviewOn(churn, { u1: { kind: 'protected', by: 'bio-word', match: 'cafe' }, u2: { kind: 'protection-unknown', missing: 'bio' } });
    await engine.run();
    expect(churn.unfollows).toEqual(['u1', 'u2', 'u3']);
    expect(store.pruneCountSince(0)).toBe(1);
    expect(store.getPruneScan()?.remaining ?? []).toEqual([]);
    expect(engine.status().state).toBe('done');
  });

  test('paused at the click: the run stops and the candidate stays unvisited', async () => {
    const { store, churn, engine } = build([OWN_PK, '1', '2']);
    reviewOn(churn, { u1: { kind: 'protection-paused', state: 'needs-review' } });
    await engine.run();
    expect(churn.unfollows).toEqual(['u1']);
    expect(store.getPruneScan()?.remaining.map((c) => c.pk)).toEqual(['1', '2']);
    expect(engine.status()).toMatchObject({ state: 'done', scanReady: true });
  });

  test('the woven feed consumes a protected review; a paused one keeps the candidate', async () => {
    const { store, churn, engine, clock } = build(['a', 'b']);
    await engine.scan();
    reviewOn(churn, { ua: { kind: 'protection-paused', state: 'unavailable' }, ub: { kind: 'protected', by: 'account', match: 'b' } });
    expect(await engine.executeUnfollow({ pk: 'a', username: 'ua' }, clock.now())).toBe('reviewed');
    expect(store.getPruneScan()?.remaining.map((c) => c.pk)).toEqual(['a', 'b']);
    expect(await engine.executeUnfollow({ pk: 'b', username: 'ub' }, clock.now())).toBe('reviewed');
    expect(store.getPruneScan()?.remaining.map((c) => c.pk)).toEqual(['a']);
  });
});

test('the candidates read carries the rule that keeps each row and whether its bio was unread', async () => {
  const { store, rig, engine } = build([OWN_PK, '1', '2', '3']);
  rig.words('cafe').account('2', 'u2');
  bio(store, '1', 'cafe');
  await engine.scan();
  const rows = store.getPruneScan()?.remaining ?? [];
  expect(engine.candidateViews(rows)).toEqual([
    { pk: '1', username: 'u1', protectedBy: 'bio-word', bioUnread: false },
    { pk: '2', username: 'u2', protectedBy: 'account', bioUnread: false },
    { pk: '3', username: 'u3', protectedBy: null, bioUnread: true },
  ]);
  rig.pause('needs-review');
  expect(engine.candidateViews(rows).map((r) => r.protectedBy)).toEqual(['bio-word', 'account', null]);
});
