/**
 * The follow/unfollow MUTATION contract: how the surface recognises the
 * mutation request Instagram's web client fires when the action button is
 * pressed, how it reads the server's verdict out of the body, and how the
 * version-agnostic classifier turns (HTTP status, verdict) into the failure
 * family the Actor acts on. A throttled follow on the web shows NO page-level
 * error — the button just snaps back — so the response is the only honest
 * arbiter of whether the action landed.
 */
import {
  classifyMutationResponse,
  isShapeMismatch,
  type MutationVerdict,
  SHAPE_MISMATCH,
  SURFACE,
} from '@/adapter/ig-surface';

const ORIGIN = 'https://www.instagram.com';

describe('SURFACE.matchMutation — recognising the action request', () => {
  test('the web client follow endpoint routes to follow with the pk', () => {
    expect(
      SURFACE.matchMutation({
        url: `${ORIGIN}/api/v1/web/friendships/17841400000/follow/`,
        method: 'POST',
      }),
    ).toEqual({ kind: 'follow', pk: '17841400000' });
  });

  test('the web client unfollow endpoint routes to unfollow — never to follow by substring', () => {
    expect(
      SURFACE.matchMutation({
        url: `${ORIGIN}/api/v1/web/friendships/17841400000/unfollow/`,
        method: 'POST',
      }),
    ).toEqual({ kind: 'unfollow', pk: '17841400000' });
  });

  test('the legacy non-api-prefixed web path and the create/destroy API forms also match', () => {
    expect(SURFACE.matchMutation({ url: `${ORIGIN}/web/friendships/55/follow/` })).toEqual({
      kind: 'follow',
      pk: '55',
    });
    expect(SURFACE.matchMutation({ url: `${ORIGIN}/api/v1/friendships/create/55/` })).toEqual({
      kind: 'follow',
      pk: '55',
    });
    expect(SURFACE.matchMutation({ url: `${ORIGIN}/api/v1/friendships/destroy/55/` })).toEqual({
      kind: 'unfollow',
      pk: '55',
    });
  });

  test('a GraphQL mutation is recognised by its friendly-name request header', () => {
    expect(
      SURFACE.matchMutation({
        url: `${ORIGIN}/graphql/query`,
        method: 'POST',
        requestHeaders: { 'x-fb-friendly-name': 'usePolarisFollowMutation' },
      }),
    ).toEqual({ kind: 'follow', pk: null });
    expect(
      SURFACE.matchMutation({
        url: `${ORIGIN}/graphql/query`,
        method: 'POST',
        requestHeaders: { 'x-fb-friendly-name': 'PolarisUnfollowMutation' },
      }),
    ).toEqual({ kind: 'unfollow', pk: null });
  });

  test('a GraphQL mutation on /api/graphql — where the live client fires GraphQL — matches too', () => {
    expect(
      SURFACE.matchMutation({
        url: `${ORIGIN}/api/graphql`,
        method: 'POST',
        requestHeaders: { 'x-fb-friendly-name': 'usePolarisFollowMutation' },
      }),
    ).toEqual({ kind: 'follow', pk: null });
    expect(
      SURFACE.matchMutation({
        url: `${ORIGIN}/api/graphql/`,
        method: 'POST',
        requestHeaders: { 'x-fb-friendly-name': 'usePolarisUnfollowMutation' },
      }),
    ).toEqual({ kind: 'unfollow', pk: null });
    // The profile QUERY on the same URL is never a mutation.
    expect(
      SURFACE.matchMutation({
        url: `${ORIGIN}/api/graphql`,
        method: 'POST',
        requestHeaders: { 'x-fb-friendly-name': 'PolarisProfilePageContentQuery' },
      }),
    ).toBeNull();
  });

  test('GraphQL QUERIES that merely mention follow are not mutations', () => {
    expect(
      SURFACE.matchMutation({
        url: `${ORIGIN}/graphql/query`,
        method: 'POST',
        requestHeaders: { 'x-fb-friendly-name': 'PolarisProfilePageFollowersListQuery' },
      }),
    ).toBeNull();
    expect(SURFACE.matchMutation({ url: `${ORIGIN}/graphql/query`, method: 'POST' })).toBeNull();
  });

  test('reads and unrelated endpoints never match', () => {
    expect(
      SURFACE.matchMutation({ url: `${ORIGIN}/api/v1/friendships/show/17841400000/`, method: 'GET' }),
    ).toBeNull();
    expect(
      SURFACE.matchMutation({ url: `${ORIGIN}/api/v1/friendships/17841400000/followers/?count=12` }),
    ).toBeNull();
    // A GET against the mutation path is not the client's mutation.
    expect(
      SURFACE.matchMutation({
        url: `${ORIGIN}/api/v1/web/friendships/17841400000/follow/`,
        method: 'GET',
      }),
    ).toBeNull();
  });
});

