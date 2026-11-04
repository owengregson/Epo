/**
 * The followers-head step (spec §9.5, law L10): composed list pages from the head of our own followers
 * down to the frontier run, at most the page bound. Every row is written as it parses with the
 * conservative interval; once the frontier is found, gains above it narrow by list position between
 * exact-dated neighbours, and only when the order self-check says newest-first. A head walk never
 * removes an edge.
 */

import type { Sentinel } from '@/adapter/sentinel';
import type { Observation } from '@/adapter/surface-types';
import { frontierRun, measuredRowsPerPage, orderVerdict } from '@/kernel/derive-reentry';
import type { ListPageWalker } from '@/rim/list-page-walker';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { HeadFrontier } from '@/store/repos/reopen-state';
import * as logger from '@/utils/logger';

export type { HeadFrontier };

/** The narrow store port the walk reads and writes. */
export interface HeadFacts {
  /** An active follower whose latest gain ends at or before `t` (or, with no gain row, first seen by then). */
  wasFollowerAt(pk: string, t: number): boolean;
  isActiveFollower(pk: string): boolean;
  /** The latest gain's time when it is exact (`lo = hi`), else null. */
  exactFollowAt(pk: string): number | null;
  /** Write the row's membership; a new follower's gain row carries `dating` and its id comes back. */
  observeMembership(obs: Observation, dating: { lo: number; hi: number; source: 'head-walk' }): number | null;
  /** Tighten a gain row's interval (only ever tightens). */
  narrow(changeId: number, lo: number, hi: number): void;
}

/** The store as the walk's port: membership through the edge, dating through the change log. */
export function storeHeadFacts(store: Pick<KnowledgeStore, 'getEdge' | 'observe' | 'observeEdge' | 'growth'>,
  ownPk: string): HeadFacts {
  const active = (pk: string): boolean => store.getEdge(pk, ownPk, 'follows')?.status === 'active';
  return {
    wasFollowerAt: (pk, t) => {
      const edge = store.getEdge(pk, ownPk, 'follows');
      if (edge?.status !== 'active') return false;
      const gain = store.growth.latestGain(pk);
      return gain !== null ? gain.hi <= t : edge.firstSeenAt <= t;
    },
    isActiveFollower: active,
    exactFollowAt: (pk) => {
      const gain = store.growth.latestGain(pk);
      return gain !== null && gain.lo === gain.hi ? gain.hi : null;
    },
    observeMembership: (obs) => {
      const was = active(obs.accountPk);
      store.observe(obs);
      // The store dates a new follower from the later of its last removal and the census floor.
      store.observeEdge(obs.accountPk, ownPk, 'follows', true, obs.observedAt, { source: 'head-walk' });
      return !was && active(obs.accountPk) ? store.growth.latestGain(obs.accountPk)?.id ?? null : null;
    },
    narrow: (id, lo, hi) => store.growth.narrow(id, lo, hi),
  };
}

export interface HeadWalkArgs {
  readonly ownPk: string;
  /** The frontier time; null before the first walk (the upgrade launch): one page initializes it. */
  readonly frontierAt: number | null;
  /** The earliest a never-seen follower can have arrived (the last complete census, else the baseline). */
  readonly floor: number;
  readonly maxPages: number;
  readonly use: 'catch-up' | 'check';
  readonly prior: HeadFrontier | null;
  readonly signal: AbortSignal;
}

export type HeadWalkOutcome = 'reached-frontier' | 'gap' | 'initialized' | 'read-budget' | 'shape-mismatch'
  | 'fetch-failed' | `sentinel:${string}` | 'stopped';

export interface HeadWalkResult {
  readonly outcome: HeadWalkOutcome;
  readonly pages: number;
  readonly newRows: number;
  /** The next frontier, or null when the walk failed (the old one is kept). */
  readonly next: HeadFrontier | null;
  readonly retryAt?: number;
}

export interface HeadWalkDeps {
  readonly walker: Pick<ListPageWalker, 'walkAll'>;
  readonly facts: HeadFacts;
  readonly clock: { now(): number };
  readonly sentinel: Sentinel;
}

interface Row { readonly pk: string; readonly change: number | null; readonly exact: number | null; readonly lo: number; readonly hi: number }

/** The order self-check over consecutive exact-dated rows: newest-first means each is no older than the next. */
function orderPairs(rows: readonly Row[]): { pairs: number; ordered: number } {
  const dated = rows.filter((r) => r.exact !== null).map((r) => r.exact as number);
  let ordered = 0;
  for (let i = 1; i < dated.length; i++) if (dated[i - 1] >= dated[i]) ordered += 1;
  return { pairs: Math.max(0, dated.length - 1), ordered };
}

