import fc from 'fast-check';
import { absurd } from '@/kernel/absurd';
import {
  broken,
  EFFECT,
  effectOf,
  failed,
  interrupted,
  isOk,
  mapOk,
  type Outcome,
  type OutcomeTag,
  ok,
  type RecordEffect,
  reasonKey,
  refused,
} from '@/kernel/outcome';
import { seconds } from '@/kernel/units';

/** Every shape the algebra can take, as an arbitrary. */
const anOutcome: fc.Arbitrary<Outcome<number>> = fc.oneof(
  fc.nat().map((n) => ok(n)),
  fc.record({ status: fc.integer({ min: 400, max: 599 }), definitive: fc.boolean() }).map(({ status, definitive }) =>
    refused({ kind: 'rate-wall', httpStatus: status, detail: 'wall' }, definitive),
  ),
  fc.string().map((text) => refused({ kind: 'interstitial', matchedText: text }, false)),
  fc
    .constantFrom('action-blocked' as const, 'challenge' as const, 'logged-out' as const)
    .map((status) => refused({ kind: 'auth', status }, true)),
  fc.boolean().map((landed) => broken({ kind: 'tab-gone' }, landed)),
  fc
    .record({ component: fc.string(), landed: fc.boolean() })
    .map(({ component, landed }) =>
      broken({ kind: 'tab-unresponsive', component, timeoutMs: seconds(8) }, landed),
    ),
  fc.string().map((selector) => failed({ kind: 'drift', selector })),
  fc.string().map((expected) => failed({ kind: 'unverified', expected })),
  fc.constant(interrupted()),
);

const EFFECTS: readonly RecordEffect[] = ['transition', 'untouched', 'burn-retry'];
const TAGS: readonly OutcomeTag[] = ['Ok', 'Refused', 'Broken', 'Failed', 'Interrupted'];

describe('kernel/outcome', () => {
  it('the EFFECT table covers exactly the five tags', () => {
    expect(Object.keys(EFFECT).sort()).toEqual([...TAGS].sort());
  });

  it('pins the law each variant encodes', () => {
    expect(EFFECT.Ok).toBe('transition');
    expect(EFFECT.Refused).toBe('untouched');
    expect(EFFECT.Broken).toBe('untouched');
    expect(EFFECT.Failed).toBe('burn-retry');
    expect(EFFECT.Interrupted).toBe('untouched');
  });

  it('effectOf is total: every outcome maps to a record effect', () => {
    fc.assert(
      fc.property(anOutcome, (o) => {
        expect(EFFECTS).toContain(effectOf(o));
        expect(effectOf(o)).toBe(EFFECT[o._tag]);
      }),
    );
  });

  it('only Ok transitions the record', () => {
    fc.assert(
      fc.property(anOutcome, (o) => {
        expect(effectOf(o) === 'transition').toBe(isOk(o));
      }),
    );
  });

  it('reasonKey is total, non-empty and stable', () => {
    fc.assert(
      fc.property(anOutcome, (o) => {
        const key = reasonKey(o);
        expect(key.length).toBeGreaterThan(0);
        expect(reasonKey(o)).toBe(key);
      }),
    );
    expect(reasonKey(interrupted())).toBe('interrupted');
    expect(reasonKey(refused({ kind: 'auth', status: 'challenge' }, true))).toBe('refused:auth:challenge');
    expect(reasonKey(broken({ kind: 'tab-gone' }, false))).toBe('broken:tab-gone');
    expect(reasonKey(failed({ kind: 'unverified', expected: 'Following' }))).toBe('failed:unverified');
  });

  it('mapOk transforms the payload and leaves every other variant identical', () => {
    fc.assert(
      fc.property(anOutcome, (o) => {
        const mapped = mapOk(o, (n) => n + 1);
        expect(mapped._tag).toBe(o._tag);
        if (o._tag === 'Ok' && mapped._tag === 'Ok') expect(mapped.value).toBe(o.value + 1);
        else expect(mapped).toBe(o);
      }),
    );
  });

  it('absurd is the exhaustiveness witness and throws if reached', () => {
    expect(() => absurd('unmapped' as never)).toThrow(/unreachable/);
  });
});
