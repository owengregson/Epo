/**
 * The surface report (spec §10.7): the area view over the persisted drift and health rows, the status
 * summary the `surface` contributor pushes, and the surface gate both the click review and the plan mix read.
 * The view is recomputed only when the drift repo has written or the plan-day changed.
 */

import type { Clock } from '@/governors/clock';
import { driftConfirmThreshold } from '@/kernel/derive';
import type { PlanDayClock } from '@/kernel/plan';
import type { SurfaceGate, SurfaceSummary } from '@/shared/surface-health';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { type AreaView, createSurfaceGate, deriveAreas, summarize } from '@/surface/health-view';

export interface SurfaceReportDeps {
  store: KnowledgeStore;
  surfaceId: string;
  day: PlanDayClock;
  clock: Clock;
  /** Drifted pages, failure streak and clean reads that decide a state (default `driftConfirmThreshold()`). */
  threshold?: number;
}

export interface SurfaceReporter {
  /** Every area's state, from persisted rows only. */
  areas(): readonly AreaView[];
  summary(): SurfaceSummary;
  gate: SurfaceGate;
}

export function createSurfaceReport(d: SurfaceReportDeps): SurfaceReporter {
  const threshold = d.threshold ?? driftConfirmThreshold();
  let cached: { key: string; areas: readonly AreaView[] } | null = null;

  const areas = (): readonly AreaView[] => {
    const today = d.day.dayKey(d.clock.now());
    const key = `${d.store.surface.revision}|${today}`;
    if (cached?.key !== key) {
      const rows = d.store.surface.openSignatures(d.surfaceId);
      const health = d.store.surface.health(d.surfaceId, '');
      cached = { key, areas: deriveAreas(rows, health, today, threshold) };
    }
    return cached.areas;
  };

  return {
    areas,
    summary: () => summarize(areas(), d.store.surface.revision),
    gate: createSurfaceGate(areas),
  };
}
