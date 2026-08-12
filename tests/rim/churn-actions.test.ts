import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import type { RequestBudget } from '@/governors/request-budget';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import { ok, err, type Result } from '@/utils/result';
import { FakeBudget, FakeSentinel } from './fakes';

/** A fake action-actor recording calls and returning a scripted Result. */
class FakeActionActor {
  followCalls: string[] = [];
  unfollowCalls: string[] = [];
  followResult: Result<void> = ok(undefined);
  unfollowResult: Result<void> = ok(undefined);
  followThrows = false;
  async follow(username: string): Promise<Result<void>> {
    this.followCalls.push(username);
    if (this.followThrows) throw new Error('stale');
    return this.followResult;
  }
  async unfollow(username: string): Promise<Result<void>> {
    this.unfollowCalls.push(username);
    return this.unfollowResult;
  }
}

const clock = new FakeClock(3_000_000);

let store: KnowledgeStore;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
});
afterEach(() => store.close());

interface Built {
  actions: AdapterBackedChurnActions;
  actor: FakeActionActor;
  sentinel: FakeSentinel;
  budget: FakeBudget;
}

const build = (opts: {
  budgetAllows?: boolean;
  sentinel?: FakeSentinel;
  dryRun?: boolean;
  ownPk?: string;
}): Built => {
  const actor = new FakeActionActor();
  const sentinel = opts.sentinel ?? new FakeSentinel();
  const budget = new FakeBudget(opts.budgetAllows ?? true);
  const adapter = { actor, sentinel } as unknown as InstagramAdapter;
  const actions = new AdapterBackedChurnActions({
    adapter,
    budget: budget as unknown as RequestBudget,
    store,
    ownPk: opts.ownPk,
    dryRun: opts.dryRun ?? false,
    clock,
  });
  return { actions, actor, sentinel, budget };
};

test('C1: an exhausted budget refuses the action without touching the actor or sentinel', async () => {
  const { actions, actor, sentinel } = build({ budgetAllows: false });
  const r = await actions.follow('bob');
  expect(r).toEqual({ ok: false });
  expect(actor.followCalls).toEqual([]);
  expect(sentinel.checks).toBe(0); // budget is gated first
});

test('C1: a blocked sentinel refuses the action without touching the actor', async () => {
  const { actions, actor } = build({ sentinel: new FakeSentinel(['challenge']) });
  const r = await actions.follow('bob');
  expect(r).toEqual({ ok: false });
  expect(actor.followCalls).toEqual([]);
});

test('dry-run reports ok without clicking', async () => {
  const { actions, actor } = build({ dryRun: true });
  const r = await actions.follow('bob');
  expect(r).toEqual({ ok: true });
  expect(actor.followCalls).toEqual([]);
});

test('happy path clicks and returns the Actor’s verified result', async () => {
  const { actions, actor } = build({});
  expect(await actions.follow('bob')).toEqual({ ok: true });
  expect(actor.followCalls).toEqual(['bob']);

  expect(await actions.unfollow('carol')).toEqual({ ok: true });
  expect(actor.unfollowCalls).toEqual(['carol']);
});

test('a failed Actor Result is reported as ok:false', async () => {
  const { actions, actor } = build({});
  actor.followResult = err('post-click state not confirmed');
  expect(await actions.follow('bob')).toEqual({ ok: false });
  expect(actor.followCalls).toEqual(['bob']);
});

test('a thrown Actor error is caught and reported as ok:false', async () => {
  const { actions, actor } = build({});
  actor.followThrows = true;
  expect(await actions.follow('bob')).toEqual({ ok: false });
});

test('C2: the own account is observed once so ownPk-anchored edges have an endpoint', async () => {
  const { actions } = build({ ownPk: 'me' });
  expect(store.getAccount('me')).toBeNull();
  await actions.follow('bob');
  expect(store.getAccount('me')).not.toBeNull();
});
