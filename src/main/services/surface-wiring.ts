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
import type { KnowledgeStore } from '@/store/knowledge-store';
import { surface } from '@/surface/index';
import { scrubSample } from '@/surface/lab/sample';
import type { WiringParts } from './graph-types';
import { createSurfaceHealthSink, type SurfaceHealthSink } from './surface-health-sink';

/** The readers one graph shares, the disposers of the two passive taps, and the surface sink. */
export interface SurfaceWiring {
  reader: Reader;
  relationshipReconcilerUnsub: () => void;
  profileObserver: ProfileObserver;
  /** Stops the profile tap, then flushes and closes the sink (the teardown runs it before the store closes). */
  profileInfoUnsub: () => void;
  /** The production sink: the read pipeline's reports land here (with its hint book and identity oracle). */
  sink: SurfaceHealthSink;
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
  const sink = createSurfaceHealthSink({ store, surfaceId: surface().id, day, clock, scrub: scrubSample });

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
  };
  return { reader, relationshipReconcilerUnsub, profileObserver, profileInfoUnsub, sink };
}

/** The surface wiring's startup steps and status contributors (the parse-health stream fills them). */
export function surfaceWiringParts(): WiringParts {
  return { startupSteps: [], statusContributors: [] };
}
