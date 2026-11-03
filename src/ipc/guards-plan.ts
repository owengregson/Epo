/**
 * Boundary guards for the Boost rows (spec §15.1, ADR 1009): shape only — the
 * plan clamps the hours. Spread into `GUARDS`; imported by `guards.ts` only.
 */

import { z } from 'zod';

/** A Boost length in hours: any finite number (clamped by the plan, never refused for range). */
const HOURS = z.number().finite();
const BOOST_OPTS = z.object({ alsoStart: z.boolean() });

/** Checked against each row's argument tuple where `GUARDS` spreads them. */
export const PLAN_GUARDS = {
  startBoost: [HOURS, BOOST_OPTS] as const,
  previewBoost: [HOURS] as const,
};
