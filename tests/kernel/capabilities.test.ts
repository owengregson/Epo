import fc from 'fast-check';
import { pk } from '@/kernel/brand';
import { AlreadyConsumedError, budgetToken, once, tabCap, unfollowPermit, verifiedWalk } from '@/kernel/capabilities';
import { ms, seconds } from '@/kernel/units';

describe('kernel/capabilities', () => {
  it('mints proofs that carry the evidence their holder needs', () => {
    expect(tabCap('prune', 3)).toEqual({ owner: 'prune', generation: 3 });
    expect(budgetToken('follow', ms(1_000))).toEqual({ kind: 'follow', authorisedAt: 1_000 });
    expect(verifiedWalk('followers', ms(2_000))).toEqual({ of: 'followers', endedAt: 2_000 });
  });

  it('an unfollow permit cannot be minted while the subject follows us back', () => {
    const subject = pk('900');
    expect(unfollowPermit(subject, seconds(1), { theyFollowUs: true })).toBeNull();
    expect(unfollowPermit(subject, seconds(1), { theyFollowUs: false })).toEqual({
      subject: '900',
      issuedAt: 1_000,
    });
  });

  it('a single-use token is consumable exactly once, however many callers try', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 25 }), (calls) => {
        const take = once(budgetToken('unfollow', ms(0)), 'budget');
        let succeeded = 0;
        let threw = 0;
        for (let i = 0; i < calls; i += 1) {
          try {
            take();
            succeeded += 1;
          } catch (e) {
            expect(e).toBeInstanceOf(AlreadyConsumedError);
            threw += 1;
          }
        }
        expect(succeeded).toBe(1);
        expect(threw).toBe(calls - 1);
      }),
    );
  });

  it('names the capability in the error, so a span reason is readable', () => {
    const take = once('tab', 'tab-cap');
    expect(take()).toBe('tab');
    expect(() => take()).toThrow(/tab-cap was already consumed/);
  });
});
