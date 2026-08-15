import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import { ActionBlockedError } from '@/adapter/errors';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import { ok, err, type Result } from '@/utils/result';
import { FakeSentinel } from './fakes';

/** A fake action-actor recording calls and returning a scripted Result. */
class FakeActionActor {
  followCalls: string[] = [];
  unfollowCalls: string[] = [];
  followResult: Result<{ clicked: boolean }> = ok({ clicked: true });
  unfollowResult: Result<{ clicked: boolean }> = ok({ clicked: true });
  followThrows = false;
  async follow(username: string): Promise<Result<{ clicked: boolean }>> {
    this.followCalls.push(username);
    if (this.followThrows) throw new Error('stale');
    return this.followResult;
  }
  async unfollow(username: string): Promise<Result<{ clicked: boolean }>> {
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
}

const build = (opts: {
  sentinel?: FakeSentinel;
  dryRun?: boolean;
  ownPk?: string;
}): Built => {
  const actor = new FakeActionActor();
  const sentinel = opts.sentinel ?? new FakeSentinel();
  const adapter = { actor, sentinel } as unknown as InstagramAdapter;
  const actions = new AdapterBackedChurnActions({
    adapter,
    store,
    ownPk: opts.ownPk,
    dryRun: opts.dryRun ?? false,
    clock,
  });
  return { actions, actor, sentinel };
};

test('R4: a blocked sentinel BLOCKS the action without touching the actor', async () => {
  const { actions, actor } = build({ sentinel: new FakeSentinel(['challenge']) });
  const r = await actions.follow('bob');
  expect(r).toEqual({ status: 'blocked' });
  expect(actor.followCalls).toEqual([]);
});

test('dry-run reports simulated without clicking', async () => {
  const { actions, actor } = build({ dryRun: true });
  const r = await actions.follow('bob');
  expect(r).toEqual({ status: 'simulated' });
  expect(actor.followCalls).toEqual([]);
});

test('happy path clicks and reports ok from the Actor’s verified result', async () => {
  const { actions, actor } = build({});
  expect(await actions.follow('bob')).toEqual({ status: 'ok', alreadyInState: false });
  expect(actor.followCalls).toEqual(['bob']);

  expect(await actions.unfollow('carol')).toEqual({ status: 'ok', alreadyInState: false });
  expect(actor.unfollowCalls).toEqual(['carol']);
});

test('Phase A: an ok WITHOUT a click surfaces alreadyInState (external actor owns the state)', async () => {
  const { actions, actor } = build({});
  actor.followResult = ok({ clicked: false });
  expect(await actions.follow('bob')).toEqual({ status: 'ok', alreadyInState: true });

  actor.unfollowResult = ok({ clicked: false });
  expect(await actions.unfollow('carol')).toEqual({ status: 'ok', alreadyInState: true });
});

test('a failed Actor Result is reported as failed', async () => {
  const { actions, actor } = build({});
  actor.followResult = err('post-click state not confirmed');
  expect(await actions.follow('bob')).toEqual({ status: 'failed' });
  expect(actor.followCalls).toEqual(['bob']);
});

test('a thrown Actor error is caught and reported as failed', async () => {
  const { actions, actor } = build({});
  actor.followThrows = true;
  expect(await actions.follow('bob')).toEqual({ status: 'failed' });
});

test('C2: the own account is observed once so ownPk-anchored edges have an endpoint', async () => {
  const { actions } = build({ ownPk: 'me' });
  expect(store.getAccount('me')).toBeNull();
  await actions.follow('bob');
  expect(store.getAccount('me')).not.toBeNull();
});

test('an ActionBlockedError from the actor maps to BLOCKED (record/candidate untouched)', async () => {
  const { actions, actor } = build({});
  actor.unfollow = async () => {
    throw new ActionBlockedError('actor.unfollow', '/try again later/i');
  };

  const outcome = await actions.unfollow('bob');

  // Blocked, never 'failed': the schedulers leave the record untouched and
  // back off instead of burning a retry/candidate on Instagram throttling.
  expect(outcome.status).toBe('blocked');
});
