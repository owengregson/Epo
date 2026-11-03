/**
 * What the settings core reads from the plan core's kernel (spec §5.4, §5.10, §6.2): the effective gap at
 * pace 1, the day law and its maximum, the retry limit. One port, so the parameter catalog, the view and
 * the migration basis take these numbers from one place; main supplies the kernel-backed implementation.
 */

/** The reference gap shape and the cap the effective gap is solved for. */
export interface GapInputs {
  readonly hourlyCap: number;
  /** The reference shape's median and floor at time-scale 1, seconds. */
  readonly medianSeconds: number;
  readonly floorSeconds: number;
  /** The effective typical gap (an override, or the recommendation), seconds. */
  readonly typicalSeconds: number;
}

/** The plan core's numbers the settings core shows and bounds with. */
export interface PlanMath {
  /** The effective typical gap at pace 1: `3600 s · CEILING_HEADROOM / H / BEAT_MIN` (seconds). */
  gapTypicalSeconds(hourlyCap: number): number;
  /** The plan's gap floor at pace 1 (the reference floor time-scaled toward the typical gap), seconds. */
  gapMinimumSeconds(g: GapInputs): number;
  /** The most Epo does automatically in a day at a daily target. */
  automaticDayMax(operatingRate: number): number;
  /** The day law's 10th percentile, median and 90th percentile. */
  dayLaw(i: { readonly operatingRate: number; readonly dayVariationPct: number; readonly restDayPct: number }):
    { readonly low: number; readonly typical: number; readonly high: number };
  /** Attempts before an account is skipped. */
  retryLimit(): number;
}
