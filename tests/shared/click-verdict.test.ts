/**
 * The protection predicate's verdicts as click verdicts (spec §7.4, §9.7 step 5): every
 * non-clear verdict consumes the work with its own click verdict; `clear` lets the review go on.
 */
import fc from 'fast-check';
import { CLICK_VERDICT_KINDS, type ProtectedBy as ClickProtectedBy, protectionClickVerdict } from '@/shared/click-verdict';
import type { ProtectedBy, ProtectionVerdict } from '@/shared/unfollow-protection';

const BY: readonly ProtectedBy[] = ['account', 'verified', 'bio-word', 'source'];

const verdictArb: fc.Arbitrary<ProtectionVerdict> = fc.oneof(
  fc.constant<ProtectionVerdict>({ kind: 'clear' }),
  fc.record({ kind: fc.constant('protected' as const), by: fc.constantFrom(...BY), match: fc.string() }),
  fc.record({ kind: fc.constant('unknown' as const), missing: fc.constantFrom('bio' as const, 'verified' as const) }),
  fc.record({ kind: fc.constant('paused' as const), state: fc.constantFrom('needs-review' as const, 'unavailable' as const) }),
);

test('one ProtectedBy: the click vocabulary is the predicate vocabulary', () => {
  const same: ClickProtectedBy[] = [...BY];
  expect(same).toEqual(BY);
});

test('clear lets the review go on; every other verdict maps onto its own click verdict', () => {
  expect(protectionClickVerdict({ kind: 'clear' })).toBeNull();
  expect(protectionClickVerdict({ kind: 'protected', by: 'bio-word', match: 'cafe' }))
    .toEqual({ kind: 'protected', by: 'bio-word', match: 'cafe' });
  expect(protectionClickVerdict({ kind: 'unknown', missing: 'bio' })).toEqual({ kind: 'protection-unknown', missing: 'bio' });
  expect(protectionClickVerdict({ kind: 'paused', state: 'needs-review' }))
    .toEqual({ kind: 'protection-paused', state: 'needs-review' });
});

test('the mapping is total and never yields proceed', () => {
  fc.assert(fc.property(verdictArb, (v) => {
    const c = protectionClickVerdict(v);
    if (v.kind === 'clear') return expect(c).toBeNull();
    expect(c).not.toBeNull();
    expect(CLICK_VERDICT_KINDS).toContain(c?.kind);
    expect(c?.kind).not.toBe('proceed');
  }), { numRuns: 200 });
});
