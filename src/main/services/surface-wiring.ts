/**
 * The surface wiring: the pure Reader, the passive relationship reconciler on
 * the tab's responses, the always-on profile observer, and the production
 * surface sink that persists drift and per-plan-day health.
 */

import { Reader } from '@/adapter/reader';
import type { InstagramTab } from '@/adapter/tab';
import type { SystemClock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { PlanDayClock } from '@/kernel/plan';
import { ProfileObserver } from '@/rim/profile-observer';
import {
  installRelationshipReconciler,
  RelationshipReconciler,
} from '@/rim/relationship-reconciler';
import type { SurfaceGate } from '@/shared/surface-gate';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { surface } from '@/surface/index';
import { scrubSample } from '@/surface/lab/sample';
import type { WiringParts } from './graph-types';
import { createSurfaceHealthSink, type SurfaceHealthSink } from './surface-health-sink';
import { createSurfaceReport, type SurfaceReporter } from './surface-report';

/** Each graph's report, by its store: the `surface` contributor receives the graph, never the wiring. */
const reporters = new WeakMap<KnowledgeStore, SurfaceReporter>();
/** The live graph's report, for the `surface:report` handler (cleared when that graph tears down). */
let live: SurfaceReporter | null = null;

/** The report of the graph that is live now, or null before a graph is built or after it tore down. */
export const liveSurfaceReporter = (): SurfaceReporter | null => live;

/**
 * The surface gate of the graph that owns `store`, resolved at each ask: a consumer built before
 * `wireSurface` in the same graph (the click review, the plan mix) takes this and reads the real gate.
 */
export const surfaceGateOf = (store: KnowledgeStore): SurfaceGate => ({
  paused: (activity) => reporters.get(store)?.gate.paused(activity) ?? false,
});

/** The readers one graph shares, the disposers of the two passive taps, and the surface sink. */
export interface SurfaceWiring {
  reader: Reader;
  relationshipReconcilerUnsub: () => void;
  profileObserver: ProfileObserver;
  /** Stops the profile tap, then flushes and closes the sink (the teardown runs it before the store closes). */
  profileInfoUnsub: () => void;
  /** The production sink: the read pipeline's reports land here (with its hint book and identity oracle). */
  sink: SurfaceHealthSink;
  /** Area states, the status summary and the surface gate, over the persisted rows. */
  report: SurfaceReporter;
  /** The real surface gate: the click review's step 0b and the plan mix read it (spec §10.6). */
  gate: SurfaceGate;
}

/** Build the Reader and the sink, and install the reconciler and the profile observer on the tab. */
export function wireSurface(d: {
  tab: InstagramTab;
  store: KnowledgeStore;
  ownPk: string;
  clock: SystemClock;
  /** The plan-day boundary (the plan-backed clock at the plan wiring's swap; local midnight until then). */
  day?: PlanDayClock;
}): SurfaceWiring {
  const { store, ownPk, clock } = d;
  const reader = new Reader();
  const day = d.day ?? calendarPlanDayClock({ now: () => clock.now() });
  const surfaceId = surface().id;
  const sink = createSurfaceHealthSink({ store, surfaceId, day, clock, scrub: scrubSample });
  const report = createSurfaceReport({ store, surfaceId, day, clock });
  reporters.set(store, report);
  live = report;

  // Heal external follow/unfollow drift from the SAME response pipeline: every
  // relationship-bearing body reconciles our own follow-status through the
  // store's leave-alone policy sink.
  const relationshipReconciler = new RelationshipReconciler({ store, ownPk, reader, clock });
  const relationshipReconcilerUnsub = installRelationshipReconciler(
    d.tab,
    relationshipReconciler,
  );

  // Always-on profile observer: ANY profile the tab loads (the startup landing
  // on our own page, dialog navigations, visits) is parsed once and stored —
  // our OWN header counts size the scan progress bars and back the census
  // coverage guard, and every other profile enriches candidate scoring. It is
  // also how a profile is READ since 2026-10-08: the visitor navigates and the
  // observer hands it the page's own profile body (no request is composed).
  const profileObserver = new ProfileObserver({ tab: d.tab, reader, store, clock });
  const stopObserver = profileObserver.start();
  const profileInfoUnsub = (): void => {
    stopObserver();
    sink.dispose();
    if (live === report) live = null;
  };
  return { reader, relationshipReconcilerUnsub, profileObserver, profileInfoUnsub, sink, report, gate: report.gate };
}

/** The surface wiring's status contributor: `status.surface` from the graph's persisted drift and health. */
export function surfaceWiringParts(): WiringParts {
  return {
    startupSteps: [],
    statusContributors: [{
      name: 'surface',
      contribute: (graph) => ({ surface: graph === null ? null : (reporters.get(graph.store)?.summary() ?? null) }),
    }],
  };
}