describe('SURFACE.extractMutationVerdict — the server’s verdict in the body', () => {
  test('a successful web follow: status ok + result', () => {
    const v = SURFACE.extractMutationVerdict({ result: 'following', status: 'ok' });
    expect(isShapeMismatch(v)).toBe(false);
    expect(v).toMatchObject({ verdict: 'ok', result: 'following', spam: false });
  });

  test('a throttled follow: the feedback_required refusal (HTTP 400, no page dialog)', () => {
    const v = SURFACE.extractMutationVerdict({
      message: 'feedback_required',
      spam: true,
      feedback_title: 'Try Again Later',
      feedback_message:
        'We restrict certain activity to protect our community. Tell us if you think we made a mistake.',
      feedback_url: 'https://help.instagram.com/',
      feedback_appeal_label: 'Report problem',
      feedback_ignore_label: 'OK',
      feedback_action: 'report_problem',
      status: 'fail',
    });
    expect(isShapeMismatch(v)).toBe(false);
    expect(v).toMatchObject({
      verdict: 'fail',
      message: 'feedback_required',
      spam: true,
    });
    expect((v as MutationVerdict).feedbackText).toMatch(/Try Again Later/);
    expect((v as MutationVerdict).feedbackText).toMatch(/restrict certain activity/);
  });

  test('a GraphQL mutation body: errors → fail, data → ok (nested verdicts honoured)', () => {
    expect(
      SURFACE.extractMutationVerdict({
        errors: [{ message: 'rate limit exceeded', severity: 'ERROR' }],
        data: null,
      }),
    ).toMatchObject({ verdict: 'fail', message: 'rate limit exceeded' });
    expect(
      SURFACE.extractMutationVerdict({
        data: { xdt_create_friendship: { friendship_status: { following: true } } },
      }),
    ).toMatchObject({ verdict: 'ok', result: 'following' });
    expect(
      SURFACE.extractMutationVerdict({
        data: { xdt_friendship_create: { status: 'fail', message: 'feedback_required', spam: true } },
      }),
    ).toMatchObject({ verdict: 'fail', message: 'feedback_required', spam: true });
  });

  test('a GraphQL envelope reports the relationship it left behind, as the result', () => {
    const body = (friendship_status: Record<string, boolean>): unknown => ({
      data: { xdt_create_friendship: { friendship_status } },
      extensions: { is_final: true },
      status: 'ok',
    });
    expect(SURFACE.extractMutationVerdict(body({ following: true }))).toMatchObject({
      verdict: 'ok',
      result: 'following',
    });
    expect(
      SURFACE.extractMutationVerdict(body({ following: false, outgoing_request: true })),
    ).toMatchObject({ verdict: 'ok', result: 'requested' });
    expect(
      SURFACE.extractMutationVerdict(body({ following: false, outgoing_request: false })),
    ).toMatchObject({ verdict: 'ok', result: 'not-following' });
  });

  test('GraphQL errors outrank the envelope’s own top-level status ok', () => {
    // The envelope says `status: "ok"` about the HTTP exchange, not the
    // mutation: read first, it turned a refused follow into a landed one.
    expect(
      SURFACE.extractMutationVerdict({
        data: { xdt_create_friendship: null },
        errors: [{ message: 'feedback_required', severity: 'CRITICAL' }],
        status: 'ok',
      }),
    ).toMatchObject({ verdict: 'fail', message: 'feedback_required' });
  });

  test('a GraphQL envelope with nothing readable in it is SHAPE_MISMATCH, not a success', () => {
    expect(
      SURFACE.extractMutationVerdict({ data: { xdt_create_friendship: null }, status: 'ok' }),
    ).toBe(SHAPE_MISMATCH);
    expect(SURFACE.extractMutationVerdict({ data: {}, status: 'ok' })).toBe(SHAPE_MISMATCH);
    expect(
      SURFACE.extractMutationVerdict({ data: { xdt_create_friendship: { friendship_status: {} } } }),
    ).toBe(SHAPE_MISMATCH);
  });

  test('an ok envelope whose relationship contradicts the op is never a success', () => {
    const left = (friendship_status: Record<string, boolean>): unknown => ({
      data: { xdt_op: { friendship_status } },
      status: 'ok',
    });
    // A follow that leaves us NOT following was refused without saying so.
    expect(SURFACE.extractMutationVerdict(left({ following: false }), 'follow')).toBe(SHAPE_MISMATCH);
    expect(SURFACE.extractMutationVerdict(left({ following: true }), 'unfollow')).toBe(SHAPE_MISMATCH);
    expect(
      SURFACE.extractMutationVerdict(left({ following: false, outgoing_request: true }), 'unfollow'),
    ).toBe(SHAPE_MISMATCH);
    expect(SURFACE.extractMutationVerdict(left({ following: false }), 'unfollow')).toMatchObject({
      verdict: 'ok',
    });
    expect(SURFACE.extractMutationVerdict(left({ following: true }), 'follow')).toMatchObject({
      verdict: 'ok',
    });
  });

  test('anything else is SHAPE_MISMATCH — never a fabricated verdict', () => {
    expect(SURFACE.extractMutationVerdict(null)).toBe(SHAPE_MISMATCH);
    expect(SURFACE.extractMutationVerdict('<!DOCTYPE html>')).toBe(SHAPE_MISMATCH);
    expect(SURFACE.extractMutationVerdict({ hello: 'world' })).toBe(SHAPE_MISMATCH);
    expect(SURFACE.extractMutationVerdict({ status: 'maybe' })).toBe(SHAPE_MISMATCH);
  });
});

