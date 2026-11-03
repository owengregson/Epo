/**
 * The live-data wiring: the activity relay, the feed and the resume target join
 * the graph here (the live-data stream fills it). It returns its startup steps
 * and status contributors like every other wiring module.
 */

import type { WiringParts } from './graph-types';

/** The live wiring's startup steps and status contributors (none yet). */
export function liveWiringParts(): WiringParts {
  return { startupSteps: [], statusContributors: [] };
}
