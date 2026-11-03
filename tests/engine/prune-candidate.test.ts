/**
 * The per-candidate prune decision — the rules a prune must never lose, as ONE pure function
 * shared by the standalone run loop, the woven feed and the prune-run mode rule (P5–P7, P10):
 * protection, the live-graph follows-us guard, the username requirement.
 */

import fc from 'fast-check';

import { annotateCandidate, decidePruneCandidate, pruneRemainder } from '@/engine/prune-candidate';
import type { ProtectionVerdict } from '@/shared/unfollow-protection';

const cand = { pk: 'c1', username: 'someone' };
const CLEAR: ProtectionVerdict = { kind: 'clear' };
const PROTECTED: ProtectionVerdict = { kind: 'protected', by: 'account', match: 'c1' };

const verdictArb: fc.Arbitrary<ProtectionVerdict> = fc.oneof(
  fc.constant(CLEAR),
  fc.constant(PROTECTED),
  fc.constant<ProtectionVerdict>({ kind: 'protected', by: 'bio-word', match: 'cafe' }),
  fc.constant<ProtectionVerdict>({ kind: 'unknown', missing: 'bio' }),
  fc.constant<ProtectionVerdict>({ kind: 'paused', state: 'needs-review' }),
);

describe('decidePruneCandidate', () => {
  test('a clear, non-following candidate with a handle is unfollowed', () => {
    expect(decidePruneCandidate({ candidate: cand, protection: CLEAR, followsUsNow: false })).toEqual({
      do: 'unfollow', pk: 'c1', username: 'someone',
    });
  });

  test('a protected candidate is skipped as protected, whatever the live graph says', () => {
    expect(decidePruneCandidate({ candidate: cand, protection: PROTECTED, followsUsNow: false }))
      .toEqual({ do: 'skip', pk: 'c1', reason: 'protected' });
    expect(decidePruneCandidate({ candidate: cand, protection: PROTECTED, followsUsNow: true }))
      .toEqual({ do: 'skip', pk: 'c1', reason: 'protected' });
  });

  test('a paused index stops the run instead of consuming the candidate', () => {
    expect(decidePruneCandidate({ candidate: cand, protection: { kind: 'paused', state: 'unavailable' }, followsUsNow: false }))
      .toEqual({ do: 'stop', pk: 'c1', reason: 'protection-paused' });
  });

  test('unknown at selection goes on to the click, which reads the fresh profile', () => {
    expect(decidePruneCandidate({ candidate: cand, protection: { kind: 'unknown', missing: 'bio' }, followsUsNow: false }).do)
      .toBe('unfollow');
  });

  test('the live graph says they follow us NOW: skipped, never unfollowed', () => {
    expect(decidePruneCandidate({ candidate: cand, protection: CLEAR, followsUsNow: true }))
      .toEqual({ do: 'skip', pk: 'c1', reason: 'followed-back' });
  });

  test('a stub row without a username is skipped, never guessed at', () => {
    expect(decidePruneCandidate({ candidate: { pk: 'c1', username: null }, protection: CLEAR, followsUsNow: false }))
      .toEqual({ do: 'skip', pk: 'c1', reason: 'no-username' });
  });

  test('property: an unfollow is IMPOSSIBLE while protection holds or any guard holds', () => {
    fc.assert(
      fc.property(
        fc.record({
          username: fc.option(fc.constantFrom('someone', 'other'), { nil: null }),
          protection: verdictArb,
          followsUsNow: fc.boolean(),
        }),
        ({ username, protection, followsUsNow }) => {
          const verdict = decidePruneCandidate({ candidate: { pk: 'c1', username }, protection, followsUsNow });
          const guarded = protection.kind === 'protected' || protection.kind === 'paused' || followsUsNow || username === null;
          expect(verdict.do === 'unfollow').toBe(!guarded);
          if (protection.kind === 'paused') expect(verdict.do).toBe('stop');
          if (verdict.do === 'unfollow') expect(verdict.username).toBe(username);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('annotateCandidate', () => {
  test('a row carries the rule that keeps it, and whether its bio could not be judged', () => {
    expect(annotateCandidate(cand, PROTECTED)).toEqual({ ...cand, protectedBy: 'account', bioUnread: false });
    expect(annotateCandidate(cand, { kind: 'unknown', missing: 'bio' })).toEqual({ ...cand, protectedBy: null, bioUnread: true });
    expect(annotateCandidate(cand, { kind: 'unknown', missing: 'verified' })).toEqual({ ...cand, protectedBy: null, bioUnread: false });
    expect(annotateCandidate(cand, CLEAR)).toEqual({ ...cand, protectedBy: null, bioUnread: false });
  });
});

describe('pruneRemainder', () => {
  test('every early exit hands the UNVISITED tail back as runnable', () => {
    expect(pruneRemainder(['a', 'b', 'c'], 1)).toEqual(['b', 'c']);
    expect(pruneRemainder(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
  });

  test('a fully drained run hands back nothing', () => {
    expect(pruneRemainder(['a', 'b'], 2)).toEqual([]);
    expect(pruneRemainder([], 0)).toEqual([]);
  });

  test('property: the remainder plus the consumed prefix is always the whole list', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.nat({ max: 20 }), (items, i) => {
        const index = Math.min(i, items.length);
        expect([...items.slice(0, index), ...pruneRemainder(items, index)]).toEqual(items);
      }),
      { numRuns: 200 },
    );
  });
});
