/**
 * The follower accounting (ADR 0704, spec §9.10), pure: header windows `(t_{i−1}, t_i]`, components
 * linked by multi-window changes, read-time residuals, plan-day placement (law L3: conservation).
 */

export type ChangeSource = 'feed' | 'accept' | 'head-walk' | 'census' | 'visit' | 'list' | 'migrated';

/** One transition of an own-follower edge, dated by the interval `[lo, hi]` it is known to fall in. */
export interface FollowerChange {
  readonly id: number;
  readonly accountPk: string;
  readonly delta: 1 | -1;
  readonly lo: number;
  readonly hi: number;
  readonly source: ChangeSource;
  readonly foundAt: number;
}

/** One own-header observation: the counts Instagram showed at `at`. */
export interface OwnHeader { readonly at: number; readonly followers: number; readonly following: number }

export interface DayWindow { readonly startsAt: number; readonly endsAt: number }
/** The plan-day containing `t` (the `PlanDayClock` window, passed in). */
export type WindowOf = (t: number) => DayWindow;

export interface Tally { readonly gained: number; readonly lost: number; readonly residual: number }

export interface Component {
  readonly from: number;
  readonly to: number;
  readonly deltaHeader: number;
  readonly identified: number;
  readonly residual: number;
}

export interface FollowerAccounting {
  readonly components: readonly Component[];
  placed(window: DayWindow): Tally;
  /** Changes and residuals ending in `(from, to]` that no single plan-day holds. */
  unplaced(span: { readonly from: number; readonly to: number }): Tally;
  /** Changes that began at or after `headerAt` (not yet in that header's count). */
  seenSince(headerAt: number): { readonly gained: number; readonly lost: number };
}

/** The window index of `t`: 0 at or before the first header, n + 1 after the last. */
function indexOf(times: readonly number[], t: number): number {
  if (t <= times[0]) return 0;
  const last = times.length - 1;
  if (t > times[last]) return last + 1;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid;
    else hi = mid;
  }
  return hi;
}

function sumTally(items: readonly { readonly delta: number; readonly residual?: boolean }[]): Tally {
  let gained = 0;
  let lost = 0;
  let residual = 0;
  for (const i of items) {
    if (i.residual === true) residual += i.delta;
    else if (i.delta > 0) gained += i.delta;
    else lost -= i.delta;
  }
  return { gained, lost, residual };
}

/**
 * A change ending after the last header links its windows to the open end: that component waits
 * for the next header (`to = Infinity`, never placed). A change starting before the first header links from it.
 */
function componentsOf(headers: readonly OwnHeader[], changes: readonly FollowerChange[]): Component[] {
  const times = headers.map((h) => h.at);
  const n = times.length - 1;
  if (n < 1) return [];
  const linked = new Array<boolean>(n + 1).fill(false);
  const identified = new Array<number>(n + 1).fill(0);
  let openFrom = n + 1;
  for (const c of changes) {
    const ih = indexOf(times, c.hi);
    const il = Math.max(1, indexOf(times, c.lo));
    if (ih < 1 || il > n) continue;
    if (ih > n) openFrom = Math.min(openFrom, il);
    else identified[ih] += c.delta;
    for (let i = il; i < Math.min(ih, n); i++) linked[i] = true;
  }
  for (let i = openFrom; i < n; i++) linked[i] = true;
  const out: Component[] = [];
  let start = 1;
  let found = 0;
  for (let i = 1; i <= n; i++) {
    found += identified[i];
    if (i < n && linked[i]) continue;
    const deltaHeader = headers[i].followers - headers[start - 1].followers;
    const to = i === n && openFrom <= n ? Number.POSITIVE_INFINITY : times[i];
    out.push({ from: times[start - 1], to, deltaHeader, identified: found, residual: deltaHeader - found });
    start = i + 1;
    found = 0;
  }
  return out;
}

/** The accounting over the given rows; the plan-day function decides what one day holds. */
export function followerAccounting(
  headerRows: readonly OwnHeader[],
  changes: readonly FollowerChange[],
  windowOf: WindowOf,
): FollowerAccounting {
  const headers = [...headerRows].sort((a, b) => a.at - b.at);
  const components = componentsOf(headers, changes);
  const inDay = (lo: number, hi: number): boolean => hi < windowOf(lo).endsAt;
  return {
    components,
    placed: (w) => sumTally([
      ...changes.filter((c) => c.lo >= w.startsAt && c.hi < w.endsAt),
      ...components.filter((c) => c.from >= w.startsAt && c.to < w.endsAt)
        .map((c) => ({ delta: c.residual, residual: true })),
    ]),
    unplaced: (s) => sumTally([
      ...changes.filter((c) => c.hi > s.from && c.hi <= s.to && !inDay(c.lo, c.hi)),
      ...components.filter((c) => c.to > s.from && c.to <= s.to && !inDay(c.from, c.to))
        .map((c) => ({ delta: c.residual, residual: true })),
    ]),
    seenSince: (at) => {
      const t = sumTally(changes.filter((c) => c.lo >= at));
      return { gained: t.gained, lost: t.lost };
    },
  };
}

/** One of Epo's writes that landed: a follow (a request when the account is private) or an unfollow. */
export interface EpoWrite { readonly at: number; readonly action: 'follow' | 'unfollow'; readonly private: boolean }

export interface OutsideWindow { readonly from: number; readonly to: number; readonly charge: number }

/**
 * Outside following changes per header window, `max(0, ΔG − epoNet − resolved)`: Epo's requests stay
 * outstanding until an increase absorbs them (an acceptance) or Epo withdraws one; decreases never charge.
 */
export function outsideCharges(headerRows: readonly OwnHeader[], writeRows: readonly EpoWrite[]): OutsideWindow[] {
  const headers = [...headerRows].sort((a, b) => a.at - b.at);
  const writes = [...writeRows].sort((a, b) => a.at - b.at);
  let outstanding = 0;
  let next = 0;
  const apply = (until: number): number => {
    let epoNet = 0;
    for (; next < writes.length && writes[next].at <= until; next++) {
      const w = writes[next];
      if (w.action === 'follow') {
        if (w.private) outstanding += 1;
        else epoNet += 1;
      } else if (w.private && outstanding > 0) outstanding -= 1;
      else epoNet -= 1;
    }
    return epoNet;
  };
  if (headers.length === 0) return [];
  apply(headers[0].at);
  const out: OutsideWindow[] = [];
  for (let i = 1; i < headers.length; i++) {
    const excess = headers[i].following - headers[i - 1].following - apply(headers[i].at);
    const resolved = Math.min(Math.max(0, excess), outstanding);
    outstanding -= resolved;
    out.push({ from: headers[i - 1].at, to: headers[i].at, charge: Math.max(0, excess - resolved) });
  }
  return out;
}
