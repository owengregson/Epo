/**
 * The Arbiter — one decision, shared by follow and unfollow.
 *
 * The behaviours asserted here used to live twice (in `followDriven` and
 * `unfollowDriven`) and were only ever tested through the Actor. Testing the
 * decision directly is what makes "record untouched on block" checkable rather
 * than merely conventional: each verdict carries its own record `effect`.
 */

import { arbitrate, wallOf } from '@/adapter/arbiter';
import type { MutationObservation } from '@/adapter/mutation-watch';
import type { Verdict } from '@/adapter/verdict';
import { describeVerdict, isCommit, VERDICT_EFFECT } from '@/adapter/verdict';

const observation = (
  kind: MutationObservation['classification']['kind'],
  extra: Partial<MutationObservation> = {},
): MutationObservation => ({
  kind: 'follow',
  pk: '700000000001',
  url: 'https://www.instagram.com/api/v1/web/friendships/1/follow/',
  httpStatus: 200,
  classification: { kind, detail: 'detail' },
  ...extra,
});

const input = (over: Partial<Parameters<typeof arbitrate>[0]> = {}): Parameters<typeof arbitrate>[0] => ({
  op: 'follow',
  label: 'actor.follow',
  observed: null,
  watchAvailable: true,
  latencyMs: null,
  verifyPostState: async () => false,
  probeBlock: async () => null,
  now: () => 1_000,
  ...over,
});

describe('the response arbitrates when one arrived (ADR 0304)', () => {
  test('an ok response is a COMMIT even when the DOM has not settled', async () => {
    const v = await arbitrate(
      input({ observed: observation('ok'), verifyPostState: async () => false }),
    );
    expect(v.kind).toBe('landed');
    expect(v.effect).toBe('commit');
    expect(isCommit(v)).toBe(true);
    // The response is authoritative; a lagging re-render must not turn a
    // confirmed follow into a failure.
    expect(v.evidence.source).toBe('response');
  });

  test('a rate-limited response leaves the record UNTOUCHED and names the wall', async () => {
    const v = await arbitrate(
      input({
        observed: observation('rate-limited', {
          httpStatus: 400,
          classification: { kind: 'rate-limited', detail: 'feedback_required', wall: 'action-blocked' },
        }),
        // The optimistic DOM flip says "success" — and must not win.
        verifyPostState: async () => true,
      }),
    );
    expect(v.kind).toBe('throttled');
    expect(v.effect).toBe('untouched');
    expect(wallOf(v)).toBe('action-blocked');
    expect(isCommit(v)).toBe(false);
  });

  test('an auth response is a WALL, not a per-account failure', async () => {
    const v = await arbitrate(
      input({
        observed: observation('auth', {
          classification: { kind: 'auth', detail: 'checkpoint_required', wall: 'challenge' },
        }),
      }),
    );
    expect(v.kind).toBe('walled');
    expect(v.effect).toBe('untouched');
    expect(wallOf(v)).toBe('challenge');
  });

  test('an ordinary refusal is a failed attempt for THIS account', async () => {
    const v = await arbitrate(
      input({ observed: observation('refused', { httpStatus: 404 }) }),
    );
    expect(v.kind).toBe('refused');
    expect(v.effect).toBe('fail');
    expect(v.evidence.httpStatus).toBe(404);
  });

  test('a drift-suspect response falls through to the DOM, as before', async () => {
    const v = await arbitrate(
      input({
        observed: observation('drift-suspect'),
        verifyPostState: async () => true,
      }),
    );
    expect(v.kind).toBe('landed');
    // Both sources contributed: an unreadable 2xx is never claimed alone.
    expect(v.evidence.source).toBe('both');
  });
});

describe('the DOM decides when no response arrived', () => {
  test('a settled post-state is a commit, credited to the DOM', async () => {
    const v = await arbitrate(input({ verifyPostState: async () => true }));
    expect(v).toMatchObject({ kind: 'landed', effect: 'commit' });
    expect(v.evidence.source).toBe('dom');
  });

  test('an unsettled post-state WITH an interstitial is a wall, record untouched', async () => {
    const v = await arbitrate(input({ probeBlock: async () => '/try again later/i' }));
    expect(v).toMatchObject({ kind: 'walled', effect: 'untouched', wall: 'action-blocked' });
    // Observed live 2026-08-15: without this, every throttled unfollow burned a
    // candidate as "failed".
    expect(v.kind === 'walled' && v.detail).toBe('/try again later/i');
  });

  test('an unsettled post-state with a CLEAN page is an ordinary failure', async () => {
    const v = await arbitrate(input());
    expect(v).toMatchObject({ kind: 'refused', effect: 'fail' });
  });
});

describe('the effect table is total', () => {
  test('every verdict kind declares a record effect', () => {
    const kinds: Array<Verdict['kind']> = [
      'landed',
      'noop',
      'refused',
      'throttled',
      'walled',
      'ambiguous',
      'drift',
    ];
    for (const kind of kinds) expect(VERDICT_EFFECT[kind]).toBeDefined();
    // The two walls are the invariant this table exists to protect.
    expect(VERDICT_EFFECT.throttled).toBe('untouched');
    expect(VERDICT_EFFECT.walled).toBe('untouched');
  });

  test('describeVerdict is one loggable line', async () => {
    const v = await arbitrate(input({ observed: observation('ok') }));
    expect(describeVerdict(v)).toContain('follow:landed');
    expect(describeVerdict(v)).toContain('effect=commit');
  });
});