/** Narrow every new gain above the frontier between the nearest exact-dated rows on either side. */
function narrowAbove(rows: readonly Row[], frontierIdx: number, facts: HeadFacts): void {
  for (let i = 0; i < frontierIdx; i++) {
    const change = rows[i].change;
    if (change === null) continue;
    let newer: number | null = null;
    for (let j = i - 1; j >= 0 && newer === null; j--) newer = rows[j].exact;
    let older: number | null = null;
    for (let j = i + 1; j < rows.length && older === null; j++) older = rows[j].exact;
    if (newer !== null || older !== null) facts.narrow(change, older ?? rows[i].lo, newer ?? rows[i].hi);
  }
}

const FAILURES: ReadonlySet<string> = new Set(['read-budget', 'shape-mismatch', 'fetch-failed']);

/** Walk the head of our followers down to the frontier (or one page to initialize it). */
export async function walkFollowersHead(d: HeadWalkDeps, a: HeadWalkArgs): Promise<HeadWalkResult> {
  const rows: Row[] = [];
  const pageSizes: number[] = [];
  const initializing = a.frontierAt === null;
  let run = 0;
  let frontierIdx: number | null = null;
  const walk = await d.walker.walkAll({
    pk: a.ownPk, which: 'followers', sentinel: d.sentinel, readUse: a.use,
    maxPages: initializing ? 1 : a.maxPages,
    shouldStop: () => a.signal.aborted,
    // Pre-frontier rows are the caller's known ones, so a backlog of feed-identified rows never trips the stop.
    isKnown: (pk) => a.frontierAt !== null && d.facts.wasFollowerAt(pk, a.frontierAt),
    onObservation: (obs) => {
      const pre = a.frontierAt !== null && d.facts.wasFollowerAt(obs.accountPk, a.frontierAt);
      const change = d.facts.observeMembership(obs, { lo: a.floor, hi: obs.observedAt, source: 'head-walk' });
      rows.push({ pk: obs.accountPk, change, exact: d.facts.exactFollowAt(obs.accountPk), lo: a.floor, hi: obs.observedAt });
      run = pre ? run + 1 : 0;
      if (frontierIdx === null && run >= frontierRun()) frontierIdx = rows.length - run;
    },
    stopAfterPage: (page) => {
      pageSizes.push(page.length);
      return frontierIdx !== null;
    },
  });
  const newRows = rows.filter((r) => r.change !== null).length;
  const typed = FAILURES.has(walk.reason) || walk.reason.startsWith('sentinel:');
  // A walk that read no page proves nothing about the head: never a frontier (never fabricate).
  if (typed || walk.reason === 'stop-requested' || walk.pages === 0) {
    const outcome = walk.reason === 'stop-requested' ? 'stopped' : typed ? walk.reason as HeadWalkOutcome : 'fetch-failed';
    logger.info('rim.followers-head: walk ended early, facts kept', { outcome, pages: walk.pages, newRows });
    return { outcome, pages: walk.pages, newRows, next: null, ...(walk.retryAt === undefined ? {} : { retryAt: walk.retryAt }) };
  }
  const ended = walk.reason === 'no-more-pages';
  const reachedFrontier = frontierIdx !== null || ended;
  const order = orderPairs(rows);
  const prior = a.prior?.order ?? { verdict: 'unverified' as const, pairs: 0, ordered: 0, at: 0 };
  const pairs = prior.pairs + order.pairs;
  const ordered = prior.ordered + order.ordered;
  const verdict = orderVerdict(pairs, ordered, prior.verdict);
  if (!initializing && reachedFrontier && verdict === 'newest-first') narrowAbove(rows, frontierIdx ?? rows.length, d.facts);
  const full = ended ? pageSizes.slice(0, -1) : pageSizes;
  const at = d.clock.now();
  const next: HeadFrontier = {
    walkedAt: at,
    rowsPerPage: measuredRowsPerPage({ rows: full.reduce((s, n) => s + n, 0), fullPages: full.length },
      a.prior?.rowsPerPage ?? null),
    order: { verdict, pairs, ordered, at },
    contiguous: initializing || reachedFrontier,
  };
  const outcome = initializing ? 'initialized' : reachedFrontier ? 'reached-frontier' : 'gap';
  logger.info('rim.followers-head: walk done', { outcome, pages: walk.pages, newRows, verdict });
  return { outcome, pages: walk.pages, newRows, next };
}
