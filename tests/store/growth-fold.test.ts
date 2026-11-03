/**
 * The follower accounting fold (spec §9.10, ADR 0704): components, read-time residuals, placement
 * on plan-days, law L3 (conservation) and the upward-only outside charge.
 */
import fc from 'fast-check';
import { type FollowerChange, followerAccounting, outsideCharges } from '@/store/folds/growth';
import { arbEpoWrites, arbGrowthHistory, windowsCovering, windowsFrom } from '../kit/reopen';

const H = 3_600_000;
const DAY = 24 * H;
const days = windowsFrom([0, DAY, 2 * DAY, 3 * DAY]);
const change = (id: number, delta: 1 | -1, lo: number, hi: number): FollowerChange =>
  ({ id, accountPk: `p${id}`, delta, lo, hi, source: lo === hi ? 'feed' : 'list', foundAt: hi });
const header = (at: number, followers: number, following = 0) => ({ at, followers, following });

const net = (t: { gained: number; lost: number; residual: number }): number => t.gained - t.lost + t.residual;

test('a component links the windows a multi-window change spans; its residual is computed', () => {
  const headers = [header(H, 100), header(5 * H, 103), header(9 * H, 104), header(13 * H, 104)];
  const changes = [change(1, 1, 2 * H, 6 * H), change(2, 1, 10 * H, 10 * H)];
  const a = followerAccounting(headers, changes, days);
  expect(a.components).toEqual([
    { from: H, to: 9 * H, deltaHeader: 4, identified: 1, residual: 3 },
    { from: 9 * H, to: 13 * H, deltaHeader: 0, identified: 1, residual: -1 },
  ]);
});

test('placement: a point change lands on its plan-day; a change across a boundary stays unplaced', () => {
  const headers = [header(H, 10), header(DAY + 2 * H, 12)];
  const changes = [change(1, 1, 3 * H, 3 * H), change(2, 1, 20 * H, DAY + H)];
  const a = followerAccounting(headers, changes, days);
  expect(a.placed({ startsAt: 0, endsAt: DAY })).toEqual({ gained: 1, lost: 0, residual: 0 });
  expect(a.placed({ startsAt: DAY, endsAt: 2 * DAY })).toEqual({ gained: 0, lost: 0, residual: 0 });
  // The one component spans the boundary: its residual (0 here) and change 2 are unplaced.
  expect(a.unplaced({ from: 0, to: 2 * DAY })).toEqual({ gained: 1, lost: 0, residual: 0 });
});

test('a component inside one plan-day places its residual there', () => {
  const headers = [header(2 * H, 50), header(6 * H, 47)];
  const a = followerAccounting(headers, [change(1, -1, 3 * H, 3 * H)], days);
  expect(a.placed({ startsAt: 0, endsAt: DAY })).toEqual({ gained: 0, lost: 1, residual: -2 });
  expect(net(a.placed({ startsAt: 0, endsAt: DAY }))).toBe(-3);
});

test('a change ending after the last header holds its component open until the next header', () => {
  const headers = [header(H, 10), header(2 * H, 11)];
  const open = followerAccounting(headers, [change(1, 1, 1.5 * H, 3 * H)], days);
  expect(open.components[0].to).toBe(Number.POSITIVE_INFINITY);
  expect(open.placed({ startsAt: 0, endsAt: DAY })).toEqual({ gained: 1, lost: 0, residual: 0 });
  const closed = followerAccounting([...headers, header(4 * H, 11)], [change(1, 1, 1.5 * H, 3 * H)], days);
  expect(closed.placed({ startsAt: 0, endsAt: DAY })).toEqual({ gained: 1, lost: 0, residual: 0 });
  expect(closed.components).toEqual([{ from: H, to: 4 * H, deltaHeader: 1, identified: 1, residual: 0 }]);
});

test('seenSince counts the changes that began after the header', () => {
  const a = followerAccounting([header(5 * H, 10)], [change(1, 1, 6 * H, 6 * H), change(2, -1, 4 * H, 7 * H),
    change(3, -1, 8 * H, 9 * H)], days);
  expect(a.seenSince(5 * H)).toEqual({ gained: 1, lost: 1 });
});

test('law L3: placed over every plan-day plus unplaced equals F_last − F_first, each change once', () => {
  fc.assert(fc.property(arbGrowthHistory, ({ headers, changes, windowOf }) => {
    const a = followerAccounting(headers, changes, windowOf);
    const first = headers[0];
    const last = headers[headers.length - 1];
    const placed = windowsCovering(windowOf, first.at, last.at)
      .map((w) => net(a.placed(w))).reduce((x, y) => x + y, 0);
    expect(placed + net(a.unplaced({ from: first.at, to: last.at }))).toBe(last.followers - first.followers);
    // Every change is counted exactly once: placed in one day or unplaced, never both.
    let counted = 0;
    for (const c of changes) {
      const w = windowOf(c.lo);
      counted += (c.hi < w.endsAt ? 1 : 0);
    }
    const unplacedChanges = changes.length - counted;
    const u = a.unplaced({ from: first.at, to: last.at });
    expect(u.gained + u.lost).toBe(unplacedChanges);
  }), { numRuns: 300 });
});

test('law L3 holds regardless of the order the rows arrive in', () => {
  fc.assert(fc.property(arbGrowthHistory, ({ headers, changes, windowOf }) => {
    const a = followerAccounting(headers, changes, windowOf);
    const b = followerAccounting([...headers].reverse(), [...changes].reverse(), windowOf);
    expect(b.components).toEqual(a.components);
  }), { numRuns: 100 });
});

describe('the outside charge (increases only)', () => {
  const g = (at: number, following: number) => header(at, 0, following);

  test('an outside follow with no Epo writes is charged; a decrease never is', () => {
    expect(outsideCharges([g(0, 10), g(H, 11), g(2 * H, 9)], []).map((w) => w.charge)).toEqual([1, 0]);
  });

  test("Epo's own public follows and unfollows explain the header", () => {
    const writes = [{ at: H / 2, action: 'follow' as const, private: false },
      { at: H / 2 + 1, action: 'follow' as const, private: false }, { at: 1.5 * H, action: 'unfollow' as const, private: false }];
    expect(outsideCharges([g(0, 10), g(H, 12), g(2 * H, 11)], writes).map((w) => w.charge)).toEqual([0, 0]);
  });

  test('a later acceptance of an earlier Epo request is never charged', () => {
    const writes = [{ at: H / 2, action: 'follow' as const, private: true }];
    // The request does not move the header; its acceptance a day later does.
    expect(outsideCharges([g(0, 10), g(H, 10), g(DAY, 11)], writes).map((w) => w.charge)).toEqual([0, 0]);
  });

  test('withdrawing an outstanding request is not an outside follow', () => {
    const writes = [{ at: H / 2, action: 'follow' as const, private: true },
      { at: 1.5 * H, action: 'unfollow' as const, private: true }];
    expect(outsideCharges([g(0, 10), g(H, 10), g(2 * H, 10)], writes).map((w) => w.charge)).toEqual([0, 0]);
  });

  test('every charge is non-negative; with no Epo writes it is exactly the header increase', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 2, maxLength: 8 }),
      arbEpoWrites(0, 8 * H),
      (following, writes) => {
        const hs = following.map((f, i) => g(i * H, f));
        for (const w of outsideCharges(hs, writes)) expect(w.charge).toBeGreaterThanOrEqual(0);
        expect(outsideCharges(hs, []).map((w) => w.charge))
          .toEqual(following.slice(1).map((f, i) => Math.max(0, f - following[i])));
      }), { numRuns: 200 });
  });
});
