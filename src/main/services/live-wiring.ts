/**
 * The live-data wiring (spec §12.9, §13): the feed and its expiry join each built graph's projections here, and
 * the resume target rides the status as a contributor. The activity relay and the log ring live for the process
 * and are built at launch. It returns its startup steps and status contributors like every other wiring module.
 */

import type { PruneStatus } from '@/engine/prune-engine';
import type { RecoveryIncident, RecoverySnapshot } from '@/engine/recovery';
import { peekResumeTarget, type ResumeFrontier } from '@/engine/resume-target';
import { SourceFrontier } from '@/engine/source-frontier';
import type { PlanDayClock } from '@/kernel/plan';
import { MS_PER_MINUTE } from '@/kernel/units';
import { type FeedContext, keepShapedAt, shapeFeed } from '@/main/modules/feed-projection';
import type { FeedView } from '@/shared/feed';
import type { StatusFields } from '@/shared/status-fields';
import type { KnowledgeStore } from '@/store/knowledge-store';
import * as logger from '@/utils/logger';
import type { BuiltGraph, StatusContributor, WiringParts } from './graph-types';

export interface LiveWiringDeps {
  /** The engine's own source frontier, so the resume target is the pick a start adopts (L-RESUME). */
  readonly frontier?: ResumeFrontier;
}

/** The live wiring's startup steps (none) and status contributors (the resume target). */
export function liveWiringParts(deps: LiveWiringDeps = {}): WiringParts {
  return { startupSteps: [], statusContributors: [resumeTargetContributor(deps)] };
}

/**
 * `status.resumeTarget` (spec §13, §15.3): the target a start resumes, from the same pure pick the pipeline adopts,
 * with no write. Without the engine's frontier it peeks through a read-only one over the graph's store, whose
 * multi-source ranking uses the exploration policy's outcome window rather than the configured follow-back wait.
 */
function resumeTargetContributor(deps: LiveWiringDeps): StatusContributor {
  let readOnly: { store: BuiltGraph['store']; frontier: ResumeFrontier } | null = null;
  let memo: { store: BuiltGraph['store']; key: string; minute: number; value: StatusFields['resumeTarget'] } | null = null;
  const frontierOf = (graph: BuiltGraph): ResumeFrontier => {
    if (deps.frontier !== undefined) return deps.frontier;
    if (readOnly?.store !== graph.store) {
      readOnly = { store: graph.store, frontier: new SourceFrontier({ store: graph.store, clock: graph.clock }) };
    }
    return readOnly.frontier;
  };
  return {
    name: 'resumeTarget',
    contribute: (graph, now) => {
      if (graph === null) return { resumeTarget: null };
      // Ranking sources reads every follow record; a pick holds while the frontier and targets hold, re-ranked each minute.
      const key = JSON.stringify([graph.store.getSourceFrontierState(), graph.store.listTargets()]);
      const minute = Math.floor(now / MS_PER_MINUTE);
      if (memo !== null && memo.store === graph.store && memo.key === key && memo.minute === minute) return { resumeTarget: memo.value };
      const pick = peekResumeTarget({ store: graph.store, frontier: frontierOf(graph) });
      const value = pick === null ? null : { pk: pick.pk, username: graph.store.getAccount(pick.pk)?.username ?? null };
      memo = { store: graph.store, key, minute, value };
      return { resumeTarget: value };
    },
  };
}

/** The runtime incident a deliberate quit records: the "Since you left" divider sits there. */
export const SHUTDOWN_INCIDENT = 'intentional-shutdown';

/** What the live sources read from a built graph. */
export interface LiveGraph {
  readonly store: Pick<KnowledgeStore, 'feed' | 'followersBaselineAt' | 'getRecoveryState' | 'getRecoveryLastIncident'>;
  readonly ownPk: string;
  readonly pruneEngine: { status(): Pick<PruneStatus, 'scanReady' | 'scanAt'> };
}

/** The runtime's durable incident tail (crash resumes, quits). */
export interface RuntimeIncidents {
  readonly incidents: readonly { readonly at: number; readonly reason: string }[];
}

/** The projection sources the live data adds: the feed and the instant a shown verdict next changes. */
export interface LiveSources {
  feed(): FeedView;
  expiresAt(): number | null;
}

/** When the cached census stops being runnable; one still runnable past that is re-checked at the next push. */
export function censusFreshEnd(prune: Pick<PruneStatus, 'scanReady' | 'scanAt'>, now: number, freshMs: number): number | null {
  if (!prune.scanReady || prune.scanAt === null) return null;
  return Math.max(prune.scanAt + freshMs, now) + 1;
}

function parseMeta<T>(raw: string | null, key: string): Partial<T> | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch (error) {
    logger.warn('live: unreadable recovery meta, the feed shows no slow-down for it', { key, error: String(error) });
    return null;
  }
}

/** The recovery ladder's open episode (until its hold ends), else its last closed one. */
function recoveryEpisode(stateRaw: string | null, lastRaw: string | null): FeedContext['recoveryIncident'] {
  const open = parseMeta<RecoverySnapshot>(stateRaw, 'recovery_state');
  if (open !== null && open.phase !== 'inactive' && typeof open.enteredAt === 'number') {
    return { at: open.enteredAt, resumeAt: typeof open.holdUntil === 'number' ? open.holdUntil : null };
  }
  const last = parseMeta<RecoveryIncident>(lastRaw, 'recovery_last_incident');
  return last !== null && typeof last.enteredAt === 'number' ? { at: last.enteredAt, resumeAt: null } : null;
}

/** The last deliberate quit, or null when Epo never closed on purpose. */
function lastShutdown(incidents: RuntimeIncidents['incidents']): number | null {
  let at: number | null = null;
  for (const i of incidents) if (i.reason === SHUTDOWN_INCIDENT && (at === null || i.at > at)) at = i.at;
  return at;
}

/**
 * The feed and expiry sources over one built graph: the feed keeps its previous view while only the clock moved
 * (so the deduplicated row stays quiet), and the expiry is the earlier of the plan-day roll and the census end.
 */
export function liveSources(
  graph: LiveGraph,
  runtime: () => RuntimeIncidents,
  /** The plan's plan-day boundary: the feed's day groups and its expiry roll there (spec §4.4); the plan's census freshness. */
  opts: { planDay: PlanDayClock; censusFreshMs: () => number; now?: () => number },
): LiveSources {
  const { planDay } = opts;
  const now = opts.now ?? (() => Date.now());
  let shown: FeedView | null = null;
  let episode: { key: string; value: FeedContext['recoveryIncident'] } | null = null;
  const recovery = (): FeedContext['recoveryIncident'] => {
    const stateRaw = graph.store.getRecoveryState();
    const lastRaw = graph.store.getRecoveryLastIncident();
    const key = JSON.stringify([stateRaw, lastRaw]);
    if (episode?.key !== key) episode = { key, value: recoveryEpisode(stateRaw, lastRaw) };
    return episode.value;
  };
  return {
    feed: () => {
      const { incidents } = runtime();
      shown = keepShapedAt(shown, shapeFeed(graph.store.feed, {
        now: now(), ownPk: graph.ownPk, baselineAt: graph.store.followersBaselineAt(), planDay, incidents,
        recoveryIncident: recovery(), awayFrom: lastShutdown(incidents),
      }));
      return shown;
    },
    expiresAt: () => {
      const t = now();
      const roll = planDay.window(t).endsAt;
      const census = censusFreshEnd(graph.pruneEngine.status(), t, opts.censusFreshMs());
      return census === null ? roll : Math.min(roll, census);
    },
  };
}
