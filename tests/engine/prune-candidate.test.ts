/**
 * The per-candidate prune decision — the three rules a prune must never lose,
 * as ONE pure function shared by the standalone run loop and the woven feed.
 */

import fc from 'fast-check';

import { decidePruneCandidate, pruneRemainder } from '@/engine/prune-candidate';

const cand = { pk: 'c1', username: 'someone' };

describe('decidePruneCandidate', () => {
  test('an ordinary candidate is unfollowed, carrying its username', () => {
    expect(decidePruneCandidate({ candidate: cand, whitelist: [], followsUsNow: false })).toEqual({
      do: 'unfollow',
      pk: 'c1',
      username: 'someone',
    });
  });

  test('the whitelist is re-derived at CONSUMPTION time (an edit lands instantly)', () => {
    expect(
      decidePruneCandidate({ candidate: cand, whitelist: ['someone'], followsUsNow: false }),
    ).toEqual({ do: 'skip', pk: 'c1', reason: 'whitelisted' });
    // Case-insensitive, and a pk matches too — exactly the shared predicate.
    expect(
      decidePruneCandidate({ candidate: cand, whitelist: [' SOMEONE '], followsUsNow: false }),
    ).toEqual({ do: 'skip', pk: 'c1', reason: 'whitelisted' });
    expect(decidePruneCandidate({ candidate: cand, whitelist: ['C1'], followsUsNow: false })).toEqual(
      { do: 'skip', pk: 'c1', reason: 'whitelisted' },
    );
  });

  test('the live-graph guard wins over a stale census', () => {
    expect(decidePruneCandidate({ candidate: cand, whitelist: [], followsUsNow: true })).toEqual({
      do: 'skip',
      pk: 'c1',
      reason: 'followed-back',
    });
  });

  test('a stub row without a username is skipped, never guessed at', () => {
    expect(
      decidePruneCandidate({
        candidate: { pk: 'c1', username: null },
        whitelist: [],
        followsUsNow: false,
      }),
    ).toEqual({ do: 'skip', pk: 'c1', reason: 'no-username' });
  });

  test('precedence: whitelist, then the live graph, then the username', () => {
    expect(
      decidePruneCandidate({
        candidate: { pk: 'c1', username: null },
        whitelist: ['c1'],
        followsUsNow: true,
      }).do,
    ).toBe('skip');
    expect(
      decidePruneCandidate({ candidate: cand, whitelist: ['someone'], followsUsNow: true }),
    ).toEqual({ do: 'skip', pk: 'c1', reason: 'whitelisted' });
  });

  test('property: an unfollow is IMPOSSIBLE while any guard holds', () => {
    fc.assert(
      fc.property(
        fc.record({
          username: fc.option(fc.constantFrom('someone', 'other'), { nil: null }),
          whitelist: fc.subarray(['someone', 'other']),
          followsUsNow: fc.boolean(),
        }),
        ({ username, whitelist, followsUsNow }) => {
          const verdict = decidePruneCandidate({
            candidate: { pk: 'c1', username },
            whitelist,
            followsUsNow,
          });
          const guarded =
            whitelist.some((w) => w.toLowerCase() === (username ?? '').toLowerCase()) ||
            followsUsNow ||
            username === null;
          expect(verdict.do).toBe(guarded ? 'skip' : 'unfollow');
          // An unfollow can never be built without a handle.
          if (verdict.do === 'unfollow') expect(verdict.username).toBe(username);
        },
      ),
      { numRuns: 300 },
    );
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
