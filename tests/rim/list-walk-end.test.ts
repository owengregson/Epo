/**
 * Pins today's end-claim decisions of the list walk, extracted from
 * `list-page-walker.ts` as the pure `decideStep` (the walk tests run it live).
 */
import { decideStep, type StepDecision, type WalkEndState, type WalkPage } from '@/rim/list-walk-end';

const STOP = 3;
const probe = (rows: number): string => `probe:${rows}`;
const fresh: WalkEndState = { probing: false, stagnantPages: 0 };
const probing: WalkEndState = { probing: true, stagnantPages: 0 };

interface Row {
  name: string;
  page: WalkPage;
  state: WalkEndState;
  rows: number;
  want: StepDecision;
}

const ROWS: Row[] = [
  {
    name: 'probe page with nothing new verifies the end',
    page: { hasMore: false, cursor: null, newRows: 0 },
    state: probing,
    rows: 120,
    want: { act: 'complete' },
  },
  {
    name: 'probe page with nothing new verifies the end even when it claims more pages',
    page: { hasMore: true, cursor: '200', newRows: 0 },
    state: { probing: true, stagnantPages: 2 },
    rows: 120,
    want: { act: 'complete' },
  },
  {
    name: 'probe page with new rows and no cursor: claim was false, probe again at the new offset',
    page: { hasMore: false, cursor: null, newRows: 5 },
    state: probing,
    rows: 125,
    want: { act: 'probe', cursor: 'probe:125', stagnantPages: 0, claimWasFalse: true },
  },
  {
    name: 'probe page with new rows and a leftover cursor: claim was false, probe the leftover cursor',
    page: { hasMore: false, cursor: 'left', newRows: 5 },
    state: probing,
    rows: 125,
    want: { act: 'probe', cursor: 'left', stagnantPages: 0, claimWasFalse: true },
  },
  {
    name: 'probe page with new rows and more pages: claim was false, continue from its cursor',
    page: { hasMore: true, cursor: '150', newRows: 5 },
    state: { probing: true, stagnantPages: 2 },
    rows: 125,
    want: { act: 'continue', cursor: '150', stagnantPages: 0, claimWasFalse: true },
  },
  {
    name: 'end claim without a cursor probes the synthesized offset and resets the stagnant streak',
    page: { hasMore: false, cursor: null, newRows: 10 },
    state: { probing: false, stagnantPages: 1 },
    rows: 60,
    want: { act: 'probe', cursor: 'probe:60', stagnantPages: 0, claimWasFalse: false },
  },
  {
    name: 'end claim on a page with nothing new still probes (never counted stagnant)',
    page: { hasMore: false, cursor: null, newRows: 0 },
    state: { probing: false, stagnantPages: 2 },
    rows: 60,
    want: { act: 'probe', cursor: 'probe:60', stagnantPages: 0, claimWasFalse: false },
  },
  {
    name: 'a missing cursor is an end claim even when the more-flag is set',
    page: { hasMore: true, cursor: null, newRows: 4 },
    state: fresh,
    rows: 60,
    want: { act: 'probe', cursor: 'probe:60', stagnantPages: 0, claimWasFalse: false },
  },
  {
    name: 'a cleared more-flag with a cursor probes that leftover cursor',
    page: { hasMore: false, cursor: 'c1', newRows: 4 },
    state: fresh,
    rows: 60,
    want: { act: 'probe', cursor: 'c1', stagnantPages: 0, claimWasFalse: false },
  },
  {
    name: 'a page with new rows continues from the server cursor and resets the streak',
    page: { hasMore: true, cursor: 'c2', newRows: 10 },
    state: { probing: false, stagnantPages: 2 },
    rows: 60,
    want: { act: 'continue', cursor: 'c2', stagnantPages: 0, claimWasFalse: false },
  },
  {
    name: 'a duplicate-window page continues and counts toward the streak',
    page: { hasMore: true, cursor: 'c3', newRows: 0 },
    state: fresh,
    rows: 60,
    want: { act: 'continue', cursor: 'c3', stagnantPages: 1, claimWasFalse: false },
  },
  {
    name: 'one page short of the threshold still continues',
    page: { hasMore: true, cursor: 'c3', newRows: 0 },
    state: { probing: false, stagnantPages: STOP - 2 },
    rows: 60,
    want: { act: 'continue', cursor: 'c3', stagnantPages: STOP - 1, claimWasFalse: false },
  },
  {
    name: 'the page that reaches the threshold stops the walk as stagnant',
    page: { hasMore: true, cursor: 'c3', newRows: 0 },
    state: { probing: false, stagnantPages: STOP - 1 },
    rows: 60,
    want: { act: 'stop', reason: 'stagnant', cursor: 'c3', stagnantPages: STOP, claimWasFalse: false },
  },
];

describe("decideStep: today's end-claim decisions", () => {
  test.each(ROWS)('$name', ({ page, state, rows, want }) => {
    expect(decideStep(page, state, rows, probe, STOP)).toEqual(want);
  });

  test('a handed-back cursor is probed as is; the offset probe is never built', () => {
    const built: number[] = [];
    const spy = (rows: number): string => {
      built.push(rows);
      return probe(rows);
    };
    decideStep({ hasMore: false, cursor: 'left', newRows: 4 }, fresh, 80, spy, STOP);
    decideStep({ hasMore: true, cursor: 'next', newRows: 0 }, fresh, 80, spy, STOP);
    decideStep({ hasMore: true, cursor: null, newRows: 0 }, probing, 80, spy, STOP);
    expect(built).toEqual([]);
  });

  test('a run of duplicate windows stops on exactly the threshold page', () => {
    let state: WalkEndState = fresh;
    const acts: string[] = [];
    for (let i = 0; i < STOP; i++) {
      const step = decideStep({ hasMore: true, cursor: 'same', newRows: 0 }, state, 50, probe, STOP);
      acts.push(step.act);
      if (step.act !== 'complete') state = { probing: false, stagnantPages: step.stagnantPages };
    }
    expect(acts).toEqual([...Array<string>(STOP - 1).fill('continue'), 'stop']);
  });
});
