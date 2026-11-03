import {
  ActionBlockedError,
  ActionRateLimitedError,
  ActionReviewedError,
  AdapterStaleError,
  TabUnavailableError,
  TabUnresponsiveError,
} from '@/adapter/errors';
import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import { FakeClock } from '@/governors/clock';
import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { err, ok, type Result } from '@/utils/result';
import { FakeSentinel } from '../kit/fakes';
import { openTestStore } from '../kit/store';

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
  store = openTestStore(':memory:');
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

test.each(['failed', 'thrown', 'drift'] as const)('a %s result after dispatch reports uncertainty, never a retryable failure', async (failure) => {
  const { actions, actor } = build({});
  actor.follow = async (_username: string, _pk?: string, dispatched?: () => void) => {
    dispatched?.();
    if (failure === 'thrown') throw new Error('lost acknowledgement');
    if (failure === 'drift') throw new AdapterStaleError('actor.follow', 'post-state');
    return err('post-click state not confirmed');
  };
  const dispatched = jest.fn();
  expect(await actions.follow('bob', 'pk', dispatched)).toMatchObject({
    status: 'blocked', cause: 'tab-unhealthy', unverifiedClick: true,
  });
  expect(dispatched).toHaveBeenCalledTimes(1);
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

// --- Recovery-ladder error classification ------------------------------------------

/** Build with an actor whose follow throws the given error. */
const buildThrowing = (e: unknown): Built => {
  const built = build({});
  built.actor.follow = async () => {
    throw e;
  };
  return built;
};

test('a PRE-CLICK tab stall maps to blocked/tab-unhealthy (record-neutral, no unverified flag)', async () => {
  const { actions } = buildThrowing(new TabUnresponsiveError('goto', 30_000));
  const r = await actions.follow('bob');
  expect(r.status).toBe('blocked');
  expect(r.cause).toBe('tab-unhealthy');
  expect(r.unverifiedClick).toBeUndefined();
});

test('a POST-CLICK tab stall additionally flags the unverified click (amendment C)', async () => {
  const { actions } = buildThrowing(new TabUnresponsiveError('evaluate', 15_000, 'post-click'));
  const r = await actions.follow('bob');
  expect(r.status).toBe('blocked');
  expect(r.cause).toBe('tab-unhealthy');
  expect(r.unverifiedClick).toBe(true);
});

test('a destroyed webContents maps to blocked/tab-unhealthy', async () => {
  const { actions } = buildThrowing(new TabUnavailableError('instagram-tab'));
  const r = await actions.follow('bob');
  expect(r.status).toBe('blocked');
  expect(r.cause).toBe('tab-unhealthy');
});

test('an ActionRateLimitedError (the server REFUSED the mutation) maps to blocked/rate-limited', async () => {
  const { actions } = buildThrowing(
    new ActionRateLimitedError('actor.follow', 400, 'feedback_required: Try Again Later'),
  );
  // Record-neutral like every block (nothing landed), but the cause is a
  // DEFINITIVE rate wall — the engine ladders on it at once, no streak needed.
  expect(await actions.follow('bob')).toEqual({ status: 'blocked', cause: 'rate-limited' });
});

test('an AdapterStaleError maps to failed/drift (retry burned; drift evidence tallied)', async () => {
  const { actions } = buildThrowing(new AdapterStaleError('actor.follow', 'header button'));
  const r = await actions.follow('bob');
  expect(r.status).toBe('failed');
  expect(r.cause).toBe('drift');
});

test('an unclassified throw stays a plain failed (no cause)', async () => {
  const { actions } = buildThrowing(new Error('boom'));
  const r = await actions.follow('bob');
  expect(r.status).toBe('failed');
  expect(r.cause).toBeUndefined();
});

test('a click review that consumed the work maps to reviewed, carrying its verdict (spec §9.7)', async () => {
  const { actions, actor } = build({});
  const verdict = { kind: 'protected', by: 'bio-word', match: 'cafe' } as const;
  actor.unfollow = async () => {
    throw new ActionReviewedError(verdict);
  };
  // Neither a deferral (which retries the same work) nor a failure: the scheduler settles the record.
  expect(await actions.unfollow('bob')).toEqual({ status: 'reviewed', verdict });
});
