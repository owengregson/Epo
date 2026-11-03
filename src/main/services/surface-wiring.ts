/**
 * The surface wiring: the pure Reader, the passive relationship reconciler on
 * the tab's responses, and the always-on profile observer.
 */

import { Reader } from '@/adapter/reader';
import type { InstagramTab } from '@/adapter/tab';
import type { SystemClock } from '@/governors/clock';
import { ProfileObserver } from '@/rim/profile-observer';
import {
  installRelationshipReconciler,
  RelationshipReconciler,
} from '@/rim/relationship-reconciler';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { WiringParts } from './graph-types';

/** The readers one graph shares, and the disposers of the two passive taps. */
export interface SurfaceWiring {
  reader: Reader;
  relationshipReconcilerUnsub: () => void;
  profileObserver: ProfileObserver;
  profileInfoUnsub: () => void;
}

/** Build the Reader and install the reconciler and the profile observer on the tab. */
export function wireSurface(d: {
  tab: InstagramTab;
  store: KnowledgeStore;
  ownPk: string;
  clock: SystemClock;
}): SurfaceWiring {
  const { store, ownPk, clock } = d;
  const reader = new Reader();

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
  const profileInfoUnsub = profileObserver.start();
  return { reader, relationshipReconcilerUnsub, profileObserver, profileInfoUnsub };
}

/** The surface wiring's startup steps and status contributors (the parse-health stream fills them). */
export function surfaceWiringParts(): WiringParts {
  return { startupSteps: [], statusContributors: [] };
}
