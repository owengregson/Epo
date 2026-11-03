/**
 * The plan wiring: the durable read budget, sized from the live settings, and
 * the organic SessionPlanner hydrated from store meta.
 */

import type { SystemClock } from '@/governors/clock';
import { ReadBudget } from '@/governors/read-budget';
import { patternCircadianProfile } from '@/settings/pattern-map';
import { toReadAllowance } from '@/settings/read-allowance';
import { type Settings, toPacingConfig } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { samplePhaseOffset } from '@/timing/circadian';
import { CIRCADIAN } from '@/timing/config';
import { type PlannerSnapshot, SessionPlanner } from '@/timing/session-planner';
import { launchStream } from '@/utils/entropy';
import * as logger from '@/utils/logger';
import type { GraphBuildDeps, WiringParts } from './graph-types';

/** The durable read budget; its limits re-derive from the live settings on every read. */
export function wireReadBudget(
  store: KnowledgeStore,
  clock: SystemClock,
  d: Pick<GraphBuildDeps, 'resolveSettings'>,
): ReadBudget {
  return new ReadBudget({ store, clock, limits: () => toReadAllowance(d.resolveSettings()) });
}

/** The organic planner when the settings select it, else undefined (the legacy metronome). */
export function wirePacing(store: KnowledgeStore, settings: Settings): SessionPlanner | undefined {
  // Organic pacing model: a durable SessionPlanner hydrated from store meta,
  // injected ONLY when the user selected it (Settings.pacingModel). Absent →
  // the engine runs its legacy active-hours + operating-rate metronome. The
  // per-install circadian phase offset lives in the snapshot, so it is stable
  // across restarts and freshly drawn on first run.
  let pacingSnap: PlannerSnapshot | null = null;
  const pacingSnapRaw = store.getPacingState();
  if (pacingSnapRaw !== null) {
    try {
      pacingSnap = JSON.parse(pacingSnapRaw) as PlannerSnapshot;
    } catch (e) {
      logger.warn('foundation: bad pacing snapshot, starting fresh', { error: String(e) });
    }
  }
  const phaseOffset =
    pacingSnap?.phaseOffsetHours ??
    samplePhaseOffset(CIRCADIAN.PHASE_JITTER_MAX_HOURS, launchStream('main/plan-wiring'));
  const pacing =
    settings.pacingModel === 'organic'
      ? new SessionPlanner({
          // The circadian shape follows the user's qualitative day/week choice.
          profile: patternCircadianProfile(settings.pattern, phaseOffset),
          cfg: toPacingConfig(settings),
          snapshot: pacingSnap,
        })
      : undefined;
  return pacing;
}

/** The plan wiring's startup steps and status contributors (the plan streams fill them). */
export function planWiringParts(): WiringParts {
  return { startupSteps: [], statusContributors: [] };
}