describe('classifyMutationResponse — the failure family', () => {
  const ok: MutationVerdict = {
    verdict: 'ok',
    result: 'following',
    message: null,
    feedbackText: null,
    spam: false,
  };
  const fail = (over: Partial<MutationVerdict>): MutationVerdict => ({
    verdict: 'fail',
    result: null,
    message: null,
    feedbackText: null,
    spam: false,
    ...over,
  });

  test('2xx + ok verdict is ok', () => {
    expect(classifyMutationResponse(200, ok).kind).toBe('ok');
  });

  test('feedback_required is a rate limit whatever the HTTP status', () => {
    for (const status of [400, 200, 403]) {
      const c = classifyMutationResponse(status, fail({ message: 'feedback_required', spam: true }));
      expect(c.kind).toBe('rate-limited');
      expect(c.wall).toBe('action-blocked');
    }
  });

  test('the "Try Again Later" feedback text alone is a rate limit', () => {
    expect(
      classifyMutationResponse(400, fail({ feedbackText: 'Try Again Later — We restrict certain activity' }))
        .kind,
    ).toBe('rate-limited');
  });

  test('the spam flag alone is a rate limit', () => {
    expect(classifyMutationResponse(400, fail({ spam: true })).kind).toBe('rate-limited');
  });

  test('HTTP 429 / 5xx are rate limits even when the body is unreadable', () => {
    expect(classifyMutationResponse(429, SHAPE_MISMATCH).kind).toBe('rate-limited');
    expect(classifyMutationResponse(503, SHAPE_MISMATCH).kind).toBe('rate-limited');
  });

  test('checkpoint / login walls are auth, not rate limits', () => {
    expect(classifyMutationResponse(400, fail({ message: 'checkpoint_required' }))).toMatchObject({
      kind: 'auth',
      wall: 'challenge',
    });
    expect(classifyMutationResponse(403, fail({ message: 'login_required' }))).toMatchObject({
      kind: 'auth',
      wall: 'logged-out',
    });
    expect(classifyMutationResponse(401, SHAPE_MISMATCH).kind).toBe('auth');
    expect(classifyMutationResponse(403, SHAPE_MISMATCH).kind).toBe('auth');
  });

  test('an ordinary refusal (unknown message, 4xx) is refused — a real failed attempt', () => {
    expect(classifyMutationResponse(400, fail({ message: 'Sorry, this user is not available' }))).toMatchObject(
      { kind: 'refused', detail: 'Sorry, this user is not available' },
    );
    expect(classifyMutationResponse(404, SHAPE_MISMATCH).kind).toBe('refused');
  });

  test('a 2xx whose body cannot be read is drift-suspect — never claimed as success', () => {
    expect(classifyMutationResponse(200, SHAPE_MISMATCH).kind).toBe('drift-suspect');
    // An ok verdict on a non-2xx is contradictory: also drift-suspect.
    expect(classifyMutationResponse(400, ok).kind).toBe('drift-suspect');
  });

  test('an unreadable 4xx outside the known families defaults TOWARD rate-limited', () => {
    expect(classifyMutationResponse(400, SHAPE_MISMATCH).kind).toBe('rate-limited');
  });
});
