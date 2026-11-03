/**
 * Mutation responses as evidence (spec §10.5, ADR 0803 amendment): an observed `errors[]` body is
 * Instagram's answer — never "unverified", never a burned record; its text is read over every entry;
 * `not-following` needs both keys; an unrecognised relationship mutation can only ever be a wall.
 */
import { arbitrate } from '@/adapter/arbiter';
import { ActionBlockedError } from '@/adapter/errors';
import { classifyMutationResponse, type MutationVerdict, SURFACE } from '@/adapter/ig-surface';
import { MUTATION_BLINDNESS, MutationWatch } from '@/adapter/mutation-watch';
import { settledResult } from '@/adapter/unfollow-flow';
import { setLevel } from '@/utils/logger';
import { NetworkTab } from '../kit/tabs';

beforeAll(() => setLevel('error'));
beforeEach(() => MUTATION_BLINDNESS.reset());

const ORIGIN = 'https://www.instagram.com';
const errorBody = (...errors: Array<Record<string, string>>) => ({ data: { xdt_create_friendship: null }, errors, status: 'ok' });

describe('the error verdict', () => {
  test('a GraphQL errors[] body is the error verdict, its text joined over every entry and key (U07 M2)', () => {
    expect(SURFACE.extractMutationVerdict(errorBody({ message: 'oops' }, { summary: 'Try Again Later' }))).toEqual({
      verdict: 'error', result: null, message: 'oops — Try Again Later', feedbackText: null, spam: false,
    });
  });

  test('throttle text found only in summary or description classifies as a rate limit', () => {
    const v = SURFACE.extractMutationVerdict(errorBody({ message: 'Error', description: 'Please wait a few minutes' }));
    expect(classifyMutationResponse(200, v as MutationVerdict)).toMatchObject({ kind: 'rate-limited', wall: 'action-blocked' });
  });

  test('an errors[] body with no known signature lets the DOM and the block probe decide', () => {
    const v = SURFACE.extractMutationVerdict(errorBody({ message: 'Something went wrong' }));
    expect(classifyMutationResponse(200, v as MutationVerdict)).toEqual({ kind: 'drift-suspect', detail: 'Something went wrong' });
  });

  test('…and when the screen confirms nothing, it is a refusal toward the ladder: never unverified, never burned', async () => {
    const v = SURFACE.extractMutationVerdict(errorBody({ message: 'Something went wrong' })) as MutationVerdict;
    const observed = { kind: 'follow' as const, pk: null, url: `${ORIGIN}/api/graphql`, httpStatus: 200,
      classification: classifyMutationResponse(200, v) };
    const verdict = await arbitrate({ op: 'follow', label: 'actor.follow', observed, watchAvailable: true, latencyMs: 5,
      verifyPostState: async () => false, probeBlock: async () => null, now: () => 1 });
    expect(verdict.kind).not.toBe('ambiguous');
    expect(() => settledResult(verdict, 'actor.follow', 'someone')).toThrow(ActionBlockedError);
  });

  test('a REST fail keeps its meaning: an ordinary refusal', () => {
    const v = SURFACE.extractMutationVerdict({ status: 'fail', message: 'Sorry, this user is not available' });
    expect(classifyMutationResponse(400, v as MutationVerdict).kind).toBe('refused');
  });
});

describe('not-following needs both relationship keys present and false', () => {
  const left = (friendship_status: Record<string, boolean>) => ({ data: { xdt_destroy_friendship: { friendship_status } } });
  test('a renamed outgoing_request can never turn a failed cancel into ok', () => {
    expect(SURFACE.extractMutationVerdict(left({ following: false }), 'unfollow')).toBe(SURFACE.extractMutationVerdict(null));
    expect(SURFACE.extractMutationVerdict(left({ following: false, outgoing_request: false }), 'unfollow')).toMatchObject({
      verdict: 'ok', result: 'not-following',
    });
  });
});

describe('MutationWatch reads every body through the one decoder, and candidates only ever wall', () => {
  const graphqlPost = (name: string, body: unknown, status = 200) => ({
    url: `${ORIGIN}/api/graphql`, status, method: 'POST', requestHeaders: { 'x-fb-friendly-name': name }, body,
  });

  test('a guarded mutation body classifies', async () => {
    const tab = new NetworkTab();
    const watch = new MutationWatch('follow', 'actor.follow', tab);
    tab.emit(graphqlPost('usePolarisFollowMutation',
      `for (;;);${JSON.stringify({ data: { xdt_create_friendship: { friendship_status: { following: true } } } })}`));
    expect((await watch.next(50))?.classification.kind).toBe('ok');
    watch.dispose();
  });

  test('an unrecognised relationship mutation that answered with a wall is a candidate wall at the deadline', async () => {
    const tab = new NetworkTab();
    const watch = new MutationWatch('follow', 'actor.follow', tab);
    tab.emit(graphqlPost('usePolarisFriendshipCreateMutation', errorBody({ message: 'feedback_required' })));
    const seen = await watch.next(20);
    expect(seen).toMatchObject({ via: 'candidate', classification: { kind: 'rate-limited', wall: 'action-blocked' } });
    watch.dispose();
  });

  test('a candidate that looks like success is never a success; unrelated mutations are never candidates', async () => {
    const tab = new NetworkTab();
    const watch = new MutationWatch('follow', 'actor.follow', tab);
    tab.emit(graphqlPost('usePolarisFriendshipCreateMutation', { data: { xdt_x: { friendship_status: { following: true } } } }));
    tab.emit(graphqlPost('usePolarisLikeMediaMutation', errorBody({ message: 'feedback_required' })));
    expect(await watch.next(20)).toBeNull();
    watch.dispose();
  });
});
