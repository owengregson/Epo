/**
 * The list walk's decision table (spec §10.4) and L-WALK: an end is complete only on a verified
 * probe or, in an opaque cursor space, on the server's own false flags with no veto.
 */
import fc from 'fast-check';
import { decideStep, type StepDecision, type WalkCursorState } from '@/rim/list-walk-end';
import type { Continuation } from '@/surface/schema/projection';

const probe = (rows: number): string => `probe:${rows}`;
const next = (cursor: string, form: 'offset' | 'opaque' = 'offset'): Continuation => ({ kind: 'next', cursor, form });
const FLAGS_FALSE: Continuation = { kind: 'end', evidence: 'flags-false' };
const NO_FLAGS: Continuation = { kind: 'end', evidence: 'no-flags' };
const VETOED: Continuation = { kind: 'end', evidence: 'flags-false', vetoKey: 'next_cursor' };
const at = (lastForm: WalkCursorState['lastForm'], probing = false): WalkCursorState => ({ lastForm, probing });

interface Row {
  name: string;
  continuation: Continuation;
  newRows: number;
  state: WalkCursorState;
  form: 'paged' | 'whole-list';
  want: StepDecision;
}

const ROWS: Row[] = [
  { name: 'a drifted page stops the walk (rows already streamed)', continuation: { kind: 'drift', reason: 'more-without-cursor', key: 'has_more' },
    newRows: 3, state: at('offset'), form: 'paged', want: { act: 'stop', reason: 'shape-mismatch', detail: 'more-without-cursor' } },
  { name: 'an incomplete stream stops the walk', continuation: { kind: 'drift', reason: 'incomplete-stream' },
    newRows: 0, state: at('none', true), form: 'paged', want: { act: 'stop', reason: 'shape-mismatch', detail: 'incomplete-stream' } },
  { name: 'a whole-list page probes once in the plain form, whatever it claims', continuation: next('50'),
    newRows: 40, state: at('none'), form: 'whole-list', want: { act: 'probe', cursor: 'probe:120', plainForm: true } },
  { name: 'a paged next continues with the server cursor', continuation: next('QVFE', 'opaque'),
    newRows: 12, state: at('offset'), form: 'paged', want: { act: 'continue', cursor: 'QVFE', form: 'opaque' } },
  { name: 'a paged end in an offset space is probed', continuation: FLAGS_FALSE,
    newRows: 7, state: at('offset'), form: 'paged', want: { act: 'probe', cursor: 'probe:120', plainForm: false } },
  { name: 'a paged end on the first page is probed', continuation: NO_FLAGS,
    newRows: 7, state: at('none'), form: 'paged', want: { act: 'probe', cursor: 'probe:120', plainForm: false } },
  { name: 'an opaque end on false flags, unvetoed, is complete on the server flags', continuation: FLAGS_FALSE,
    newRows: 7, state: at('opaque'), form: 'paged', want: { act: 'complete', endEvidence: 'server-flags' } },
  { name: 'an opaque end with a veto key stops', continuation: VETOED,
    newRows: 7, state: at('opaque'), form: 'paged', want: { act: 'stop', reason: 'shape-mismatch', detail: 'cursor-veto' } },
  { name: 'an opaque end without flags stops: no continuation evidence', continuation: NO_FLAGS,
    newRows: 7, state: at('opaque'), form: 'paged', want: { act: 'stop', reason: 'shape-mismatch', detail: 'no-continuation-evidence' } },
  { name: 'a probe page with nothing new completes', continuation: next('170'),
    newRows: 0, state: at('offset', true), form: 'paged', want: { act: 'complete', endEvidence: 'probe' } },
  { name: 'a probe page with new rows and a next continues from the server cursor', continuation: next('170'),
    newRows: 5, state: at('offset', true), form: 'paged', want: { act: 'continue', cursor: '170', form: 'offset' } },
  { name: 'a probe page with new rows and an end stops: never a second synthesized offset', continuation: FLAGS_FALSE,
    newRows: 5, state: at('offset', true), form: 'paged', want: { act: 'stop', reason: 'shape-mismatch', detail: 'end-claim-false' } },
  { name: 'a whole-list probe page with new rows stops', continuation: next('50'),
    newRows: 5, state: at('none', true), form: 'whole-list', want: { act: 'stop', reason: 'shape-mismatch', detail: 'end-claim-false' } },
];

describe('decideStep: the decision table', () => {
  test.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, r) => {
    expect(decideStep({ continuation: r.continuation, newRows: r.newRows }, r.state, r.form, 120, probe)).toEqual(r.want);
  });
});

const continuationArb: fc.Arbitrary<Continuation> = fc.oneof(
  fc.record({ kind: fc.constant('next' as const), cursor: fc.string({ minLength: 1 }), form: fc.constantFrom('offset' as const, 'opaque' as const) }),
  fc.record({ kind: fc.constant('end' as const), evidence: fc.constantFrom('flags-false' as const, 'no-flags' as const) },
    { requiredKeys: ['kind', 'evidence'] }),
  fc.record({ kind: fc.constant('end' as const), evidence: fc.constant('flags-false' as const), vetoKey: fc.string({ minLength: 1 }) }),
  fc.record({ kind: fc.constant('drift' as const), reason: fc.constantFrom('more-without-cursor' as const, 'incomplete-stream' as const) }),
);
const caseArb = fc.record({
  continuation: continuationArb,
  newRows: fc.nat({ max: 60 }),
  state: fc.record({ lastForm: fc.constantFrom('none' as const, 'offset' as const, 'opaque' as const), probing: fc.boolean() }),
  form: fc.constantFrom('paged' as const, 'whole-list' as const),
  rows: fc.nat({ max: 10_000 }),
});
interface Case {
  continuation: Continuation;
  newRows: number;
  state: WalkCursorState;
  form: 'paged' | 'whole-list';
  rows: number;
}
const decide = (c: Case): StepDecision =>
  decideStep({ continuation: c.continuation, newRows: c.newRows }, c.state, c.form, c.rows, probe);

describe('L-WALK', () => {
  const RUNS = { numRuns: 500, seed: 20261102 };

  test('a drifted page always stops', () => {
    fc.assert(fc.property(caseArb, (c) => c.continuation.kind !== 'drift' || decide(c).act === 'stop'), RUNS);
  });

  test('complete only on a verified probe, or on false flags, unvetoed, in an opaque paged space', () => {
    fc.assert(fc.property(caseArb, (c) => {
      const d = decide(c);
      if (d.act !== 'complete') return true;
      if (d.endEvidence === 'probe') return c.state.probing && c.newRows === 0;
      const end = c.continuation;
      return !c.state.probing && c.form === 'paged' && c.state.lastForm === 'opaque'
        && end.kind === 'end' && end.evidence === 'flags-false' && end.vetoKey === undefined;
    }), RUNS);
  });

  test('never a second synthesized offset, and never one in an opaque space', () => {
    fc.assert(fc.property(caseArb, (c) => {
      const d = decide(c);
      if (d.act !== 'probe') return true;
      return !c.state.probing && (c.form === 'whole-list' || c.state.lastForm !== 'opaque') && d.cursor === probe(c.rows);
    }), RUNS);
  });

  test('a continue always follows the server cursor, and never on a whole-list page outside a probe', () => {
    fc.assert(fc.property(caseArb, (c) => {
      const d = decide(c);
      if (d.act !== 'continue') return true;
      return c.continuation.kind === 'next' && d.cursor === c.continuation.cursor && c.form === 'paged';
    }), RUNS);
  });
});
